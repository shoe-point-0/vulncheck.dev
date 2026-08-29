// vulncheck-vulndb-pack turns the documented Go vulnerability bulk artifact
// into a verified-at-load, deterministic offline release. It never contacts
// the network itself; CI owns acquisition and records its provenance here.
package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"vulncheck.dev/internal/vulndb"
)

func main() {
	inputPath := flag.String("input", "", "path to the downloaded vuln.go.dev vulndb.zip")
	outputPath := flag.String("output", "", "destination for the signed offline release")
	sourceURL := flag.String("source-url", "https://vuln.go.dev/vulndb.zip", "documented vulnerability database source URL")
	databaseModified := flag.String("database-modified", "", "database modified time (RFC3339, from index/db.json)")
	fetchedAt := flag.String("fetched-at", "", "bulk artifact fetch time (RFC3339)")
	indexBuilderRevision := flag.String("index-builder-revision", "", "reviewed source revision of this index builder")
	staleAfter := flag.String("stale-after", "168h", "maximum age before evaluations fail closed")
	signingKey := flag.String("signing-key", "", "base64 Ed25519 seed or private key; pass through a protected CI secret")
	keyID := flag.String("key-id", "", "public signing-key identifier")
	flag.Parse()

	if err := run(packOptions{
		inputPath: *inputPath, outputPath: *outputPath, sourceURL: *sourceURL,
		databaseModified: *databaseModified, fetchedAt: *fetchedAt,
		indexBuilderRevision: *indexBuilderRevision, staleAfter: *staleAfter,
		signingKey: *signingKey, keyID: *keyID,
	}); err != nil {
		fmt.Fprintf(os.Stderr, "vulncheck-vulndb-pack: %v\n", err)
		os.Exit(1)
	}
}

type packOptions struct {
	inputPath, outputPath, sourceURL, databaseModified, fetchedAt string
	indexBuilderRevision, staleAfter, signingKey, keyID           string
}

func run(options packOptions) error {
	if options.inputPath == "" || options.outputPath == "" {
		return fmt.Errorf("-input and -output are required")
	}
	modified, err := time.Parse(time.RFC3339, options.databaseModified)
	if err != nil {
		return fmt.Errorf("parse -database-modified: %w", err)
	}
	fetched, err := time.Parse(time.RFC3339, options.fetchedAt)
	if err != nil {
		return fmt.Errorf("parse -fetched-at: %w", err)
	}
	stale, err := time.ParseDuration(options.staleAfter)
	if err != nil || stale <= 0 {
		return fmt.Errorf("parse -stale-after: must be a positive Go duration")
	}
	key, err := decodeSigningKey(options.signingKey)
	if err != nil {
		return err
	}
	bulk, err := os.ReadFile(options.inputPath)
	if err != nil {
		return fmt.Errorf("read official bulk artifact: %w", err)
	}
	records, err := vulndb.ExtractOfficialRecords(bulk)
	if err != nil {
		return fmt.Errorf("extract official canonical records: %w", err)
	}
	release, manifest, err := vulndb.BuildArchive(records, vulndb.BuildOptions{
		SourceURL: options.sourceURL, DatabaseModified: modified, FetchedAt: fetched,
		IndexBuilderRevision: options.indexBuilderRevision, StaleAfter: stale,
		SigningKey: key, KeyID: options.keyID,
	})
	if err != nil {
		return fmt.Errorf("build signed offline release: %w", err)
	}
	if _, err := vulndb.LoadArchive(release, key.Public().(ed25519.PublicKey)); err != nil {
		return fmt.Errorf("verify newly built signed offline release: %w", err)
	}
	if directory := filepath.Dir(options.outputPath); directory != "." {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			return fmt.Errorf("create output directory: %w", err)
		}
	}
	if err := os.WriteFile(options.outputPath, release, 0o644); err != nil {
		return fmt.Errorf("write signed offline release: %w", err)
	}
	fmt.Printf("wrote %s: records=%d archive_bytes=%d records_compressed_bytes=%d records_uncompressed_bytes=%d content_digest=%s\n",
		options.outputPath, len(manifest.Records), manifest.ArchiveBytes, manifest.RecordsCompressedBytes, manifest.RecordsUncompressedBytes, manifest.ContentDigest)
	return nil
}

func decodeSigningKey(encoded string) (ed25519.PrivateKey, error) {
	if strings.TrimSpace(encoded) == "" {
		return nil, fmt.Errorf("-signing-key is required")
	}
	bytes, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		bytes, err = base64.RawStdEncoding.DecodeString(encoded)
	}
	if err != nil {
		return nil, fmt.Errorf("decode -signing-key: %w", err)
	}
	switch len(bytes) {
	case ed25519.SeedSize:
		return ed25519.NewKeyFromSeed(bytes), nil
	case ed25519.PrivateKeySize:
		return ed25519.PrivateKey(bytes), nil
	default:
		return nil, fmt.Errorf("-signing-key must decode to an Ed25519 seed or private key")
	}
}
