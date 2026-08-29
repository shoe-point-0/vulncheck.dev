<!-- sprout-task
{"schema_version":1,"id":"07-zero-backend-permalinks-and-airgap","status":"open","created_at":"2026-08-23T05:05:16.224476609Z"}
-->

# Privacy-preserving sharing, verified offline mode, and static delivery

## Goal

Provide bounded, versioned share state and a genuinely useful offline workflow while making the static-hosting and delivery-trust limits explicit.

## Context

A URL fragment is not sent in an HTTP request, but its contents can still be exposed by a user, browser extension, local history, or copied screenshot. showDirectoryPicker is secure-context, user-activation, and browser-support dependent; file upload and directory-upload fallbacks are necessary. GitHub Pages can serve static assets and a service worker, but cannot by itself make a compromised application unable to exfiltrate code.

## Contract dependency

Consume [the v1 security contract](../../docs/security-contract.md). Missing
offline prerequisites, invalid state, stale assets, and unverified manifests
must fail closed with the contract's explicit `inconclusive`, `unknown`,
`unverified`, or `failed` result and diagnostic. Offline mode must keep the
single-endpoint acquisition policy disabled.

## Requirements

1. Define a versioned, schema-validated permalink containing only minimum necessary reproducibility state: release ID, database revision, selected configuration, module coordinates or local snapshot identifiers, filters, and selected evidence IDs. Do not include source contents, tokens, local paths, raw findings, or notes by default. Require explicit confirmation before sharing sensitive optional annotations.
2. Compress only after schema validation and enforce encoded and decoded size, depth, field-count, and decompression-time limits. Unknown schema versions, invalid signatures where used, and oversized state fail closed with a non-destructive recovery option.
3. Support local source through a user-activated directory picker where available plus file or archive upload fallback. Store private source session-only by default, provide visible storage location and purge, and do not cache it in public service-worker caches.
4. Make offline mode a preflighted state: all analyzer, standard library, rule pack, OSV data, and selected module source must be verified and available first. Once active, acquisition is disabled and the UI tells the user that a real network disconnect or firewall is required for a strict air gap.
5. Deploy immutable release directories and a service-worker cache keyed by verified release manifest. Use a restrictive static policy with no third-party scripts, fonts, analytics, or network endpoints. Treat meta CSP and runtime guards as defense in depth when response headers are unavailable on Pages.
6. Support canonical direct ModulePage links on GitHub Pages using a tested 404.html static fallback that extracts only the path, redirects to the application shell, and preserves the route without trusting query data. Service-worker navigation handling is an optimization after installation, not the deep-link bootstrap mechanism.

## Constraints

- Permalinks exclude source and other sensitive data by default.
- A strict air-gap claim requires verified assets and environmental network isolation, not application policy alone.

## Acceptance criteria

- [ ] Permalink round-trip preserves the intended non-sensitive view state and rejects crafted, oversized, unknown-version, and decompression-bomb inputs.
- [ ] Local private source can be analyzed offline in supported browsers without a directory-picker dependency; session cleanup removes it on request.
- [ ] Browser integration tests with network disabled succeed only after verified prerequisite assets are cached and show a precise missing-asset diagnostic otherwise.
- [ ] Static deployment has no third-party runtime requests and cache updates cannot mix manifest versions.
- [ ] The privacy UI accurately distinguishes browser-local processing, public module metadata lookup, cached private source, and strict environmental air gap.
- [ ] A clean browser can open, refresh, and share a canonical ModulePage route on the deployed Pages origin; invalid paths render a local error without contacting a proxy.

## Technical approach

1. Lay of the Land: measure safe state sizes, enumerate local-storage APIs and support, and test the real Pages cache and service-worker lifecycle.
2. Tracer Bullet: round-trip a minimal fixture state and analyze one uploaded local module after explicitly switching to offline mode.
3. Hot Path Exploration: add bounded state codec, local acquisition fallbacks, cache manifest verification, and deployment workflow.
4. Safe Passage: fuzz the codec, test corrupt and mixed caches, browser offline mode, directory-denial, quota, and source purge.
5. Closing Review: publish a privacy data-flow diagram, offline prerequisites, key-management and rollback runbook, and the remaining Pages trust limitation.

## Execution checklist

- [ ] Define bounded non-sensitive state schema and codec failure behavior.
- [ ] Implement local-input fallbacks, private-source purge, and offline preflight.
- [ ] Add manifest-keyed cache and Pages deployment with rollback procedure.

## Verification

- [ ] State-codec unit, property, and fuzz tests.
- [ ] Browser offline, local-upload, purge, and cache-migration integration tests.
- [ ] Deployment test validates manifest, asset hashes, absence of third-party requests, and rollback.
- [ ] Manual strict-air-gap runbook verification in an actually disconnected environment.

## Validation evidence

_Not recorded yet._

## Outcome and follow-ups

_Not completed yet._

## Original request

Zero-backend sharing, private local analysis, offline operation, and GitHub Pages delivery.
