<!-- sprout-task
{"schema_version":1,"id":"09-analysis-bundle-and-clean-kernel","status":"open","created_at":"2026-08-23T05:45:00.000000000Z"}
-->

# Clean analysis kernel and local companion boundary

## Goal

Establish a small, testable Go analysis kernel that runs unchanged in native tests and browser WebAssembly, with a thin browser host and a separate local companion for capture, native evidence, and verification.

## Context

The browser should present and analyze stable data, not own operating-system paths, module resolution, browser storage, DOM state, or full gosec loading. The companion should capture project facts, not turn into a server. One immutable AnalysisBundle contract lets each component have one reason to change.

## Contract dependency

Consume [the v1 security contract](../../docs/security-contract.md) as the
outer report vocabulary and provenance envelope. The kernel must return typed,
deterministic diagnostics and explicit `inconclusive`, `unknown`, or
`not-analyzed` outcomes for cancellation, unsupported semantics, incomplete
snapshots, and unavailable evidence; adapters must not reinterpret them.

## Requirements

1. Define five plain-data domain contracts in one versioned package: ModuleCoordinate, BuildProfile, ProjectSnapshot, AnalysisRequest, and AnalysisReport. Every value has a schema version and digest; reports include assurance level and cannot contain browser handles, paths, AST pointers, mutable maps exposed to callers, or unbounded raw source.
2. Implement a pure Go analysis kernel with one caller-oriented entry point:

    Analyze(context.Context, ProjectSnapshot, AnalysisRequest, Database, EventSink) returns AnalysisReport and error.

   The kernel performs deterministic version and reachability evaluation over supplied data. It performs no file I/O, network I/O, process execution, global configuration lookup, browser interop, storage mutation, or rendering. EventSink is bounded, cancellation-aware, and may be nil.
3. Keep host adapters thin. The browser worker owns acquisition, bundle hydration, Wasm lifecycle, cancellation, and report transport. The local companion owns Go package capture, native evidence invocation, bundle creation, and release or bundle verification. Neither imports the other's package.
4. Use package boundaries that mirror the contracts: internal or contract for data and validation, bundle for archive codec, analysis for pure evaluation, osv for canonical database access, evidence for native-result envelopes, cmd or companion for local commands, cmd or wasm for the WebAssembly main, and web for TypeScript host and UI. Interfaces are declared by their consumers and remain narrow.
5. Add deterministic serialization at the outer bundle boundary only. Do not serialize ASTs, SSA structures, Go heap state, or worker internals. Normalize report ordering and errors so native and Wasm tests can use the same golden fixtures.

## Constraints

- The first kernel build has no dependency on OPFS, SharedArrayBuffer, WebGPU, service workers, gosec loading, or the Go command.
- The local companion is optional for Module View but required for Project Evidence; it remains a local CLI with no listener, account, telemetry, or backend.
- No package may use a service locator, global mutable singleton, or cross-layer import to bypass the contract boundary.

## Acceptance criteria

- [ ] The same golden ProjectSnapshot yields byte-identical normalized AnalysisReport in native and browser Wasm execution.
- [ ] Unit tests instantiate the kernel entirely from in-memory values; attempts to access filesystem, network, process, or browser APIs are impossible by construction and checked in code review.
- [ ] Browser WorkerHost and local Companion adapters have independent contract tests using fake kernel or bundle dependencies, plus cancellation and failure tests.
- [ ] ModuleRoute parsing is host-owned, side-effect-free, and revalidated as ModuleCoordinate before a Module View request reaches the kernel.
- [ ] Public input and output errors are typed, actionable, lowercase, and preserve only declared domain information.
- [ ] A dependency-graph check shows acyclic direction from adapters to domain contracts and no browser package imported by Go analysis code.

## Technical approach

1. Lay of the Land: map imports and write contract golden fixtures before creating runtime adapters.
2. Tracer Bullet: run a synthetic ProjectSnapshot through the pure native kernel and a Wasm bridge, asserting the same report digest.
3. Hot Path Exploration: add canonical OSV, reachability, report events, bundle reader, companion capture, and browser host one boundary at a time.
4. Safe Passage: add cancellation, resource budgets, fuzzing, race tests, error-contract tests, and dependency-boundary enforcement.
5. Closing Review: review package graph, native or Wasm parity, public error contracts, and the absence of prohibited side effects.

## Execution checklist

- [ ] Freeze contract types and golden fixtures before adapter implementation.
- [ ] Implement pure kernel and native or Wasm tracer bullet with identical output.
- [ ] Build bundle, companion, and browser adapters around the contracts without cross-layer imports.
- [ ] Add boundary, cancellation, fuzz, race, golden, and package-graph checks.

## Verification

- [ ] Native and Wasm golden parity suite.
- [ ] go test, go test -race, go vet, fuzz smoke, and dependency-graph checks.
- [ ] Browser WorkerHost lifecycle, cancellation, and no-network integration tests.
- [ ] Companion bundle capture and verification tests with no application-code execution.

## Validation evidence

_Not recorded yet._

## Outcome and follow-ups

_Not completed yet._

## Original request

Clean, layered implementation for static browser and local Go analysis.
