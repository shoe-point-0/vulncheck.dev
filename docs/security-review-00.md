# Task 00 security review record

Review date: 2026-08-22  
Scope: report vocabulary, hostile-input admission policy, acquisition policy,
browser capability selection, and the documented static-delivery trust limit.

## Adversarial checks

| Threat | Contract control | Regression evidence |
| --- | --- | --- |
| ZIP expansion bomb | declared and observed byte, compression-ratio, file-count, CPU, memory, and wall-time ceilings | `TestThreatModelFixturesFailClosed/zip_bomb` |
| Archive or bundle traversal | relative-path validation rejects traversal, absolute paths, separators, and excessive depth | `TestThreatModelFixturesFailClosed/path_traversal` |
| Malformed source | UTF-8 and byte limit boundary validation | `TestThreatModelFixturesFailClosed/malformed_source` |
| Cancellation | cancelled input work produces a typed failure before parsing continues | `TestThreatModelFixturesFailClosed/cancellation` |
| Stale vulnerability data | freshness is a distinct current, stale, or unknown result | `TestThreatModelFixturesFailClosed/stale_data` |
| Unverified assets | `verified` integrity requires both artifact and module checks | `TestThreatModelFixturesFailClosed/unverified_assets` |
| Offline network attempt | offline acquisition is denied; online acquisition is bound to one exact endpoint | `TestThreatModelFixturesFailClosed/offline_egress`, `TestAcquisitionPolicyUsesOnlyTheSelectedEndpoint` |
| Unsupported browser capability | detector records each feature and an explicit baseline or unavailable fallback | `web/capabilities.test.mjs` |
| Overstated result language | display-label test rejects the v1 prohibited labels | `TestProhibitedDisplayLanguageSnapshot` |

## Residual risks

- The limits are conservative initial ceilings, not measurements of every
  browser and device. Task 01 must enforce them during real streaming archive
  parsing and record browser resource behavior.
- The current capability detector is a host feature report; it does not prove
  that a deployed origin supplied isolation headers or that an optional feature
  remains usable after a browser implementation failure.
- A static page cannot authenticate its own bytes after a delivery-origin,
  publisher, DNS, or extension compromise. This remains open until task 08
  supplies independently verifiable release evidence.
- No source, bundle, OSV, or release parser has been implemented in this task.
  Task-specific parsers remain required to call the shared boundary policy and
  produce their own hostile-input tests.

## Waivers

No waivers were requested or approved. No unsupported condition is relabeled as
a stronger evidence state; it maps to a typed diagnostic and the applicable
`unknown`, `inconclusive`, `not-analyzed`, `unverified`, or `failed` status.
