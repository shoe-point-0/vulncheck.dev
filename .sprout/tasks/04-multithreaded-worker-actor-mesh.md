<!-- sprout-task
{"schema_version":1,"id":"04-multithreaded-worker-actor-mesh","status":"open","created_at":"2026-08-23T05:05:12.817102866Z"}
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

- [ ] A single-worker analysis delivers progress, cancellation, failure, and cleanup without blocking the UI.
- [ ] Repeated cancellation, worker crash, out-of-memory simulation, malformed result, and worker replacement leave no active job or stale report.
- [ ] Parallel and single-worker execution produce byte-identical normalized reports for the same ProjectSnapshot.
- [ ] A benchmark on the published browser matrix justifies each parallel stage and records memory as well as elapsed time; no universal speedup target is assumed.
- [ ] Shared-memory mode is disabled cleanly when isolation is unavailable or its self-test fails.

## Technical approach

1. Lay of the Land: profile the tracer bullet and map which stages are independent without compromising type information.
2. Tracer Bullet: run one cancellable parse-and-report job in a dedicated worker with a progress event and a hard timeout.
3. Hot Path Exploration: add a typed job protocol, resource accounting, bounded pool, deterministic merge, and optional transferable buffers.
4. Safe Passage: stress cancellation, termination, quota, panic, malformed worker output, and rapid start-stop cycles; then experiment with isolated shared memory.
5. Closing Review: retain only optimizations with repeatable browser-matrix evidence and document their fallback behavior.

## Execution checklist

- [ ] Ship a typed one-worker protocol with cancellation and resource budgets.
- [ ] Establish deterministic report equivalence before adding parallel stages.
- [ ] Gate optional shared-memory transport on deployed-browser profiling.

## Verification

- [ ] Protocol contract, determinism, lifecycle, and error-boundary tests.
- [ ] Stress tests for cancellation and worker replacement across consecutive runs.
- [ ] Browser benchmark matrix for baseline and isolated profiles.
- [ ] Memory-budget and leak checks using browser-supported measurement tooling.

## Validation evidence

_Not recorded yet._

## Outcome and follow-ups

_Not completed yet._

## Original request

Parallel browser workers for Go analysis.
