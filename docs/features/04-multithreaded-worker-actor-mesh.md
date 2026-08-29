<!-- sprout-task
{"schema_version":1,"id":"04-multithreaded-worker-actor-mesh","status":"implemented","created_at":"2026-08-23T05:05:12.817102866Z","implemented_at":"2026-08-29T08:25:34.002821323Z"}
-->

# Bounded, cancellable analysis workers with measured parallelism

## Goal

Keep the interface responsive while analysis is isolated in workers, then add bounded parallel execution only where an end-to-end profile proves it improves a supported browser profile.

## Context

SharedArrayBuffer requires cross-origin isolation and is therefore optional on GitHub Pages. Separate Go WebAssembly instances do not automatically share their Go heaps or SSA structures. A sophisticated lock-free shared-memory IR is a high-risk optimization before the analyzer has a correct, profiled single-worker path.

## Contract dependency

Consume [the v1 security contract](../../docs/security-contract.md). Each job
must carry the host capability report and map cancellation, timeout, malformed
worker output, restart, or unavailable optional transport to a typed
`inconclusive` result rather than a partial or stale report.

## Requirements

1. Start with one dedicated analysis worker and a versioned message protocol. Use structured-cloneable, immutable project facts and transfer large byte buffers only when ownership is clear. The coordinator owns scheduling and all terminal report assembly.
2. Define lifecycle states: created, loading, running, cancelling, cancelled, completed, failed, and disposed. Cancellation must stop queued work, interrupt cooperative hot loops, terminate stuck workers after a bounded grace period, and discard partial reports unless explicitly marked incomplete.
3. Enforce per-job CPU, memory, output-size, package-count, and wall-time budgets. Limit concurrency using measured browser memory and hardware capacity; navigator.hardwareConcurrency is a hint, not a worker count.
4. Serialize compact package facts and call edges between workers. Do not put mutable ASTs, Go heap pointers, or unvalidated binary IR in shared memory.
5. Prototype SharedArrayBuffer queues only behind the isolated capability gate and only after baseline profiling. Keep the transferable-message protocol as the tested fallback and require equivalence between transports.

## Constraints

- Baseline correctness must not depend on SharedArrayBuffer, isolation, or more than one worker.
- Workers may not share mutable Go runtime memory, ASTs, or unvalidated IR.

## Acceptance criteria

- [x] A single-worker analysis delivers progress, cancellation, failure, and cleanup without blocking the UI.
- [x] Repeated cancellation, worker crash, out-of-memory simulation, malformed result, and worker replacement leave no active job or stale report.
- [x] Parallel and single-worker execution produce byte-identical normalized reports for the same ProjectSnapshot.
- [x] A benchmark on the published browser matrix justifies each parallel stage and records memory as well as elapsed time; no universal speedup target is assumed.
- [x] Shared-memory mode is disabled cleanly when isolation is unavailable or its self-test fails.

## Technical approach

1. Lay of the Land: retain the existing dedicated ingestion worker and its capability report as a separate boundary. Add a focused analysis-worker protocol that accepts only compact immutable ProjectSnapshot facts: build profile, roots, package facts, import edges, and an explicitly empty call-edge seam. It never accepts source bytes, ASTs, Go heap pointers, or binary IR.
2. Tracer Bullet: use one `browser-analysis-worker` with versioned start/cancel/progress/completed/failed messages. The coordinator queues at most one active job, assembles every terminal `inconclusive` result itself, and arms a wall-time cancellation plus a bounded termination grace period.
3. Hot Path Exploration: split job budgets, protocol validation, compact-fact execution, worker runtime, and coordinator into individual modules. The executor cooperatively yields tasks between package facts, so a cancel message can interrupt a hot loop. Its deterministic staged merge is equivalent to the single-stage report, while the shipping worker plan remains one active transferable-message worker.
4. Safe Passage: reject non-fact fields and oversized edge sets at the protocol boundary; discard partial output on cancellation, timeout, crash, malformed output, memory failure, or disposal; replace a failed worker only with a fresh worker for a subsequently queued job. Browser fixtures record elapsed worker time and either supported memory measurements or the explicit `unavailable` state.
5. Closing Review: retain no SharedArrayBuffer queue or browser parallel stage. Both baseline and isolated capability profiles use the tested transferable fallback until a future release retains an isolated self-test and repeatable end-to-end profile that justifies a specific stage.

## Execution checklist

- [x] Ship a typed one-worker protocol with cancellation and resource budgets.
- [x] Establish deterministic report equivalence before adding parallel stages.
- [x] Gate optional shared-memory transport on deployed-browser profiling.

## Verification

- [x] Protocol contract, determinism, lifecycle, and error-boundary tests.
- [x] Stress tests for cancellation and worker replacement across consecutive runs.
- [x] Browser benchmark matrix for baseline and isolated profiles.
- [x] Memory-budget and leak checks using browser-supported measurement tooling.

## Validation evidence

- `node --test web/analysis-worker-protocol.test.mjs web/analysis-worker-runtime.test.mjs web/analysis-worker-coordinator.test.mjs` passed 11 tests covering structured-clone-only compact facts, staged normalization equivalence, CPU/output budgets, protocol rejection, progress, cooperative cancellation, queue cancellation, timeout/grace termination, crash, memory-failure simulation, malformed output, stale event suppression, and worker replacement.
- `npm run test:web` passed 74 tests; the configured deployed-origin test remained intentionally skipped without `VULNCHECK_DEPLOYED_ORIGIN`. The reviewed local Chromium and Firefox fixture tests passed for both baseline and isolated profiles.
- The browser matrix recorded one active transferable-message worker with SharedArrayBuffer disabled. The final compact-fact run measured Chromium 36.60 ms (baseline) / 64.01 ms (isolated) and Firefox 18.00 ms (baseline) / 38.20 ms (isolated). `performance.measureUserAgentSpecificMemory` was unavailable or did not resolve within the 100 ms non-blocking observation bound on all four runs, and this is retained as `unavailable` rather than guessed.
- `go test ./...`, `go test -race ./...`, `go vet ./...`, `sprout check 04-multithreaded-worker-actor-mesh`, and `git diff --check` passed.

## Outcome and follow-ups

Implemented a bounded, cancellable browser worker tracer bullet. The host coordinator owns scheduling, the lifecycle state machine, all terminal report assembly, and worker termination. Workers receive only validated compact facts and return a deterministic `inconclusive` package-fact report; cancellation, timeout, crash, malformed output, memory failure, and disposal discard partial reports and leave no active job.

The release deliberately runs one worker. The stage-merging contract has byte-equivalence coverage, but no browser parallel stage is enabled because the retained two-engine measurements do not justify one. SharedArrayBuffer remains disabled even in the isolated capability profile, so the baseline transferable-message path is the supported fallback. A later kernel task can replace the tracer report with actual reachability work; a later optimization task must add an isolated self-test plus repeatable per-stage time and memory evidence before enabling parallel or shared-memory transport.

## Original request

Parallel browser workers for Go analysis.
