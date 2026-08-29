package vulndb

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"
)

// LoadArchive verifies the archive structure, signature, measurements, index,
// canonical record digests, and supported OSV schema before exposing records.
func LoadArchive(data []byte, publicKey ed25519.PublicKey) (Release, error) {
	if len(data) == 0 || len(data) > maxArchiveBytes {
		return Release{}, dataError("vulndb-archive-limit", "offline vulnerability archive exceeds its byte limit")
	}
	if len(publicKey) != ed25519.PublicKeySize {
		return Release{}, dataError("vulndb-signature-key-invalid", "offline vulnerability release public key is invalid")
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return Release{}, dataError("vulndb-corrupt", "offline vulnerability archive is malformed")
	}
	if len(reader.File) < 2 || len(reader.File) > maxRecords+2 {
		return Release{}, dataError("vulndb-archive-structure-invalid", "offline vulnerability archive has an invalid file count")
	}
	files := make(map[string]*zip.File, len(reader.File))
	var declaredUncompressed int64
	for _, file := range reader.File {
		if file.Name == "" || strings.Contains(file.Name, "\\") || strings.HasPrefix(file.Name, "/") || strings.Contains(file.Name, "..") || file.UncompressedSize64 > maxRecordBytes || file.CompressedSize64 > maxRecordBytes {
			return Release{}, dataError("vulndb-archive-structure-invalid", "offline vulnerability archive has an invalid file entry")
		}
		declaredUncompressed += int64(file.UncompressedSize64)
		if declaredUncompressed > maxArchiveBytes {
			return Release{}, dataError("vulndb-archive-limit", "offline vulnerability archive exceeds its uncompressed byte limit")
		}
		if _, duplicate := files[file.Name]; duplicate {
			return Release{}, dataError("vulndb-archive-structure-invalid", "offline vulnerability archive has duplicate file entries")
		}
		files[file.Name] = file
	}
	manifestFile, indexFile := files[manifestPath], files[indexPath]
	if manifestFile == nil || indexFile == nil {
		return Release{}, dataError("vulndb-archive-structure-invalid", "offline vulnerability archive is missing its manifest or index")
	}
	manifestBytes, err := readZipFile(manifestFile)
	if err != nil {
		return Release{}, err
	}
	var manifest Manifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return Release{}, dataError("vulndb-corrupt", "offline vulnerability manifest is malformed")
	}
	if err := validateManifest(manifest, int64(len(data)), publicKey); err != nil {
		return Release{}, err
	}
	indexBytes, err := readZipFile(indexFile)
	if err != nil {
		return Release{}, err
	}
	if digest(contentPayload(manifest.Records, indexBytes)) != manifest.ContentDigest {
		return Release{}, dataError("vulndb-content-digest-mismatch", "offline vulnerability release content digest does not match")
	}
	var index releaseIndex
	if err := json.Unmarshal(indexBytes, &index); err != nil {
		return Release{}, dataError("vulndb-index-invalid", "offline vulnerability index is malformed")
	}
	if err := validateIndex(index, manifest.Records); err != nil {
		return Release{}, err
	}

	records := make(map[string]Record, len(manifest.Records))
	var compressedBytes, uncompressedBytes int64
	for _, descriptor := range manifest.Records {
		file := files[descriptor.Path]
		if file == nil {
			return Release{}, dataError("vulndb-record-missing", "offline vulnerability release is missing a canonical record")
		}
		raw, err := readZipFile(file)
		if err != nil {
			return Release{}, err
		}
		if digest(raw) != descriptor.Digest {
			return Release{}, dataError("vulndb-record-digest-mismatch", "offline vulnerability record digest does not match")
		}
		record, err := ParseRecord(raw)
		if err != nil {
			return Release{}, err
		}
		if record.ID != descriptor.ID {
			return Release{}, dataError("vulndb-record-identifier-mismatch", "offline vulnerability record identifier does not match its manifest")
		}
		records[record.ID] = record
		compressedBytes += int64(file.CompressedSize64)
		uncompressedBytes += int64(file.UncompressedSize64)
	}
	if compressedBytes != manifest.RecordsCompressedBytes || uncompressedBytes != manifest.RecordsUncompressedBytes {
		return Release{}, dataError("vulndb-size-mismatch", "offline vulnerability release measurements do not match")
	}
	if len(files) != len(manifest.Records)+2 {
		return Release{}, dataError("vulndb-archive-structure-invalid", "offline vulnerability archive contains undeclared data")
	}
	resolvedIndex := make(map[string][]string, len(index.Entries))
	for _, entry := range index.Entries {
		resolvedIndex[entry.Path] = append([]string(nil), entry.IDs...)
	}
	return Release{manifest: cloneManifest(manifest), records: records, index: resolvedIndex}, nil
}

