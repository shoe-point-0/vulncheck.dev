package vulndb

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"sort"
	"strings"
	"time"
)

// BuildArchive creates one deterministic, signed offline release. Every input
// record is parsed as OSV and stored byte-for-byte as the canonical authority.
func BuildArchive(rawRecords [][]byte, options BuildOptions) ([]byte, Manifest, error) {
	if err := validateBuildOptions(options); err != nil {
		return nil, Manifest{}, err
	}
	if len(rawRecords) == 0 || len(rawRecords) > maxRecords {
		return nil, Manifest{}, dataError("vulndb-record-count-invalid", "offline vulnerability release has an invalid record count")
	}

	records := make([]Record, 0, len(rawRecords))
	seen := make(map[string]struct{}, len(rawRecords))
	for _, raw := range rawRecords {
		record, err := ParseRecord(raw)
		if err != nil {
			return nil, Manifest{}, err
		}
		if _, duplicate := seen[record.ID]; duplicate {
			return nil, Manifest{}, dataError("vulndb-record-duplicate", "offline vulnerability release has duplicate record identifiers")
		}
		seen[record.ID] = struct{}{}
		records = append(records, record)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].ID < records[j].ID })

	indexBytes, err := json.Marshal(buildIndex(records))
	if err != nil {
		return nil, Manifest{}, fmt.Errorf("encode vulnerability index: %w", err)
	}
	descriptors := make([]RecordDescriptor, 0, len(records))
	for _, record := range records {
		descriptors = append(descriptors, RecordDescriptor{ID: record.ID, Path: recordPath(record.ID), Digest: digest(record.Raw)})
	}
	manifest := Manifest{
		SchemaVersion:        releaseSchemaVersion,
		SourceURL:            options.SourceURL,
		DatabaseModified:     options.DatabaseModified.UTC(),
		FetchedAt:            options.FetchedAt.UTC(),
		ContentDigest:        digest(contentPayload(descriptors, indexBytes)),
		IndexBuilderRevision: options.IndexBuilderRevision,
		ReviewStatus:         aggregateReviewStatus(records),
		StaleAfterSeconds:    int64(options.StaleAfter / time.Second),
		Records:              descriptors,
		Signature:            Signature{Algorithm: "ed25519", KeyID: options.KeyID},
	}

	for attempt := 0; attempt < 4; attempt++ {
		if err := signManifest(&manifest, options.SigningKey); err != nil {
			return nil, Manifest{}, err
		}
		archive, err := writeArchive(manifest, indexBytes, records)
		if err != nil {
			return nil, Manifest{}, err
		}
		compressedBytes, uncompressedBytes, err := recordMeasurements(archive)
		if err != nil {
			return nil, Manifest{}, err
		}
		if manifest.ArchiveBytes == int64(len(archive)) && manifest.RecordsCompressedBytes == compressedBytes && manifest.RecordsUncompressedBytes == uncompressedBytes {
			return archive, cloneManifest(manifest), nil
		}
		manifest.ArchiveBytes = int64(len(archive))
		manifest.RecordsCompressedBytes = compressedBytes
		manifest.RecordsUncompressedBytes = uncompressedBytes
	}
	return nil, Manifest{}, dataError("vulndb-archive-size-invalid", "offline vulnerability archive size did not stabilize")
}

func validateBuildOptions(options BuildOptions) error {
	if !strings.HasPrefix(options.SourceURL, "https://") || options.DatabaseModified.IsZero() || options.FetchedAt.IsZero() || strings.TrimSpace(options.IndexBuilderRevision) == "" || options.StaleAfter < time.Second || len(options.SigningKey) != ed25519.PrivateKeySize || strings.TrimSpace(options.KeyID) == "" {
		return dataError("vulndb-build-options-invalid", "offline vulnerability release build options are incomplete")
	}
	return nil
}

func signManifest(manifest *Manifest, key ed25519.PrivateKey) error {
	manifest.Signature.Value = ""
	payload, err := manifestPayload(*manifest)
	if err != nil {
		return err
	}
	manifest.Signature.Value = base64.StdEncoding.EncodeToString(ed25519.Sign(key, payload))
	return nil
}

