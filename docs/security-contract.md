# Security evidence contract

Version: `v1`  
Status: active prerequisite for every analysis producer and renderer

vulncheck.dev presents bounded static-analysis evidence. It does not certify a
module, project, package, organization, or change. A renderer may only use the
vocabularies and report shape in this document; it must not invent a stronger
conclusion from omitted, stale, malformed, unsupported, or incomplete data.

## Assurance boundary

`module-view` evaluates one exact module coordinate or bounded local archive.
It can present version and bounded source evidence, but project reachability is
`inconclusive` because there is no captured application graph.

`project-evidence` consumes a validated, native-captured AnalysisBundle. It
can present the captured build profile, module and package facts, static path
evidence, and bundled native evidence. It remains static evidence with declared
limitations.

## Result vocabularies

The serialized tokens below are stable v1 values. Human-readable UI labels must
retain their meaning and link to the input and diagnostic that produced them.

| Result | Allowed serialized values | Meaning |
| --- | --- | --- |
| Version | `affected`, `not-affected`, `unknown` | Canonical vulnerability-data version evaluation. `unknown` is required for malformed, unavailable, incompatible, or incomplete evaluation input. |
| Reachability | `reachable`, `no-static-path-found`, `inconclusive` | `reachable` requires a reproducible static trace. `no-static-path-found` describes the captured static input only. `inconclusive` is required for cancellation, unsupported semantics, incomplete capture, Module View scope, or analysis limits. |
| Source rule | `finding`, `suppressed-finding`, `no-finding`, `not-analyzed` | A `no-finding` result is not a security verdict. `not-analyzed` explicitly records an unavailable or inapplicable producer. |
| Integrity | `verified`, `unverified`, `failed` | `verified` is allowed only after both declared artifact and module checks pass. It verifies those declared checks, not the delivery origin or a broader claim. |

Freshness is separate from these outcomes: `current`, `stale`, or `unknown`.
Stale or unknown data must remain visible and cannot be silently upgraded to a
current evaluation.

## Prohibited presentation language

User-visible text must not call a result `safe`, `guaranteed`, `certified`, or
`remediated`, nor use equivalent language that turns static evidence into a
security verdict. In particular, `no-static-path-found` must never be relabeled
as dead or unreachable. The `contract.ValidateDisplayText` test gate rejects
the v1 prohibited labels.

The UI may say what was evaluated, what static trace was found, what was not
analyzed, and what additional evidence would reduce uncertainty. It must not
claim that analyzed code was executed, that an absence of evidence establishes
an absence of vulnerabilities, or that a rule result establishes exploitability.

## Report schema and provenance

The canonical machine-readable schema is
[analysis-report-v1.schema.json](../schemas/analysis-report-v1.schema.json).
The pure Go mirror is `contract.Report`; adapters validate it before sending or
rendering a report. Every report includes:

- schema version, assurance level, and timestamp;
- Go toolchain version and digest; GOOS, GOARCH, build tags, and cgo policy;
- dependency source and digest;
- vulnerability-database revision and digest;
- analyzer release digest;
- a v1 browser capability report with every feature observed, its selected
  profile, and its selected fallback;
- all four result vocabularies, freshness, and bounded diagnostics.

When a value is not available to an assurance level, it is recorded as the
literal `unknown` with an explanatory diagnostic rather than omitted or
guessed. Reports contain bounded metadata, references, and traces—not raw
source content, credentials, filesystem paths, browser handles, ASTs, or
mutable runtime state.

## Hostile-input and execution policy

Module archives, bundles, source, go.mod files, OSV records, permalink state,
cached data, and browser messages are hostile. Before parsing, each adapter
selects an input boundary and applies `contract.ResourceBudget`; it enforces
declared and observed byte limits, file count, path depth, nesting, CPU time,
memory, wall time, and compression ratio. The v1 hard ceilings are 64 MiB
input, 10,000 files, depth 32, nesting 8, five seconds CPU, 128 MiB memory, ten
seconds wall time, and a 100:1 compression ratio. A product setting may lower
these limits but cannot raise them without a reviewed contract revision.

An adapter must check cancellation before and during input work, reject
traversal and malformed text before passing it onward, preserve the failed
boundary as a diagnostic, and discard partial evidence unless its result is
explicitly marked inconclusive. Archive-specific container validation remains
the task 01 responsibility and must use these limits.

No browser or companion feature may execute analyzed Go code, cgo, build tools,
generators, plugins, or tests. The UI action gate permits only report display,
analysis requests, cancellation, local purge, and an explicit public-lookup
consent request. It does not permit source execution, automatic changes, or AI
rule features.

## Acquisition, privacy, and retention

A public module lookup discloses the requested path to the user-selected proxy.
Before the first request, the UI shows the exact endpoint, module path, and
transfer plan and records consent. A request is bound to that one endpoint; it
cannot silently fail over to another proxy. Browser authentication for private
modules is not offered.

Private code is accepted only from a user-selected directory, file upload, or
an already verified local cache. The current contract stores no source. Future
local source retention is session-only by default, visibly located, purgeable,
excluded from public service-worker caches, and must never appear in reports or
permalinks. Non-source report metadata is retained only for the active analysis
unless a future user-selected storage policy states its location and purge
behavior.

Offline mode disables acquisition. It may start only after required analyzer
assets, database data, and selected input are present and verified; an offline
egress attempt fails closed. Application-level policy cannot create a strict air
gap: verified assets must be used in an actually disconnected or
firewall-restricted environment.

## Delivery trust limit

A compromised site, Pages publisher, DNS record, or browser extension can
serve code that exfiltrates source before application-level network controls
run. GitHub Pages is therefore not an independent trust root. CSP,
service-worker caching, and URL fragments are defense in depth only. A strict
release claim requires a separately distributed verification key or native
verifier; task 08 owns that release evidence.

## Review and change control

Changes to vocabularies, report fields, hard ceilings, prohibited language, or
trust boundaries require a new schema version, regression fixtures, and a
security review record. Inconclusive paths must be added before a downstream
feature can report any stronger status.
