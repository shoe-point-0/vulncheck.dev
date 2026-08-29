# Pinned Go Vulnerability Database fixture

This small, reviewable fixture is a semantic snapshot of three canonical JSON
records published by the documented Go Vulnerability Database record endpoint
on 2024-05-20. It deliberately covers the three evaluator package classes:

- `GO-2020-0015`: module path `golang.org/x/text` and import evidence;
- `GO-2022-0191`: `stdlib`, `crypto/x509`, and multiple affected intervals;
- `GO-2022-0189`: `toolchain` and `cmd/go/internal/get`.

The JSON is formatted for repository review. The package builder preserves the
exact downloaded bytes in real releases; the fixture test compares evaluation
results from these canonical fields, while the CI workflow downloads the
complete documented `https://vuln.go.dev/vulndb.zip` artifact and its
`https://vuln.go.dev/index/db.json` provenance record.

Refresh only by retrieving `https://vuln.go.dev/ID/<GO-ID>.json`, reviewing the
semantic JSON change, and updating the fixture name and its corresponding
differential cases in `vulndb_test.go`.
