<!-- sprout-task
{"schema_version":1,"id":"simplify-vulncheck-dev-around-a-clean-analysis-kernel","status":"implemented","created_at":"2026-08-23T05:41:09.009239628Z","implemented_at":"2026-08-23T05:49:54.63722391Z"}
-->

# Simplify vulncheck.dev around a clean analysis kernel

## Goal

Replace the remaining browser or toolchain coupling in the plan with a small pure analysis kernel, a local native-capture companion, two explicit assurance workflows, and canonical module deep links that start Module View safely.

## Context

The first hardening pass made the claims defensible but still assumed the browser should reproduce Go package resolution and host a gosec adapter. That is needlessly complex and less faithful than a local toolchain capture. The revised design preserves the static site and private browser workbench while assigning each environment one coherent job.

## Requirements

- Separate browser-only Module View from native-captured Project Evidence and make their assurance levels visible.
- Introduce AnalysisBundle v1, immutable ProjectSnapshot, pure Go analysis kernel, thin browser host, and local companion boundaries.
- Use pinned native gosec and govulncheck evidence in Project Evidence rather than loading their full engines into browser Wasm.
- Add a canonical route, /m/<module-path>@<exact-version>, that identifies a Module View page and starts cached or consent-gated analysis on direct navigation.
- Keep all changes to stories and architecture documents; do not claim implementation exists.

## Constraints

- Do not add a backend, daemon, source upload path, browser credential handling, or application-code execution.
- Do not promote Module View to Project Evidence, allow a URL to bypass network consent, or let a deep link contain latest, local paths, credentials, source, or private state.
- Keep browser platform accelerators optional and prevent storage, UI, or native-process APIs from leaking into the pure kernel.

## Acceptance criteria

- [x] The epic, roadmap, and README describe the two workflow contract and one-way assurance boundary.
- [x] A new task defines AnalysisBundle, pure kernel, thin adapters, and native or Wasm parity requirements.
- [x] Browser ingestion, snapshot, gosec, release, and UI stories agree on native capture and browser responsibilities.
- [x] Canonical ModulePage path routing, strict parsing, cache behavior, consent gate, and GitHub Pages deep-link fallback are specified and tested in acceptance criteria.
- [x] All active Sprout packets validate structurally.

## Technical approach

1. Lay of the Land: read the existing story set, identify duplicated toolchain and browser responsibilities, and verify Go package-loading or build-constraint documentation.
2. Tracer Bullet: define the minimal high-assurance vertical slice: local companion captures a two-package project to AnalysisBundle, browser worker hydrates ProjectSnapshot, pure kernel evaluates one local OSV record, and UI renders evidence.
3. Hot Path Exploration: add Module View versus Project Evidence, package boundaries, native gosec evidence, kernel API, release parity, and deep-link ModulePage contracts.
4. Safe Passage: require strict bundle and route parsing, content digests, native or Wasm golden parity, tool-output binding, consent-gated proxy access, and deployed Pages refresh testing.
5. Closing Review: validate every packet and record the migration away from browser package resolution and browser-hosted gosec.

## Execution checklist

- [x] Read the Sprout, principal-engineering, and Go engineering guidance, plus all affected packets before editing.
- [x] Create a Sprout refinement packet and identify the smallest trustworthy vertical slice.
- [x] Add native-captured AnalysisBundle and pure clean-kernel story; revise affected workflow packets.
- [x] Add canonical exact-version ModulePage deep-link contract and Pages fallback requirements.
- [x] Run packet validation and record evidence.

## Verification

- [x] sprout check passed tasks 00 through 09, the master epic, and this refinement packet.
- [x] Cross-document terminology check confirms Module View, Project Evidence, AnalysisBundle, ModuleRoute, and clean-kernel references agree.
- [x] Documentation-only scope confirmed: no product implementation, dependencies, deployment, or external state was changed.

## Validation evidence

- Design evidence: the clean core requires one plain-data contract boundary and a side-effect-free Analyze entry point. Browser, companion, bundle, evidence, and renderer responsibilities are separated into distinct stories and adapter tests.
- Go evidence: [go/packages](https://pkg.go.dev/golang.org/x/tools/go/packages) describes Go package metadata loading through its underlying build system; [Go build constraints](https://go.dev/cmd/go/) show that GOOS, GOARCH, cgo, release, and user tags affect file selection. A native-captured bundle therefore has a more faithful and smaller implementation boundary than browser reimplementation of these semantics.
- Tool evidence: [govulncheck](https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck) and [gosec](https://github.com/securego/gosec) remain pinned local reference or evidence producers, preserving raw results for browser inspection without moving their complete package loaders into browser Wasm.
- Route evidence: the ModulePage contract uses exact versions only, rejects malformed or encoded-separator routes before side effects, starts cache hits locally, and gates first public retrieval behind consent. GitHub Pages direct navigation is covered by a tested 404.html fallback because a service worker cannot bootstrap an initial deep path.

## Outcome and follow-ups

Completed the clean-implementation refinement. The plan now begins with a narrow Module View and a high-assurance companion-to-bundle-to-kernel tracer bullet. The next recommended implementation slice is Task 00 followed by Task 01's strict bundle reader and Task 02's Bundle v1 fixture; Task 09's native or Wasm golden parity follows before full reachability or UI acceleration. The main remaining tradeoff is intentional: Project Evidence asks for a local CLI, but gains true Go build selection, native gosec or govulncheck evidence, simpler browser code, and a much smaller trusted boundary.

## Original request

Push the design toward a cleaner implementation and add module-specific path URLs that trigger analysis safely.
