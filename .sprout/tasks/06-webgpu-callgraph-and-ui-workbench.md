<!-- sprout-task
{"schema_version":1,"id":"06-webgpu-callgraph-and-ui-workbench","status":"open","created_at":"2026-08-23T05:05:15.099530137Z"}
-->

# Evidentiary security workbench and optional graph acceleration

## Goal

Help an engineer inspect, reproduce, and challenge a finding through an accessible workbench. Graph rendering is optional presentation acceleration; it cannot change analysis or status semantics.

## Context

A force-directed call graph can be useful, but a 10,000-node animation is not a security control and may conceal important uncertainty. The workbench must make provenance, build configuration, evidence, incomplete analysis, and raw advisory or rule data easier to see than a risk score. Source text and permalink fields are untrusted and must never be injected as HTML.

## Contract dependency

Consume [the v1 security contract](../../docs/security-contract.md) verbatim
for result labels and provenance. Rendering must make `inconclusive`,
`no-static-path-found`, `unknown`, `not-analyzed`, `unverified`, and `failed`
visible with their diagnostics; no view, graph, or color may imply a stronger
claim.

## Requirements

1. Present four distinct evidence panels: dependency and integrity, vulnerability version evaluation, reachability trace and limitations, and source-rule findings. Show inconclusive and unsupported states at the same visual priority as reachable findings.
2. Provide deterministic table and path views before graph rendering. A selected path includes package, symbol, source span, edge kind, build configuration, and reason an edge is approximate or omitted.
3. Render source as inert text with bounded size, line numbers, stable source digest, and escaping. Never fetch editor extensions, execute embedded content, or expose unselected local source through a permalink.
4. Implement search, filtering, keyboard navigation, screen-reader labels, high-contrast colors, and reduced-motion behavior. Severity colors cannot be the only carrier of a result state.
5. Add Canvas or WebGL rendering only after the evidence views are correct. WebGPU layout is a progressive enhancement with device-loss handling and a tested fallback; it reads a normalized graph snapshot and has no access to raw analyzer memory.
6. Provide a ModulePage route at /m/<module-path>@<exact-version>. The page title, route target, cache status, assurance level, database freshness, and consent state are visible before analysis results. Resolve user-entered latest only after consent and replace it with an exact canonical route before it becomes shareable.

## Constraints

- Presentation and rendering failure cannot alter report content or security status.
- Source and permalink text are untrusted and are rendered only as bounded inert text.

## Acceptance criteria

- [ ] A user can reproduce every visible status from the displayed inputs and raw advisory or rule evidence without using the graph.
- [ ] Selecting a reachable finding shows a deterministic trace; selecting no-static-path-found or inconclusive shows the limitation and next diagnostic action.
- [ ] Source viewer and permalink adversarial-input tests demonstrate text escaping, length limits, and no executable content.
- [ ] Keyboard-only and assistive-technology smoke tests cover ingestion, result navigation, filters, path inspection, purge, and sharing confirmation.
- [ ] WebGPU, WebGL, and Canvas fallbacks produce the same selected-node and path semantics; rendering failure never changes a report.
- [ ] Direct navigation to a canonical ModulePage route shows its target and starts the appropriate cached or consent-gated Module View flow without exposing query, fragment, or local source data.

## Technical approach

1. Lay of the Land: validate the report schema with representative direct, uncertain, stale, and unsupported reports before choosing a renderer.
2. Tracer Bullet: render a small fixture as a provenance table, a call path, and escaped source text with no graph dependency.
3. Hot Path Exploration: add evidence panels, filtering, accessible navigation, normalized graph data, and progressive rendering.
4. Safe Passage: test device loss, reduced motion, narrow viewports, large graphs, malformed text, and all status combinations.
5. Closing Review: collect usability evidence that users can distinguish affected from reachable and inconclusive; retain GPU work only if measured.

## Execution checklist

- [ ] Build provenance table and path evidence views before graph work.
- [ ] Add accessible interactions and source escaping tests.
- [ ] Add renderer fallbacks and optional GPU acceleration after semantic equivalence passes.

## Verification

- [ ] Component, accessibility, source-escaping, and visual-regression tests.
- [ ] End-to-end tests for evidence trace, inconclusive state, purge, and share confirmation.
- [ ] Renderer equivalence and device-failure tests.
- [ ] Frame-time and memory measurements reported separately from security correctness.

## Validation evidence

_Not recorded yet._

## Outcome and follow-ups

_Not completed yet._

## Original request

Security workbench and optional call-graph visualization.
