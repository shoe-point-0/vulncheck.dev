package vulndb

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"strings"
)

// ParseRecord validates the supported OSV envelope while preserving raw
// official JSON. Unsupported schema is distinct from corrupt content so a
// renderer can report an explicit unknown result.
func ParseRecord(raw []byte) (Record, error) {
	if len(raw) == 0 || len(raw) > maxRecordBytes {
		return Record{}, dataError("vulndb-record-limit", "canonical vulnerability record exceeds its byte limit")
	}
	var record Record
	if err := json.Unmarshal(raw, &record); err != nil {
		return Record{}, dataError("vulndb-corrupt", "canonical vulnerability record is malformed")
	}
	if record.SchemaVersion != osvSchemaVersion {
		return Record{}, dataError("vulndb-schema-incompatible", "canonical vulnerability record uses an unsupported OSV schema")
	}
	if !validRecordID(record.ID) || record.Modified.IsZero() || len(record.Affected) == 0 {
		return Record{}, dataError("vulndb-record-invalid", "canonical vulnerability record is incomplete")
	}
	for _, affected := range record.Affected {
		if affected.Package.Ecosystem != "Go" || affected.Package.Name == "" {
			return Record{}, dataError("vulndb-record-invalid", "canonical vulnerability record has an unsupported affected package")
		}
	}
	if record.DatabaseSpecific.ReviewStatus == "" {
		record.DatabaseSpecific.ReviewStatus = "REVIEWED"
	}
	if record.DatabaseSpecific.ReviewStatus != "REVIEWED" && record.DatabaseSpecific.ReviewStatus != "UNREVIEWED" {
		return Record{}, dataError("vulndb-review-status-invalid", "canonical vulnerability record has an unsupported review status")
	}
	if record.DatabaseSpecific.URL == "" {
		return Record{}, dataError("vulndb-record-invalid", "canonical vulnerability record has no advisory URL")
	}
	record.Raw = append(json.RawMessage(nil), raw...)
	return record, nil
}

// ExtractOfficialRecords reads the documented Go Vulnerability Database bulk
// artifact. It accepts only ID/*.json records, never x/vulndb's internal
// source repository layout.
func ExtractOfficialRecords(bulkArchive []byte) ([][]byte, error) {
	if len(bulkArchive) == 0 || len(bulkArchive) > maxArchiveBytes {
		return nil, dataError("vulndb-bulk-limit", "official vulnerability database bulk artifact exceeds its byte limit")
	}
	reader, err := zip.NewReader(bytes.NewReader(bulkArchive), int64(len(bulkArchive)))
	if err != nil {
		return nil, dataError("vulndb-bulk-corrupt", "official vulnerability database bulk artifact is malformed")
	}
	var records [][]byte
	for _, file := range reader.File {
		if !strings.HasPrefix(file.Name, "ID/") || !strings.HasSuffix(file.Name, ".json") {
			continue
		}
		raw, err := readZipFile(file)
		if err != nil {
			return nil, err
		}
		records = append(records, raw)
	}
	if len(records) == 0 {
		return nil, dataError("vulndb-bulk-records-missing", "official vulnerability database bulk artifact has no canonical records")
	}
	return records, nil
}
