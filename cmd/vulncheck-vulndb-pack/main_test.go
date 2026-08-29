package main

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"

	"vulncheck.dev/internal/vulndb"
)

func TestRunPackagesDocumentedBulkArtifact(t *testing.T) {
	directory := t.TempDir()
	inputPath := filepath.Join(directory, "vulndb.zip")
	outputPath := filepath.Join(directory, "out", "release.zip")
	if err := os.WriteFile(inputPath, documentedBulk(t), 0o600); err != nil {
		t.Fatal(err)
	}
	seed := bytes.Repeat([]byte{9}, ed25519.SeedSize)
	if err := run(packOptions{
		inputPath: inputPath, outputPath: outputPath, sourceURL: "https://vuln.go.dev/vulndb.zip",
		databaseModified: "2024-05-20T16:03:47Z", fetchedAt: "2024-05-21T00:00:00Z",
		indexBuilderRevision: "test-revision", staleAfter: "168h",
		signingKey: base64.StdEncoding.EncodeToString(seed), keyID: "test-key",
	}); err != nil {
		t.Fatalf("package documented bulk artifact: %v", err)
	}
	release, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatal(err)
	}
	key := ed25519.NewKeyFromSeed(seed)
	loaded, err := vulndb.LoadArchive(release, key.Public().(ed25519.PublicKey))
	if err != nil || len(loaded.Manifest().Records) != 1 {
		t.Fatalf("signed release did not verify: manifest=%#v err=%v", loaded.Manifest(), err)
	}
}

func TestDecodeSigningKeyRejectsUnexpectedLength(t *testing.T) {
	_, err := decodeSigningKey(base64.StdEncoding.EncodeToString([]byte("too short")))
	if err == nil {
		t.Fatal("short signing key was accepted")
	}
}

func documentedBulk(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	entries := map[string]string{
		"index/db.json":        `{"modified":"2024-05-20T16:03:47Z"}`,
		"ID/GO-2024-0001.json": `{"schema_version":"1.3.1","id":"GO-2024-0001","modified":"2024-05-20T16:03:47Z","affected":[{"package":{"ecosystem":"Go","name":"example.com/mod"},"ranges":[{"type":"SEMVER","events":[{"introduced":"0"}]}]}],"database_specific":{"url":"https://pkg.go.dev/vuln/GO-2024-0001","review_status":"REVIEWED"}}`,
	}
	for name, content := range entries {
		target, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := target.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
