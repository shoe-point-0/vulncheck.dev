package vulndb

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
)

const (
	releaseSchemaVersion = "v1"
	osvSchemaVersion     = "1.3.1"
	manifestPath         = "manifest.json"
	indexPath            = "index.json"
	recordPrefix         = "records/"
	maxArchiveBytes      = 64 << 20
	maxRecords           = 10_000
	maxRecordBytes       = 1 << 20
	maxStaleAfterSeconds = int64((1<<63 - 1) / int64(time.Second))
)

var zipEpoch = time.Date(1980, time.January, 1, 0, 0, 0, 0, time.UTC)

// DataError is a typed offline-database failure suitable for a visible,
// inconclusive diagnostic. Its message intentionally contains no record bytes.
type DataError struct {
	Code string
	Text string
}

func (e *DataError) Error() string { return e.Text }

func dataError(code, text string) error { return &DataError{Code: code, Text: text} }

// Manifest is the signed provenance for one immutable offline data release.
type Manifest struct {
	SchemaVersion            string             `json:"schema_version"`
	SourceURL                string             `json:"source_url"`
	DatabaseModified         time.Time          `json:"database_modified"`
	FetchedAt                time.Time          `json:"fetched_at"`
	ContentDigest            string             `json:"content_digest"`
	IndexBuilderRevision     string             `json:"index_builder_revision"`
	ReviewStatus             string             `json:"review_status"`
	StaleAfterSeconds        int64              `json:"stale_after_seconds"`
	RecordsCompressedBytes   int64              `json:"records_compressed_bytes"`
	RecordsUncompressedBytes int64              `json:"records_uncompressed_bytes"`
	ArchiveBytes             int64              `json:"archive_bytes"`
	Records                  []RecordDescriptor `json:"records"`
	Signature                Signature          `json:"signature"`
}

type RecordDescriptor struct {
	ID     string `json:"id"`
	Path   string `json:"path"`
	Digest string `json:"digest"`
}

type Signature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"key_id"`
	Value     string `json:"value"`
}

// BuildOptions describes release facts collected by CI from the documented Go
// Vulnerability Database API or its vulndb.zip bulk artifact.
type BuildOptions struct {
	SourceURL            string
	DatabaseModified     time.Time
	FetchedAt            time.Time
	IndexBuilderRevision string
	StaleAfter           time.Duration
	SigningKey           ed25519.PrivateKey
	KeyID                string
}

// Record retains raw canonical OSV JSON alongside the fields needed for Go
// ecosystem evaluation. Raw is never synthesized by the compact index.
type Record struct {
	SchemaVersion    string           `json:"schema_version"`
	ID               string           `json:"id"`
	Modified         time.Time        `json:"modified"`
	Affected         []Affected       `json:"affected"`
	DatabaseSpecific DatabaseSpecific `json:"database_specific"`
	Raw              json.RawMessage  `json:"-"`
}

type Affected struct {
	Package           Package           `json:"package"`
	Ranges            []Range           `json:"ranges"`
	EcosystemSpecific EcosystemSpecific `json:"ecosystem_specific"`
}

type Package struct {
	Ecosystem string `json:"ecosystem"`
	Name      string `json:"name"`
}

type Range struct {
	Type   string  `json:"type"`
	Events []Event `json:"events"`
}

type Event struct {
	Introduced   string `json:"introduced,omitempty"`
	Fixed        string `json:"fixed,omitempty"`
	LastAffected string `json:"last_affected,omitempty"`
}

type EcosystemSpecific struct {
	Imports []AffectedImport `json:"imports"`
}

// AffectedImport is preserved Go Vulnerability Database import metadata.
type AffectedImport struct {
	Path    string   `json:"path"`
	Symbols []string `json:"symbols"`
	GOOS    []string `json:"goos"`
	GOARCH  []string `json:"goarch"`
}

type DatabaseSpecific struct {
	URL          string `json:"url"`
	ReviewStatus string `json:"review_status"`
}

type releaseIndex struct {
	SchemaVersion string       `json:"schema_version"`
	Entries       []indexEntry `json:"entries"`
}

type indexEntry struct {
	Path string   `json:"path"`
	IDs  []string `json:"ids"`
}

// Release is a verified, immutable-by-convention offline data release.
type Release struct {
	manifest Manifest
	records  map[string]Record
	index    map[string][]string
}

func (r Release) Manifest() Manifest { return cloneManifest(r.manifest) }

func (r Release) Record(id string) (Record, bool) {
	record, found := r.records[id]
	if !found {
		return Record{}, false
	}
	return cloneRecord(record), true
}

func cloneManifest(manifest Manifest) Manifest {
	manifest.Records = append([]RecordDescriptor(nil), manifest.Records...)
	return manifest
}

func cloneRecord(record Record) Record {
	record.Raw = append(json.RawMessage(nil), record.Raw...)
	record.Affected = append([]Affected(nil), record.Affected...)
	for index := range record.Affected {
		affected := &record.Affected[index]
		affected.Ranges = append([]Range(nil), affected.Ranges...)
		for rangeIndex := range affected.Ranges {
			affected.Ranges[rangeIndex].Events = append([]Event(nil), affected.Ranges[rangeIndex].Events...)
		}
		affected.EcosystemSpecific.Imports = append([]AffectedImport(nil), affected.EcosystemSpecific.Imports...)
		for importIndex := range affected.EcosystemSpecific.Imports {
			affected.EcosystemSpecific.Imports[importIndex] = cloneAffectedImport(affected.EcosystemSpecific.Imports[importIndex])
		}
	}
	return record
}

func recordPath(id string) string { return recordPrefix + id + ".json" }

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func validDigest(value string) bool {
	if !strings.HasPrefix(value, "sha256:") || len(value) != 71 {
		return false
	}
	_, err := hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
	return err == nil
}

func validRecordID(value string) bool {
	if !strings.HasPrefix(value, "GO-") || len(value) < len("GO-2020-0001") || len(value) > 64 {
		return false
	}
	for _, character := range value[3:] {
		if (character < '0' || character > '9') && character != '-' {
			return false
		}
	}
	return true
}

// GenerateKey is a test and local-development helper. CI must instead supply
// a stable release signing key through its protected secret store.
func GenerateKey() (ed25519.PublicKey, ed25519.PrivateKey, error) {
	return ed25519.GenerateKey(rand.Reader)
}