func validateManifest(manifest Manifest, archiveBytes int64, publicKey ed25519.PublicKey) error {
	if manifest.SchemaVersion != releaseSchemaVersion {
		return dataError("vulndb-schema-incompatible", "offline vulnerability release uses an unsupported schema")
	}
	if !strings.HasPrefix(manifest.SourceURL, "https://") || manifest.DatabaseModified.IsZero() || manifest.FetchedAt.IsZero() || strings.TrimSpace(manifest.IndexBuilderRevision) == "" || manifest.StaleAfterSeconds <= 0 || manifest.StaleAfterSeconds > maxStaleAfterSeconds || manifest.RecordsCompressedBytes <= 0 || manifest.RecordsUncompressedBytes <= 0 || len(manifest.Records) == 0 || len(manifest.Records) > maxRecords || manifest.ArchiveBytes != archiveBytes || !validDigest(manifest.ContentDigest) {
		return dataError("vulndb-manifest-invalid", "offline vulnerability manifest is incomplete")
	}
	if manifest.ReviewStatus != "REVIEWED" && manifest.ReviewStatus != "UNREVIEWED" && manifest.ReviewStatus != "MIXED" {
		return dataError("vulndb-manifest-invalid", "offline vulnerability manifest has an invalid review status")
	}
	if manifest.Signature.Algorithm != "ed25519" || manifest.Signature.KeyID == "" {
		return dataError("vulndb-signature-invalid", "offline vulnerability manifest signature metadata is invalid")
	}
	signature, err := base64.StdEncoding.DecodeString(manifest.Signature.Value)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return dataError("vulndb-signature-invalid", "offline vulnerability manifest signature is malformed")
	}
	payload, err := manifestPayload(manifest)
	if err != nil {
		return err
	}
	if !ed25519.Verify(publicKey, payload, signature) {
		return dataError("vulndb-signature-invalid", "offline vulnerability manifest signature does not verify")
	}
	seen := make(map[string]struct{}, len(manifest.Records))
	for _, descriptor := range manifest.Records {
		if !validRecordID(descriptor.ID) || descriptor.Path != recordPath(descriptor.ID) || !validDigest(descriptor.Digest) {
			return dataError("vulndb-manifest-invalid", "offline vulnerability manifest record descriptor is invalid")
		}
		if _, duplicate := seen[descriptor.ID]; duplicate {
			return dataError("vulndb-manifest-invalid", "offline vulnerability manifest has duplicate records")
		}
		seen[descriptor.ID] = struct{}{}
	}
	return nil
}

func validateIndex(index releaseIndex, records []RecordDescriptor) error {
	if index.SchemaVersion != releaseSchemaVersion {
		return dataError("vulndb-schema-incompatible", "offline vulnerability index uses an unsupported schema")
	}
	known := make(map[string]struct{}, len(records))
	for _, descriptor := range records {
		known[descriptor.ID] = struct{}{}
	}
	seenPaths := make(map[string]struct{}, len(index.Entries))
	for _, entry := range index.Entries {
		if entry.Path == "" || len(entry.IDs) == 0 {
			return dataError("vulndb-index-invalid", "offline vulnerability index entry is incomplete")
		}
		if _, duplicate := seenPaths[entry.Path]; duplicate {
			return dataError("vulndb-index-invalid", "offline vulnerability index has duplicate paths")
		}
		seenPaths[entry.Path] = struct{}{}
		seenIDs := make(map[string]struct{}, len(entry.IDs))
		for _, id := range entry.IDs {
			if _, found := known[id]; !found {
				return dataError("vulndb-index-invalid", "offline vulnerability index references an undeclared record")
			}
			if _, duplicate := seenIDs[id]; duplicate {
				return dataError("vulndb-index-invalid", "offline vulnerability index has duplicate record identifiers")
			}
			seenIDs[id] = struct{}{}
		}
	}
	return nil
}

func readZipFile(file *zip.File) ([]byte, error) {
	if file.UncompressedSize64 > maxRecordBytes || file.CompressedSize64 > maxRecordBytes {
		return nil, dataError("vulndb-archive-limit", "offline vulnerability archive entry exceeds its byte limit")
	}
	reader, err := file.Open()
	if err != nil {
		return nil, dataError("vulndb-corrupt", "offline vulnerability archive entry cannot be read")
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, maxRecordBytes+1))
	if err != nil || len(data) > maxRecordBytes {
		return nil, dataError("vulndb-corrupt", "offline vulnerability archive entry is invalid")
	}
	return data, nil
}
