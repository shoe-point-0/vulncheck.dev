<!-- sprout-task
{"schema_version":1,"id":"05-supply-chain-heuristics-and-diffing","status":"open","created_at":"2026-08-23T05:05:13.834300927Z"}
-->

# Native gosec evidence and evidence-preserving change review

## Goal

Use pinned native gosec as the authoritative source-rule producer for Project Evidence, preserve its raw output in AnalysisBundle, and compare two verified snapshots without claiming a patch is safe.

## Context

gosec is designed around Go package loading and has a mature CLI, stable rule IDs, and SARIF or JSON output. Rehosting its loader and full rule set in browser WebAssembly would duplicate Go-toolchain behavior and increase the trusted computing base. The local companion can run pinned gosec against the exact native-captured profile, bind the raw results to the bundle, and let the static browser inspect them privately. Browser-side custom rules remain a later, explicitly non-authoritative extension.

## Contract dependency

Consume [the v1 security contract](../../docs/security-contract.md). Missing,
invalid, or unsupported native evidence must be `not-analyzed`; incomplete
comparison and static-path limits must stay `inconclusive`. Neither a clean
native output nor a removed static path may be converted into a certification
claim.

## Requirements

1. The local companion's optional evidence step runs pinned native gosec with an explicit rule configuration, Go toolchain, source-root selection, build tags, and tests policy. It records command version, configuration digest, exit semantics, suppression policy, raw SARIF or JSON, and output digest in the bundle.
2. The browser EvidenceReader validates that raw gosec output is associated with the hydrated snapshot and displays native rule ID, source span, severity metadata, evidence, configuration, suppression, and producer version. It does not reinterpret a no-finding result as safety.
3. Support an explicit unavailable-native-evidence status. Browser-only Module View may show no source-rule evidence but cannot synthesize a claim that gosec ran.
4. Diff two independently validated ProjectSnapshots under the same BuildProfile. Show changed files, affected OSV symbols, native gosec finding deltas, changed call-path evidence, and unresolved analysis. A removed static path is no-static-path-found after upgrade, not remediation proof.
5. Keep browser custom rules out of the first release. A future rule must consume only ProjectSnapshot, have a stable ID, document false-positive and false-negative modes, and be clearly separated from native gosec evidence.

## Constraints

- The companion and browser must never execute application code, tests, generators, plugins, or user-controlled commands beyond their fixed analysis invocation.
- Native gosec output is evidence with known limitations, not a remediation or maliciousness verdict.
- AI/autofix, external suggestions, ambient credentials, and browser network activity are disabled for the evidence step.

## Acceptance criteria

- [ ] Fixture bundles contain raw, digest-bound gosec output that agrees with independently invoked pinned gosec for the same profile and suppression configuration.
- [ ] Browser output preserves rule IDs and suppression state verbatim and reports unavailable evidence distinctly.
- [ ] Diff reports include both snapshot hashes, both BuildProfiles, and separate OSV, native-gosec, call-evidence, and inconclusive deltas.
- [ ] Command-construction and network-denial tests show that user source cannot alter the companion invocation or cause browser evidence processing to fetch data.
- [ ] A future browser-rule extension cannot be enabled by default or masquerade as native gosec.

## Technical approach

1. Lay of the Land: pin gosec and its configuration, define the evidence envelope, and add native fixture runs before browser presentation.
2. Tracer Bullet: produce one bundle with a known gosec finding and render the raw rule ID, source span, and producer provenance in the browser.
3. Hot Path Exploration: add evidence envelopes, verifier, suppression display, unavailable status, and two-bundle diff.
4. Safe Passage: differential-test native gosec, fuzz evidence parsing, test suppression abuse, command injection, secret scrubbing, and corrupt envelopes.
5. Closing Review: publish rule inventory, configuration, toolchain, limitations, corpus agreement, and exact UI label semantics.

## Execution checklist

- [ ] Implement the pinned native evidence envelope and bundle binding.
- [ ] Establish fixture parity and safe companion invocation before browser display work.
- [ ] Add evidence verification, unavailable status, and two-snapshot delta view.

## Verification

- [ ] Pinned native gosec differential suite, suppression tests, and command-construction tests.
- [ ] Unit, golden, fuzz, and resource-limit tests for envelope, parser, and diffing.
- [ ] Browser network-denial and source-span rendering tests.
- [ ] SARIF or JSON schema validation and output-digest verification.

## Validation evidence

_Not recorded yet._

## Outcome and follow-ups

_Not completed yet._

## Original request

Pinned native gosec evidence and version comparison.
