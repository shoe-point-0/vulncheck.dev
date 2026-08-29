# vulncheck.dev: clean, evidence-first implementation roadmap

## Outcome

vulncheck.dev is a static workbench with a deliberately narrow trust boundary. It offers a no-install Module View and an optional, higher-assurance Project Evidence workflow. Both produce evidence, never a safety certification.

| Assurance level | Producer | Browser result |
| --- | --- | --- |
| Module View | Browser from one module coordinate or archive | Canonical version status and source evidence; no project reachability |
| Project Evidence | Local companion captures an AnalysisBundle from the real Go environment | Version, static reachability, bundled native gosec and govulncheck evidence, and full provenance |

This is not a retreat from browser-local analysis. It moves environment-dependent Go package selection to the toolchain that already owns it, while the browser retains private report inspection and the same pure Go analysis kernel used by native tests.

## Clean boundaries

    Browser input or local companion
                 |
                 v
      AnalysisBundle v1 / ModuleInput
                 |
                 v
       immutable ProjectSnapshot
                 |
                 v
    pure analysis kernel <- canonical OSV database
                 |
                 v
          normalized AnalysisReport
                 |
                 v
    worker host, evidence reader, and UI

- Bundle and contract code know serialized data and validation, not workers, DOM, or Go AST internals.
- The analysis kernel knows ProjectSnapshot, AnalysisRequest, OSV data, context cancellation, and report events. It has no filesystem, network, process, storage, browser, or renderer dependency.
- The companion owns native capture, pinned tool invocation, bundle creation, and verification. It has no browser dependency.
- Browser adapters own archive input, ModuleRoute parsing, cache, worker lifecycle, Wasm bridge, and rendering. They do not implement Go module or package selection.

The principal kernel entry point is intentionally small:

    Analyze(context.Context, ProjectSnapshot, AnalysisRequest, Database, EventSink)
        returns AnalysisReport and error

This makes contract fixtures portable across native and Wasm execution, keeps cancellation explicit, and prevents UI or storage concerns from leaking into security decisions.

## ModulePage deep links

Canonical Module View pages use /m/<module-path>@<exact-version>, for example /m/github.com/gin-gonic/gin@v1.9.0. The host decodes the path exactly once, rejects encoded separators and malformed coordinates, then validates the resulting ModuleCoordinate again before analysis. A cached coordinate starts immediately; a cache miss starts a visible plan but requires consent before the selected public proxy receives the module path. The route never represents latest, private credentials, local paths, source, or Project Evidence.

GitHub Pages cannot serve arbitrary SPA paths directly, so 404.html is a minimal static route fallback that forwards validated path state to the application shell. It is tested by fresh direct navigation and refresh on the deployed domain; a service worker can improve later navigation but is not relied upon to bootstrap a deep link.

## Why native capture matters

Go package loading is build-profile dependent. GOOS, GOARCH, cgo, release tags, tool tags, and user tags all determine which files enter a build. The Go package loader is already responsible for reporting this selection. The companion captures that decision as data; it does not run application code, tests, generators, plugins, or cgo compilation. The browser validates the resulting bundle before it is eligible for Project Evidence.

Module View is intentionally different. It can inspect an exact module and evaluate known vulnerability records in a browser, but it cannot assert application-level reachability without a captured root and package graph.

## Delivery sequence

