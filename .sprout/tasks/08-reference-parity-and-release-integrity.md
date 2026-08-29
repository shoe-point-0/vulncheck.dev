<!-- sprout-task
{"schema_version":1,"id":"08-reference-parity-and-release-integrity","status":"open","created_at":"2026-08-23T05:18:00.000000000Z"}
-->

# Reference parity, adversarial corpus, and release integrity

## Goal

Make both the local companion and browser analysis kernel continuously falsifiable against pinned native references, then ship only reproducible, attributable static releases.

## Context

The clean design has two boundaries to verify: native capture must faithfully encode the selected Go project, and the browser must faithfully consume that captured input. govulncheck and gosec remain native reference tools for Project Evidence. GitHub Pages distributes bytes but cannot itself prove that a browser loaded the intended bytes.

## Contract dependency

Consume [the v1 security contract](../../docs/security-contract.md). A parity,
corpus, freshness, manifest, signature, cache, or rollback discrepancy must
produce explicit `inconclusive`, `unknown`, `unverified`, or `failed` evidence
and block release; it cannot be hidden by a renderer or reclassified as a
successful result.

## Requirements

1. Build a public versioned corpus with module-only and native-captured project fixtures. Cover direct calls, interfaces, generics, reflection, unsafe, build tags, cgo, standard-library findings, pseudo-versions, replaces, malformed modules, bundle corruption, and known gosec findings plus suppressions.
2. For every supported BuildProfile, compare native capture metadata with a pinned Go package loader; compare bundle-native govulncheck and gosec output with independent invocations; then compare browser kernel and renderer output with the bundle's expected evidence. A difference is a release blocker unless classified as unsupported before release.
3. Fuzz every archive, bundle, manifest, OSV, state-codec, and evidence parser; run cancellation, quota, worker-restart, and corrupt-cache stress tests. Add browser integration coverage for Chromium, Firefox, and WebKit where each feature is supported.
4. Produce a deterministic release manifest listing hashes for application, WASM, OSV data, bundle schema, Go toolchain, gosec, govulncheck, licenses, SBOM, build configuration, and source revision. Sign it with a key unavailable to the Pages publishing workflow.
5. Provide a separately distributed verifier or local companion command that validates release manifest, cached browser assets, and bundle integrity. A page cannot verify its own replacement after delivery-origin compromise.

## Constraints

- No browser release is trusted merely because it is served from the production origin.
- Tool, bundle, or browser differences block Project Evidence unless the support policy classifies them before release.
- A browser-only Module View is not incorrectly tested as equivalent to a native-captured project report.

## Acceptance criteria

- [ ] CI publishes an assurance matrix for Module View and Project Evidence and fails on unclassified differences in either path.
- [ ] Fuzz and adversarial corpus coverage is recorded for every parser and evaluator that accepts untrusted input.
- [ ] Repeating native capture and static release builds from pinned source and toolchain produces identical digests, or documented nondeterminism is eliminated.
- [ ] A clean browser profile verifies assets and an AnalysisBundle before offline Project Evidence; corrupt cache, bundle, stale database, and missing native evidence tests fail closed.
- [ ] The release page shows database age, analyzer version, bundle assurance level, native tool versions, manifest state, and unsupported configuration.

## Technical approach

1. Lay of the Land: define assurance levels, bundle schema fixtures, native tool pins, and fixture licenses.
2. Tracer Bullet: capture one direct vulnerable project, compare its bundled govulncheck and gosec evidence with independent tools, then display it in a clean browser profile.
3. Hot Path Exploration: extend metadata, evidence, browser-kernel, and release differential runners until each reported state is exercised.
4. Safe Passage: fuzz, race-test native builders, run browser failure injection, clean-environment verification, and Pages rollback rehearsal.
5. Closing Review: attach assurance matrix, parity data, reproducibility evidence, SBOM, signature, and rollback instructions to the release.

## Execution checklist

- [ ] Build and pin module and bundle corpus, native capture oracle, and independent reference runner.
- [ ] Add reproducible manifests, SBOM, signatures, clean-environment verifier, and assurance matrix.
- [ ] Rehearse corrupt-bundle recovery, static release rollback, and version migration.

## Verification

- [ ] Pinned Go package-loader, govulncheck, and gosec differential suites.
- [ ] go test, go test -race, go vet, fuzz smoke tests, and frontend unit or integration tests.
- [ ] Reproducible capture and static-build verification in a clean environment.
- [ ] Offline, stale-data, corrupt-cache, corrupt-bundle, and rollback end-to-end tests.

## Validation evidence

_Not recorded yet._

## Outcome and follow-ups

_Not completed yet._

## Original request

Reference parity and release assurance for module and project workflows.
