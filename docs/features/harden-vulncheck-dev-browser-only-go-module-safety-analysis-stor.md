<!-- sprout-task
{"schema_version":1,"id":"harden-vulncheck-dev-browser-only-go-module-safety-analysis-stor","status":"implemented","created_at":"2026-08-23T05:12:49.036501922Z","implemented_at":"2026-08-23T05:39:11.412873752Z"}
-->

# Harden vulncheck.dev browser-only Go module safety analysis stories

## Goal

Audit the existing browser-only Go module safety strategy and turn it into an evidence-first, implementable Sprout roadmap that preserves static hosting and local-code privacy without claiming certainty the browser cannot provide.

## Context

The original seven stories contained valuable product ideas but treated COOP or COEP, ZIP decompression, browser threading, call-graph reachability, heuristic scores, air-gapped privacy, and static-host integrity as guaranteed. This audit compares those assumptions with the published browser and Go contracts and makes the necessary uncertainty, provenance, and fallback paths first-class.

## Requirements

- Review every existing task packet, the master epic, repository instructions, README, and roadmap before editing.
- Use Sprout workflow and validate the final packet structure.
- Preserve the zero-backend deployment intent while adding release integrity, native reference parity, gosec integration, and explicit non-goals.
- Keep this review focused on architecture and stories; do not imply an analyzer has been implemented.

## Constraints

- Do not change product code, deploy external services, or make an unsupported platform claim.
- Do not classify no static path, a clean rule scan, or a cached page as a safety guarantee.
- Preserve existing task identities where practical so future implementation work remains traceable.

## Acceptance criteria

- [x] Existing stories are reorganized into an ordered, evidence-first implementation plan with clear inputs, outputs, limitations, and verification gates.
- [x] The strategy explicitly incorporates an audited, pinned gosec adapter and pinned native govulncheck plus gosec parity corpus.
- [x] Browser-only assumptions have baseline fallbacks and deployed-origin capability checks.
- [x] README and roadmap explain the revised outcome, trust model, and primary sources.
- [x] Every active packet passes sprout check.

## Technical approach

1. Lay of the Land: read AGENTS.md, all eight original packets, the master epic, README, ROADMAP.md, and the selected Sprout, principal-engineer, and Go engineering guidance.
2. Tracer Bullet: identify the shortest defensible flow: uploaded local Go module, one worker, deterministic ProjectSnapshot, local canonical OSV record, provenance-rich result.
3. Hot Path Exploration: rewrite the stories around ProjectSnapshot and BuildProfile, canonical OSV evaluation, bounded workers, pinned gosec, accessible evidence UI, and privacy-preserving state.
4. Safe Passage: add trust contract and release-parity stories; remove claims that accelerators, heuristics, or static hosting prove security.
5. Closing Review: validate all packets with Sprout and record evidence, remaining risks, and the next implementation slice.

## Execution checklist

- [x] Read the relevant repository instructions, roadmap, README, and every existing task packet in full.
- [x] Run sprout doctor and sprout list before editing.
- [x] Research primary Go and browser documentation for the pivotal constraints.
- [x] Add a security contract story and a reference-parity or release-integrity story.
- [x] Rewrite the existing stories, master epic, README, and roadmap around verifiable decisions.
- [x] Normalize all packets to the Sprout schema and re-run validation.

## Verification

- [x] sprout doctor reported a healthy workspace and required Sprout skill discovery.
- [x] sprout check passed for 00 through 08, the master epic, and this audit packet.
- [x] Terminology audit confirms ProjectSnapshot, BuildProfile, govulncheck, gosec, and no-static-path-found are represented in the roadmap and appropriate stories.
- [x] Documentation-only scope confirmed: no implementation, dependency, or deployment changes were made.

## Validation evidence

- Repository evidence: AGENTS.md required the five Sprout phases; all original packet content was read before edits. The workspace initially contained planning documents only.
- Sprout evidence: sprout doctor and sprout list succeeded; final sprout check passed every active packet.
- Go evidence: [Go Modules Reference](https://go.dev/ref/mod) documents module ZIP constraints, GOPROXY endpoint form, MVS context, and module-path disclosure; [Go Vulnerability Database](https://go.dev/doc/security/vuln/database) documents the canonical static-compatible API, bulk data, OSV records, imports, platform fields, and review status; [govulncheck](https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck) documents source reachability and reflection, unsafe, interface, binary, and build-configuration limitations.
- Security-tool evidence: [gosec](https://github.com/securego/gosec) documents its AST, SSA, and taint analysis, rule IDs, JSON and SARIF output, suppression tracking, and module-loading behavior. The browser design therefore uses a pinned reviewed adapter, not the CLI or AI mode.
- Browser evidence: [cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/crossOriginIsolated) requires COOP and COEP response headers for SharedArrayBuffer; [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) makes synchronous handles worker-specific; [DecompressionStream](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream/DecompressionStream) provides compression streams but not ZIP-container validation; [showDirectoryPicker](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker) is experimental and non-baseline.

## Outcome and follow-ups

Completed the story and strategy hardening review. The revised plan has nine delivery stories: trust contract, browser ingestion, deterministic Go snapshot, canonical OSV intelligence, bounded workers, gosec and diffing, evidentiary workbench, privacy and static delivery, and reference parity or release integrity. The next implementation slice is Task 00 followed by the Task 01 local ZIP-to-go.mod tracer bullet. The main residual risk is fundamental: static hosting cannot independently authenticate the application bytes that analyze private code, so the release-verification story is a production gate rather than polish.

## Original request

Harden vulncheck.dev browser-only Go module safety analysis stories