1. [Trust contract](.sprout/tasks/00-security-trust-and-capability-contract.md): freeze evidence language, resource limits, and prohibited claims.
2. [Browser ingestion](.sprout/tasks/01-browser-runtime-opfs-storage.md): deliver bounded ModuleInput and AnalysisBundleInput in one worker.
3. [Bundle snapshot](.sprout/tasks/02-go-wasm-analysis-core.md): define Bundle v1, native capture, validation, and immutable ProjectSnapshot.
4. [Clean kernel](.sprout/tasks/09-analysis-bundle-and-clean-kernel.md): run one pure analysis kernel natively and in Wasm with matching golden output.
5. [OSV evaluation](.sprout/tasks/03-osv-simd-vulnerability-matcher.md): add canonical offline version evaluation.
6. [Workers](.sprout/tasks/04-multithreaded-worker-actor-mesh.md): make the browser host cancellable and bounded; profile optional parallelism later.
7. [Native gosec evidence](.sprout/tasks/05-supply-chain-heuristics-and-diffing.md): bind pinned local gosec output to a bundle and add evidence-preserving diff.
8. [Workbench](.sprout/tasks/06-webgpu-callgraph-and-ui-workbench.md): make the report legible and accessible before optional graph rendering.
9. [Privacy and delivery](.sprout/tasks/07-zero-backend-permalinks-and-airgap.md): add bounded share state, offline preflight, manifest-keyed cache, and Pages deployment.
10. [Integrity](.sprout/tasks/08-reference-parity-and-release-integrity.md): block release on capture, kernel, reference-tool, reproducibility, and rollback proof.

## Rejected complexity

| Temptation | Clean decision |
| --- | --- |
| Reimplement Go's resolver, workspace rules, and build selection in browser code | Use a native-captured AnalysisBundle for Project Evidence; keep browser-only mode scoped to Module View. |
| Make gosec run inside browser Wasm | Run a pinned native gosec invocation locally, preserve raw evidence, and display it in the static workbench. |
| Let worker storage or UI state leak into analysis | Kernel consumes immutable plain data and returns normalized reports only. |
| Share Go AST or SSA memory between workers | Share only validated serialized facts; start with one worker. |
| Build a custom binary RPC framework | Use a versioned bundle boundary and ordinary typed data at layer seams; optimize only after profile evidence. |
| Treat Go package paths or local files as trusted | Validate and budget every archive and bundle entry; strip absolute paths and credentials during capture. |

## Release gates

A release is blocked unless all of the following hold:

- Module View and Project Evidence support matrices are separately published and all reports display their assurance level.
- Native capture matches the pinned Go package loader, bundle hydration preserves it, and native plus Wasm kernel fixtures produce identical normalized reports.
- Bundled govulncheck and gosec output match independent pinned invocations or have a documented unsupported status.
- Every archive, bundle, manifest, OSV, evidence, state-codec, and custom rule parser has fuzz and resource-limit evidence.
- Asset manifest, bundle schema, SBOM, licenses, toolchain or tool revisions, OSV freshness, cache migration, and rollback have been verified in a clean environment.
- The independently held release signature verifies. GitHub Pages deployment credentials cannot create a trusted release on their own.

## Primary technical references

- [Go Modules Reference](https://go.dev/ref/mod) defines module ZIP constraints, GOPROXY behavior, and privacy implications.
- [go/packages](https://pkg.go.dev/golang.org/x/tools/go/packages) describes package metadata loading and its underlying Go build-tool relationship.
- [Go build constraints](https://go.dev/cmd/go/) describe how GOOS, GOARCH, cgo, release, and user tags select files.
- [Go Vulnerability Database](https://go.dev/doc/security/vuln/database) defines canonical static-compatible endpoints, bulk data, OSV fields, affected imports, and review state.
- [govulncheck](https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck) documents source reachability and its reflection, unsafe, interface, binary, and build-configuration limitations.
- [gosec](https://github.com/securego/gosec) documents rule IDs, analysis modes, JSON or SARIF output, suppressions, and Go module package loading.
- [Cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/crossOriginIsolated), [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system), and [DecompressionStream](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream/DecompressionStream) describe optional browser runtime capabilities, not analysis correctness.

## Non-goals for the first production release

- Remote analysis service, account system, source upload, private-module authentication, or a listening local daemon.
- Browser reimplementation of Go workspace, resolver, and full build-selection semantics.
- Application-code execution, binary-only reachability claim, exploitability scoring, remediation certification, or automatic fixes.
- Performance promises without browser-matrix measurement and a corresponding correctness or usability benefit.
