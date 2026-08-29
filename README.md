# vulncheck.dev

An evidence-first static workbench for Go module and project security evidence. It preserves local-code privacy, but it does not certify safety.

## Two clean workflows

| Workflow | Input | What it can say | What it will not say |
| --- | --- | --- | --- |
| Module View | A module coordinate, source archive, or canonical path URL such as /m/github.com/gin-gonic/gin@v1.9.0 | Canonical OSV version evaluation, provenance, freshness, and bounded source evidence | That a full project reaches or cannot reach a vulnerable symbol |
| Project Evidence | A local AnalysisBundle created by the companion | Exact captured BuildProfile, module and package graph, static reachability, and bundled native evidence | That static analysis proves the project safe |

The companion runs locally and creates a portable archive for the browser; it is not a backend and does not upload source. This makes Go build selection a single responsibility of the real Go toolchain rather than a second implementation in JavaScript.

A valid Module View path URL starts the local analysis flow immediately when its data is cached. On first public lookup it displays consent before contacting the selected proxy; routes are exact-version only so shared links remain reproducible.

## Core design

    module coordinate or archive  -> Module View -> OSV evidence report

    local Go project -> vulncheck bundle -> AnalysisBundle -> browser worker
                                                        |
                                                        v
                     pure Go analysis kernel + canonical OSV + native evidence
                                                        |
                                                        v
                                   provenance-rich Project Evidence report

The kernel consumes plain data only. Browser code owns input, worker lifecycle, storage, cache, and rendering. The companion owns native Go capture, gosec or govulncheck evidence, bundle creation, and verification. OPFS, isolation, SIMD, parallelism, and WebGPU remain optional accelerators.

## Current status

This repository is in architecture and story hardening. No analyzer, companion, or deployment has been implemented yet.

## Sprout plan

| Task | Purpose |
| --- | --- |
| [00 security contract](.sprout/tasks/00-security-trust-and-capability-contract.md) | Trust boundary, result language, and capability gates |
| [01 browser ingestion](.sprout/tasks/01-browser-runtime-opfs-storage.md) | Bounded module and bundle inputs with browser fallbacks |
| [02 bundle snapshot](.sprout/tasks/02-go-wasm-analysis-core.md) | Bundle v1 and deterministic ProjectSnapshot |
| [09 clean kernel](.sprout/tasks/09-analysis-bundle-and-clean-kernel.md) | Pure Go analysis with thin browser and companion adapters |
| [03 vulnerability intelligence](.sprout/tasks/03-osv-simd-vulnerability-matcher.md) | Canonical offline OSV evaluation |
| [04 worker execution](.sprout/tasks/04-multithreaded-worker-actor-mesh.md) | Cancellable, bounded browser execution |
| [05 native gosec evidence](.sprout/tasks/05-supply-chain-heuristics-and-diffing.md) | Pinned native source rules and snapshot delta |
| [06 workbench](.sprout/tasks/06-webgpu-callgraph-and-ui-workbench.md) | Accessible evidence presentation and optional graph |
| [07 privacy and delivery](.sprout/tasks/07-zero-backend-permalinks-and-airgap.md) | Sharing, offline mode, cache, and Pages deployment |
| [08 integrity](.sprout/tasks/08-reference-parity-and-release-integrity.md) | Parity corpus, signatures, reproducibility, and rollback |
| [Epic](.sprout/tasks/client-side-go-vulnerability-reachability-engine.md) | Cross-story outcome and release gates |

The supporting strategy is in [ROADMAP.md](ROADMAP.md). Run sprout list or sprout check to inspect and validate packets.

## Privacy and trust boundary

Module View public acquisition discloses a requested path to the selected proxy and requires consent. Project Evidence source remains local in the companion and browser. A static page cannot prove its own integrity if its delivery origin is compromised; strict air-gapped use requires previously verified assets plus a disconnected or firewall-restricted environment.