func manifestPayload(manifest Manifest) ([]byte, error) {
	manifest.Signature.Value = ""
	return json.Marshal(manifest)
}

func writeArchive(manifest Manifest, indexBytes []byte, records []Record) ([]byte, error) {
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return nil, fmt.Errorf("encode offline vulnerability manifest: %w", err)
	}
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	if err := writeZipEntry(writer, manifestPath, manifestBytes); err != nil {
		return nil, err
	}
	if err := writeZipEntry(writer, indexPath, indexBytes); err != nil {
		return nil, err
	}
	for _, record := range records {
		if err := writeZipEntry(writer, recordPath(record.ID), record.Raw); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	if output.Len() > maxArchiveBytes {
		return nil, dataError("vulndb-archive-limit", "offline vulnerability archive exceeds its byte limit")
	}
	return output.Bytes(), nil
}

func writeZipEntry(writer *zip.Writer, name string, data []byte) error {
	header := &zip.FileHeader{
		Name:     name,
		Method:   zip.Store,
		Modified: zipEpoch,
	}
	if strings.HasPrefix(name, recordPrefix) {
		header.Method = zip.Deflate
		target, err := writer.CreateHeader(header)
		if err != nil {
			return err
		}
		_, err = target.Write(data)
		return err
	}
	header.CRC32 = crc32.ChecksumIEEE(data)
	header.CompressedSize64 = uint64(len(data))
	header.UncompressedSize64 = uint64(len(data))
	target, err := writer.CreateRaw(header)
	if err != nil {
		return err
	}
	_, err = target.Write(data)
	return err
}

func recordMeasurements(archive []byte) (int64, int64, error) {
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return 0, 0, dataError("vulndb-archive-invalid", "new offline vulnerability archive is malformed")
	}
	var compressed, uncompressed int64
	for _, file := range reader.File {
		if strings.HasPrefix(file.Name, recordPrefix) {
			compressed += int64(file.CompressedSize64)
			uncompressed += int64(file.UncompressedSize64)
		}
	}
	if compressed <= 0 || uncompressed <= 0 {
		return 0, 0, dataError("vulndb-archive-invalid", "new offline vulnerability archive has no record measurements")
	}
	return compressed, uncompressed, nil
}

func buildIndex(records []Record) releaseIndex {
	byPath := map[string]map[string]struct{}{}
	for _, record := range records {
		for _, affected := range record.Affected {
			ids := byPath[affected.Package.Name]
			if ids == nil {
				ids = map[string]struct{}{}
				byPath[affected.Package.Name] = ids
			}
			ids[record.ID] = struct{}{}
		}
	}
	paths := make([]string, 0, len(byPath))
	for path := range byPath {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	entries := make([]indexEntry, 0, len(paths))
	for _, path := range paths {
		ids := make([]string, 0, len(byPath[path]))
		for id := range byPath[path] {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		entries = append(entries, indexEntry{Path: path, IDs: ids})
	}
	return releaseIndex{SchemaVersion: releaseSchemaVersion, Entries: entries}
}

func aggregateReviewStatus(records []Record) string {
	reviewed, unreviewed := false, false
	for _, record := range records {
		if record.DatabaseSpecific.ReviewStatus == "UNREVIEWED" {
			unreviewed = true
		} else {
			reviewed = true
		}
	}
	if reviewed && unreviewed {
		return "MIXED"
	}
	if unreviewed {
		return "UNREVIEWED"
	}
	return "REVIEWED"
}

func contentPayload(records []RecordDescriptor, index []byte) []byte {
	var output bytes.Buffer
	for _, record := range records {
		fmt.Fprintf(&output, "%d:%s%d:%s%d:%s", len(record.ID), record.ID, len(record.Path), record.Path, len(record.Digest), record.Digest)
	}
	fmt.Fprintf(&output, "%d:", len(index))
	output.Write(index)
	return output.Bytes()
}
