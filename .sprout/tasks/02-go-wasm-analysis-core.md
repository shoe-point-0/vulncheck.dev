<!-- sprout-task
{"schema_version":1,"id":"02-go-wasm-analysis-core","status":"open","created_at":"2026-08-23T05:05:10.005794652Z"}
-->

# Versioned AnalysisBundle and deterministic project snapshot

## Goal

Define one portable AnalysisBundle contract that captures the Go command's resolved project view and hydrate it into an immutable ProjectSnapshot. This replaces an attempted browser reimplementation of Go dependency and build selection.

## Context

Correct project analysis depends on the actual module graph, selected source files, toolchain, GOOS, GOARCH, build tags, cgo policy, tests policy, and roots. Reproducing Minimal Version Selection and the Go command's package loading in the browser would duplicate a moving, security-critical implementation. A local companion can use the developer's intended Go environment to capture a data-only snapshot without uploading source or executing application code.

## Contract dependency

Consume [the v1 security contract](../../docs/security-contract.md). Bundle
validation and capture failures must preserve the contract provenance and map
unknown schema, incomplete build selection, cancellation, or missing content to
typed diagnostics plus explicit `inconclusive`, `unknown`, or `failed` results.
They must not create Project Evidence from an unverified bundle.

## Requirements

1. Specify AnalysisBundle v1 as a bounded archive with a versioned manifest, content-addressed source files, module graph, package inventory, BuildProfile, selected root packages, diagnostics, producer identity, and source plus bundle digest. File-system paths are normalized to bundle-relative identifiers; local absolute paths, credentials, and ambient environment values are excluded.
2. Define two assurance levels. Browser-limited snapshots may be built only for Module View and cannot claim project reachability. Native-captured snapshots are produced by the local companion after it asks the Go toolchain to resolve package metadata for the explicitly supplied profile; only these are eligible for Project Evidence.
3. The companion command, provisionally vulncheck bundle, must record the exact Go toolchain version and build selection inputs, request package metadata with the standard Go package loader, collect only selected source and metadata, and write no network credentials into the bundle. It must not run application code, tests, generators, plugins, or cgo compilation.
4. BundleReader validates schema compatibility, length-prefixed content digest, every content hash, module and package reference, build-profile completeness, and maximum limits before producing ProjectSnapshot. Unknown fields may be retained for forward compatibility, but an unknown required schema version fails closed.
5. Make ProjectSnapshot a plain-data domain object. It contains no browser handles, OS paths, Go runtime pointers, ASTs, or mutable caches. It is the only input to the analysis kernel and evidence adapters.

## Constraints

- Browser code does not implement MVS, go list semantics, workspace selection, or full build constraint resolution for Project Evidence.
- A raw module archive can provide Module View evidence, but cannot be upgraded implicitly into a native-captured snapshot.
- Bundle creation is local and optional; it adds no backend, account, source upload, or telemetry requirement.

## Acceptance criteria

- [ ] A native-captured fixture bundle agrees with its pinned Go toolchain on module graph, selected files, package imports, roots, GOOS, GOARCH, tags, cgo setting, and Go version.
- [ ] Identical inputs produce identical bundle digests; corrupt content, duplicate identifiers, missing source, undeclared package, schema mismatch, oversize bundle, and incomplete BuildProfile fail with typed diagnostics.
- [ ] Browser hydration produces byte-identical ProjectSnapshot values from the same bundle without relying on browser file paths or globals.
- [ ] A Module View fixture cannot request reachability, while the equivalent native-captured project fixture can reach the kernel input boundary entirely offline.
- [ ] The companion's data-flow test proves it neither executes application code nor emits credentials or absolute local paths.

## Technical approach

1. Lay of the Land: define the stable bundle schema from a native package-loader fixture and write schema compatibility rules before parser code.
2. Tracer Bullet: run the companion on a two-package main module, drag the resulting bundle into a worker, validate hashes, and display the ProjectSnapshot summary.
3. Hot Path Exploration: add module, package, source, profile, and diagnostics sections; deterministic writer; reader; and browser hydration.
4. Safe Passage: differential-test bundle metadata against pinned Go versions, fuzz readers, test path and secret scrubbing, and reject resource exhaustion.
5. Closing Review: publish the supported producer versions and migration policy; defer unsupported Go semantics instead of emulating them in JavaScript.

## Execution checklist

- [ ] Define AnalysisBundle v1, BuildProfile, ProjectSnapshot, and typed diagnostics as the sole cross-layer contract.
- [ ] Build native companion capture and deterministic bundle reader before adding browser reachability behavior.
- [ ] Add bundle schema, digest, native-oracle, privacy, and corrupted-input fixtures.

## Verification

- [ ] Go unit, fuzz, golden, and property tests for writer, reader, digest, and bundle schema.
- [ ] Native Go package-loader comparison for all supported profiles.
- [ ] Browser integration test for offline bundle hydration and Module View reachability rejection.
- [ ] go test -race and go vet for the companion and shared domain packages.

## Validation evidence

_Not recorded yet._

## Outcome and follow-ups

_Not completed yet._

## Original request

Portable project snapshot and browser analysis foundation.
