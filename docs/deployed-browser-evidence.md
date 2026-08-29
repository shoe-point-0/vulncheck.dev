# Deployed browser capability evidence

Task 01 is not complete until this fixture has run at a real HTTPS static
origin. Loopback runs demonstrate the fixture and browser adapters; they do
not demonstrate an eventual static deployment's response headers, service
worker lifecycle, or capability selection.

Publish the exact `web/browser-integration-*` fixture files from the candidate
release at a dedicated HTTPS candidate origin without COOP or COEP response
headers. The origin must serve `browser-integration-page.html` and its sibling
modules unchanged and permit the page's same-origin service-worker
registration. The current fixture's service-worker scope is that origin's
root, so the candidate origin must not host unrelated application paths. Do
not point this command at a production origin, or at an origin with
credentials, a path, a query string, or a fragment.

To avoid manually selecting runtime files, stage the reviewed closure into a
new directory under an existing parent first. This command only writes that
new directory; it does not deploy, replace, or delete anything:

```sh
node scripts/stage-browser-integration-fixture.mjs /srv/staging/candidate-fixture
```

Publish the contents of that directory at the dedicated candidate origin's
root. The command emits the copied paths and SHA-256 digests; retain that JSON
with the later browser diagnostic. It creates an owner-only destination,
refuses an existing directory and any destination under `web/` (including one
reached through a symlinked parent), creates each target exclusively, then
checks every copied file against the reviewed source bytes both during and
after the copy. Staging makes manual publication reproducible, but it does not
establish delivery integrity or authorize a deployment.

Run the two-engine evidence command from a machine with Chrome or Chromium,
Firefox, and geckodriver available:

```sh
VULNCHECK_DEPLOYED_ORIGIN=https://candidate.example \
  node --test --test-name-pattern "configured deployed origin" web/browser-integration.test.mjs
```

With `VULNCHECK_DEPLOYED_ORIGIN` configured, either missing browser adapter is
a test failure, not a skip. The command therefore cannot be recorded as
two-engine deployment evidence unless Chromium and the Firefox-plus-geckodriver
path both ran successfully.

Before opening either browser, the command derives the static runtime closure
from the reviewed page, module imports and re-exports, worker, and
service-worker imports, then requires it to equal the reviewed manifest. It
fetches every resulting file from the configured origin. Each request is
credential-free, no-store, redirect-free, and read only up to the locally
reviewed byte length; every response must match the local fixture byte-for-byte.
It then starts each browser with a fresh profile,
navigates to the configured HTTPS origin, fetches the document without
credentials on both sides of the service-worker-controlled reload to record
its COOP and COEP response headers, records `crossOriginIsolated` before and
after that reload, exercises the one-worker and no-OPFS fallback paths, and
performs the same fixture-integrity check again. Only after Chromium and
Firefox both pass and the two ordered digest sets are identical does it print
one joint JSON diagnostic. It fails if a fixture file is missing, oversized,
altered, redirected, or changes during the run; either navigation sends COOP
or COEP; the response becomes isolated; the worker lifecycle cannot complete;
or the baseline fallback is unusable. Without
`VULNCHECK_DEPLOYED_ORIGIN`, the configured deployment test is skipped and produces
no deployment evidence.

Before updating the Task 01 packet, retain the full test output and record the
tested origin, timestamp, fixture-integrity paths and digests, both
response-header observations, browser user agents, and emitted JSON. Matching
the checkout's fixture bytes makes the browser result reproducible against that
candidate; it does not establish delivery integrity, release identity, WebKit
interoperability, physical browser-quota exhaustion, or a release-verification
trust root. Those limits remain owned by later task packets.
