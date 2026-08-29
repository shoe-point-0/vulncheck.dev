<!-- sprout-task
{"schema_version":1,"id":"00-security-trust-and-capability-contract","status":"implemented","created_at":"2026-08-23T05:18:00Z","implemented_at":"2026-08-23T06:14:46.296267157Z"}
-->

# Security claim contract, trust boundaries, and browser capability gates

Execute this task before implementing an analyzer feature. A security product may be fast or private only if its claims remain true when the platform, input, or release channel is hostile.

## Goal

Publish and enforce the product's evidence contract, threat model, capability policy, and release gates. This is the prerequisite for every other task.

## Context

Static hosting, hostile source input, and imperfect static analysis make a precise claim contract a prerequisite for every feature.

## Requirements

### Required result contract

Every report must carry the selected Go toolchain, GOOS, GOARCH, build tags, cgo policy, dependency source and digest, vulnerability database revision, analyzer release digest, and timestamp.

- Version status is one of affected, not-affected, or unknown.
- Reachability status is reachable with a reproducible trace, no-static-path-found, or inconclusive. The second status must never be rendered as safe, dead, or unreachable.
- Rule status is finding, suppressed finding, no finding, or not analyzed. A no-finding result is not a security verdict.
- Integrity status is verified only when the declared artifact and module checks have succeeded; otherwise it is unverified or failed.

## Constraints

- Do not certify code, packages, or organizations as safe.
- Do not execute analyzed Go code, cgo, build tools, generators, plugins, or tests.
- Do not treat a GitHub Pages deployment as an independent trust root.

### Threat model and policy

- Treat module archives, source files, go.mod files, OSV records, permalink state, and cached data as hostile input. Impose byte, file-count, path-depth, nesting, CPU, memory, and wall-time budgets before parsing.
- A public module lookup discloses its path to the selected proxy. Ask before the first lookup, show the exact endpoint, never silently fail over to unrelated proxies, and do not offer browser-based authentication for private modules.
- Private code is accepted only from a user-selected directory, file upload, or already verified local cache. Air-gapped mode is a user-visible mode that disables network acquisition and operates only after all required assets are present.
- A compromised site, Pages publisher, DNS record, or browser extension can serve code that exfiltrates source before an application-level network guard runs. Document this residual risk. A strict air gap therefore requires verified assets plus an actually disconnected or firewall-restricted environment.
- Service-worker caching, CSP, and a URL fragment are defenses in depth, not a substitute for a separately distributed release-verification key or native verifier.

## Acceptance criteria

- [x] A versioned docs/security-contract.md defines the four result vocabularies, prohibited wording, data-retention policy, and report schema.
- [x] The UI has no path that calls analyzed code or enables gosec AI/autofix features.
- [x] Each downstream packet consumes this contract and has an explicit inconclusive path.
- [x] A machine-readable capability report records browser feature detection and selected fallback for every analysis.
- [x] Threat-model tests cover ZIP bombs, path traversal, malformed source, cancellation, stale data, unverified assets, and offline egress attempts.

## Technical approach

1. Lay of the Land: enumerate asset, data, and execution trust boundaries; review primary browser, Go, OSV, and gosec documentation.
2. Tracer Bullet: emit a synthetic report containing one result of every status, a provenance block, and a deliberately inconclusive case.
3. Hot Path Exploration: make the report schema the only interface between acquisition, analysis, rule, and UI packages.
4. Safe Passage: add schema validation, negative language tests, resource-budget enforcement, and threat-model regression fixtures.
5. Closing Review: have an independent reviewer attempt to turn each uncertain result into an unsafe claim; record every waiver.

## Execution checklist

- [x] Define the versioned report schema and prohibited-language tests.
- [x] Implement capability reporting and resource budgets at every input boundary.
- [x] Review data-flow, offline, and release-verification threats before downstream implementation.

## Verification

- [x] Contract and report-schema tests pass.
- [x] Snapshot tests reject prohibited labels such as safe and guaranteed.
- [x] Security review records residual risks and owner-approved waivers.

## Validation evidence

- `go test ./...` passed for `vulncheck.dev/contract`, covering all v1 status vocabularies, schema-enum alignment, report invariants, capability metadata, display-language regression labels, and the hostile-input fixtures.
- `go test -race ./...` and `go vet ./...` passed. The contract package contains no goroutines, I/O, process, network, storage, or browser dependencies.
- `govulncheck ./...` was unavailable because `govulncheck` is not installed or present on `PATH`; this package has no third-party module dependencies. It remains a release-matrix command for a later environment that provides the tool.
- `go test ./contract -run=^$ -fuzz=FuzzInputBoundaryValidation -fuzztime=1s` passed after 322,541 executions and retained 78 newly interesting inputs in the Go fuzz cache. The fuzz target exercises relative path, malformed source, and browser-message boundary admission without panics.
- `npm run test:web` passed four Node browser-host contract tests: baseline transferable-worker selection, optional OPFS and isolated profiles, explicit unavailable fallback, and the UI action allowlist. `node --check` passed for both browser modules; the JSON report schema parsed successfully with Node.
- `sprout check 00-security-trust-and-capability-contract` passed before completion. `git diff --check` passed.
- [docs/security-review-00.md](../../docs/security-review-00.md) records ZIP expansion, traversal, malformed source, cancellation, stale data, unverified asset, offline-egress, capability, and language threats. No waiver was requested or approved; documented residual risks are deferred to their owning packets.

## Outcome and follow-ups

Task 00 established `docs/security-contract.md` v1, a machine-readable JSON
schema, and a pure Go validation mirror in `contract`. The contract is now the
outer evidence seam: every report carries assurance, timestamp, selected Go and
dependency provenance, database and analyzer digests, all result vocabularies,
freshness, diagnostics, and a browser capability profile with a fallback.

The initial browser host detector chooses an isolated parallel profile only when
all required features are observed, otherwise enhanced OPFS storage, the
transferable-worker baseline, or an explicit unavailable state. The UI has no
execution, automatic-change, or AI feature path; its v1 action allowlist is
tested.

`contract.ResourceBudget`, path and source validation, freshness policy, and
single-endpoint acquisition policy provide common fail-closed seams for all
future hostile inputs. The next ordered task, 01, must enforce this policy in a
real streaming ZIP reader, storage adapters, and browser integration suite;
task 08 remains responsible for independently verifiable release bytes and any
release-key workflow.

## Original request

Trustworthy client-side Go module safety analysis on static hosting.
