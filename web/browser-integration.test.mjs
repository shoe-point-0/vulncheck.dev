import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTCPServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  discoverBrowserIntegrationFixturePaths,
  expectedBrowserIntegrationFixturePaths as stagingFixturePaths,
  staticFixtureSpecifiers
} from "../scripts/browser-integration-fixture.mjs";
import { stageBrowserIntegrationFixture } from "../scripts/stage-browser-integration-fixture.mjs";

const webRoot = dirname(fileURLToPath(import.meta.url));
const chromiumCandidates = Object.freeze([
  process.env.VULNCHECK_CHROMIUM_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium"
].filter(Boolean));
const firefoxCandidates = Object.freeze([
  process.env.VULNCHECK_FIREFOX_BIN,
  "/snap/firefox/current/usr/lib/firefox/firefox",
  "/usr/bin/firefox",
  "/snap/bin/firefox"
].filter(Boolean));
const geckoDriverCandidates = Object.freeze([
  process.env.VULNCHECK_GECKODRIVER_BIN,
  "/usr/bin/geckodriver",
  "/snap/bin/geckodriver"
].filter(Boolean));
const deployedBaselinePageURL = configuredDeployedBaselinePageURL();
const browserIntegrationFixturePaths = await discoverBrowserIntegrationFixturePaths();

test("real Chromium exercises the no-isolation baseline, bounded OPFS storage, controlled reload, and trusted consent", { timeout: 30_000 }, async (t) => {
  const result = await runBrowserScenario(t, { crossOriginIsolated: false });
  if (!result) return;
  assert.equal(result.service_worker.before_isolated, false);
  assert.equal(result.service_worker.after_isolated, false);
  assertBaselineIsolationHeaders(result);
  assert.notEqual(result.capability_report.selected_profile, "unavailable");
  assert.equal(result.storage.fallback_adapter, "in-memory-blob-storage");
  assert.equal(result.storage.fallback_profile, "baseline-worker");
  assertBoundedAnalysisWorker(result);
  recordBoundedAnalysisEvidence(t, result);
});

test("real Chromium selects the optional isolated profile without changing worker input authority", { timeout: 30_000 }, async (t) => {
  const result = await runBrowserScenario(t, { crossOriginIsolated: true });
  if (!result) return;
  assert.equal(result.service_worker.before_isolated, true);
  assert.equal(result.service_worker.after_isolated, true);
  assertIsolatedResponseHeaders(result);
  assert.equal(result.capability_report.selected_profile, "isolated-parallel");
  assertBoundedAnalysisWorker(result);
  recordBoundedAnalysisEvidence(t, result);
});

test("real Firefox exercises the no-isolation baseline, bounded storage, controlled reload, and trusted consent", { timeout: 45_000 }, async (t) => {
  const result = await runFirefoxScenario(t, { crossOriginIsolated: false });
  if (!result) return;
  assert.equal(result.service_worker.before_isolated, false);
  assert.equal(result.service_worker.after_isolated, false);
  assertBaselineIsolationHeaders(result);
  assert.notEqual(result.capability_report.selected_profile, "unavailable");
  assert.equal(result.storage.fallback_adapter, "in-memory-blob-storage");
  assert.equal(result.storage.fallback_profile, "baseline-worker");
  assertBoundedAnalysisWorker(result);
  recordBoundedAnalysisEvidence(t, result);
});

test("real Firefox selects the optional isolated profile without changing worker input authority", { timeout: 45_000 }, async (t) => {
  const result = await runFirefoxScenario(t, { crossOriginIsolated: true });
  if (!result) return;
  assert.equal(result.service_worker.before_isolated, true);
  assert.equal(result.service_worker.after_isolated, true);
  assertIsolatedResponseHeaders(result);
  assert.equal(result.capability_report.selected_profile, "isolated-parallel");
  assertBoundedAnalysisWorker(result);
  recordBoundedAnalysisEvidence(t, result);
});

test("configured deployed origin records atomic two-engine non-isolated baseline evidence", { timeout: 90_000 }, async (t) => {
  if (!deployedBaselinePageURL) {
    t.skip("set VULNCHECK_DEPLOYED_ORIGIN to an HTTPS origin serving the browser integration fixture");
    return;
  }

  // The packet requires one two-engine record. Do not emit individually
  // passing browser output: it could be mistaken for complete deployment
  // evidence if the other required adapter or scenario then fails.
  const initialFixtureIntegrity = await verifyDeployedFixtureIntegrity(deployedBaselinePageURL);
  const chromium = await runChromiumPage(t, deployedBaselinePageURL, { requireAvailable: true });
  assertDeployedBaselineEvidence(chromium, deployedBaselinePageURL);
  const firefox = await runFirefoxPage(t, deployedBaselinePageURL, { requireAvailable: true });
  assertDeployedBaselineEvidence(firefox, deployedBaselinePageURL);
  const finalFixtureIntegrity = await verifyDeployedFixtureIntegrity(deployedBaselinePageURL);
  assertFixtureIntegrityStable(initialFixtureIntegrity, finalFixtureIntegrity);
  recordDeployedEvidence(t, { chromium, firefox }, deployedBaselinePageURL, initialFixtureIntegrity, finalFixtureIntegrity);
});

test("deployment fixture integrity accepts the reviewed runtime closure", async (t) => {
  const staticServer = await startStaticServer({ crossOriginIsolated: false });
  t.after(() => staticServer.close());

  const pageURL = `http://127.0.0.1:${staticServer.port}/browser-integration-page.html?isolation=absent`;
  const integrity = await verifyDeployedFixtureIntegrity(pageURL);
  assert.deepEqual(integrity.files.map((file) => file.path), browserIntegrationFixturePaths);
  for (const file of integrity.files) {
    assert.match(file.sha256, /^sha256:[0-9a-f]{64}$/);
  }
});

test("deployment fixture manifest matches the static page and worker runtime closure", () => {
  assert.deepEqual(browserIntegrationFixturePaths, stagingFixturePaths);
});

test("fixture stager uses the reviewed browser runtime closure", async () => {
  assert.deepEqual(await discoverBrowserIntegrationFixturePaths(), browserIntegrationFixturePaths);
  assert.deepEqual(stagingFixturePaths, browserIntegrationFixturePaths);
});

test("fixture staging creates an exact new reviewed deployment closure", async (t) => {
  const stagingParent = await mkdtemp(resolve(dirname(webRoot), ".fixture-staging-test-"));
  t.after(() => rm(stagingParent, { recursive: true, force: true }));
  const stagingDirectory = resolve(stagingParent, "candidate");

  const staged = await stageBrowserIntegrationFixture(stagingDirectory);
  assert.equal(staged.fixture_directory, stagingDirectory);
  assert.deepEqual(staged.files.map((file) => file.path), browserIntegrationFixturePaths);
  if (process.platform !== "win32") {
    const directory = await stat(stagingDirectory);
    assert.equal(directory.mode & 0o077, 0, "staging directory must not grant group or other access");
  }
  for (const file of staged.files) {
    const [source, target] = await Promise.all([
      readFile(resolve(webRoot, file.path)),
      readFile(resolve(stagingDirectory, file.path))
    ]);
    assert.deepEqual(target, source, `${file.path} must retain its reviewed bytes`);
    assert.match(file.sha256, /^sha256:[0-9a-f]{64}$/);
  }
  await assert.rejects(
    stageBrowserIntegrationFixture(stagingDirectory),
    /EEXIST/
  );
});

test("fixture staging refuses the reviewed source directory", async () => {
  await assert.rejects(
    stageBrowserIntegrationFixture(webRoot),
    /must be outside web/
  );
});

test("fixture staging refuses a symlinked destination parent that resolves into reviewed source", async (t) => {
  const stagingParent = await mkdtemp(resolve(dirname(webRoot), ".fixture-staging-parent-test-"));
  t.after(() => rm(stagingParent, { recursive: true, force: true }));
  const sourceAlias = resolve(stagingParent, "reviewed-source-alias");
  await symlink(webRoot, sourceAlias);

  await assert.rejects(
    stageBrowserIntegrationFixture(resolve(sourceAlias, "candidate")),
    /must be outside web/
  );
  await assert.rejects(access(resolve(webRoot, "candidate")));
});

test("deployment fixture discovery rejects unresolved runtime imports", () => {
  assert.throws(
    () => staticFixtureSpecifiers("fixture.mjs", "const worker = new Worker(workerURL);"),
    /unresolved worker runtime reference/
  );
  assert.throws(
    () => staticFixtureSpecifiers("fixture.mjs", "void import(\"./unexpected.mjs\");"),
    /does not permit dynamic imports/
  );
});

test("deployment fixture discovery follows every static module re-export", () => {
  assert.deepEqual(
    staticFixtureSpecifiers("fixture.mjs", [
      "export * from \"./all.mjs\";",
      "export { default as named } from \"./named.mjs\";",
      "export * as namespace from \"./namespace.mjs\";"
    ].join("\n")),
    ["./all.mjs", "./named.mjs", "./namespace.mjs"]
  );
});

test("configured deployment evidence requires every browser adapter", () => {
  assert.throws(
    () => requireEvidenceTool("Chromium unavailable; checked /candidate/chromium"),
    /configured deployed-origin evidence requires Chromium unavailable/
  );
  assert.throws(
    () => requireEvidenceTool("Firefox WebDriver unavailable; checked Firefox: /candidate/firefox; geckodriver: /candidate/geckodriver"),
    /configured deployed-origin evidence requires Firefox WebDriver unavailable/
  );
});

test("deployment fixture integrity rejects a modified runtime file", async (t) => {
  const modifiedServiceWorker = await readFile(resolve(webRoot, "browser-integration-sw.mjs"));
  modifiedServiceWorker[0] ^= 0x01;
  const staticServer = await startStaticServer({
    crossOriginIsolated: false,
    fixtureOverrides: new Map([["browser-integration-sw.mjs", modifiedServiceWorker]])
  });
  t.after(() => staticServer.close());

  const pageURL = `http://127.0.0.1:${staticServer.port}/browser-integration-page.html?isolation=absent`;
  await assert.rejects(verifyDeployedFixtureIntegrity(pageURL), /does not match the reviewed fixture/);
});

test("deployment evidence rejects fixture churn between browser engines", () => {
  const initial = Object.freeze({
    origin: "https://candidate.example",
    files: Object.freeze([Object.freeze({ path: "browser-integration-page.html", sha256: "sha256:initial" })])
  });
  const changed = Object.freeze({
    origin: "https://candidate.example",
    files: Object.freeze([Object.freeze({ path: "browser-integration-page.html", sha256: "sha256:changed" })])
  });
  assert.throws(
    () => assertFixtureIntegrityStable(initial, changed),
    /changed while the two-engine deployment evidence was running/
  );
});

async function runBrowserScenario(t, { crossOriginIsolated }) {
  const staticServer = await startStaticServer({ crossOriginIsolated });
  const pageURL = `http://127.0.0.1:${staticServer.port}/browser-integration-page.html?isolation=${crossOriginIsolated ? "required" : "absent"}`;
  t.after(() => staticServer.close());
  return runChromiumPage(t, pageURL);
}

async function runChromiumPage(t, pageURL, { requireAvailable = false } = {}) {
  const chromium = await findExecutable(chromiumCandidates);
  if (!chromium) {
    skipOrRequireEvidenceTool(t, requireAvailable, `Chromium unavailable; checked ${chromiumCandidates.join(", ")}`);
    return undefined;
  }

  const profileDirectory = await mkdtemp(resolve(tmpdir(), "vulncheck-browser-test-"));
  const debuggingPort = await reservePort();
  const browser = spawn(chromium, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-allow-origins=*",
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    pageURL
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  browser.stderr.setEncoding("utf8");
  browser.stderr.on("data", (chunk) => { stderr += chunk; });

  let connection;
  t.after(async () => {
    connection?.close();
    await stopBrowser(browser);
    await rm(profileDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const target = await waitForPageTarget(debuggingPort, pageURL, () => stderr);
  connection = await connectCDP(target.webSocketDebuggerUrl);
  await waitForBrowserState(connection, "awaiting-consent", () => stderr);
  const button = await evaluate(connection, `(() => {
    const rect = document.querySelector("#accept-public-module")?.getBoundingClientRect();
    return rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert.ok(button?.x > 0 && button?.y > 0, "browser integration consent button was not rendered");
  await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: button.x, y: button.y, button: "left", clickCount: 1 });
  await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: button.x, y: button.y, button: "left", clickCount: 1 });
  await waitForBrowserState(connection, "passed", () => stderr);

  return parseIntegrationResult(await evaluate(connection, "document.querySelector('#results').textContent"));
}

// Firefox has no Chrome DevTools Protocol input domain. The WebDriver path
// deliberately exercises the same page through a user-level element click so
// the consent controller still receives a real trusted browser event.
async function runFirefoxScenario(t, { crossOriginIsolated }) {
  const staticServer = await startStaticServer({ crossOriginIsolated });
  const pageURL = `http://127.0.0.1:${staticServer.port}/browser-integration-page.html?isolation=${crossOriginIsolated ? "required" : "absent"}`;
  t.after(() => staticServer.close());
  return runFirefoxPage(t, pageURL);
}

async function runFirefoxPage(t, pageURL, { requireAvailable = false } = {}) {
  const [firefox, geckoDriver] = await Promise.all([
    findExecutable(firefoxCandidates),
    findExecutable(geckoDriverCandidates)
  ]);
  if (!firefox || !geckoDriver) {
    skipOrRequireEvidenceTool(t, requireAvailable, `Firefox WebDriver unavailable; checked Firefox: ${firefoxCandidates.join(", ")}; geckodriver: ${geckoDriverCandidates.join(", ")}`);
    return undefined;
  }

  const driverPort = await reservePort();
  // Let geckodriver create and remove its own fresh temporary profile. Passing
  // a host-created profile through a strictly confined Firefox package can
  // prevent its startup preferences from being written.
  const driver = spawn(geckoDriver, ["--port", String(driverPort), "--profile-root", tmpdir()], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  driver.stderr.setEncoding("utf8");
  driver.stderr.on("data", (chunk) => { stderr += chunk; });
  let sessionID;

  t.after(async () => {
    if (sessionID) await deleteWebDriverSession(driverPort, sessionID);
    await stopBrowser(driver);
  });

  await waitForWebDriver(driverPort, () => stderr);
  sessionID = await createFirefoxSession(driverPort, firefox);
  await webDriverRequest(driverPort, "POST", `/session/${sessionID}/url`, { url: pageURL });
  await waitForFirefoxState(driverPort, sessionID, "awaiting-consent", () => stderr);
  const consentButton = await webDriverRequest(driverPort, "POST", `/session/${sessionID}/element`, {
    using: "css selector",
    value: "#accept-public-module"
  });
  const elementID = consentButton["element-6066-11e4-a52e-4f735466cecf"];
  assert.equal(typeof elementID, "string", "Firefox did not expose the consent button");
  await webDriverRequest(driverPort, "POST", `/session/${sessionID}/element/${elementID}/click`, {});
  await waitForFirefoxState(driverPort, sessionID, "passed", () => stderr);

  return parseIntegrationResult(await evaluateFirefox(driverPort, sessionID, "return document.querySelector('#results').textContent;"));
}

function skipOrRequireEvidenceTool(t, requireAvailable, message) {
  if (requireAvailable) requireEvidenceTool(message);
  t.skip(message);
}

function requireEvidenceTool(message) {
  throw new Error(`configured deployed-origin evidence requires ${message}`);
}

function parseIntegrationResult(serializedResult) {
  const result = JSON.parse(serializedResult);
  assert.equal(result.service_worker.controlled, true);
  assertIsolationHeaderObservation(result.service_worker.before_response_headers, "initial navigation");
  assertIsolationHeaderObservation(result.service_worker.after_response_headers, "service-worker-controlled navigation");
  assert.equal(result.storage.quota_failure, "storage-quota-exceeded");
  assert.equal(result.storage.concurrent_quota_failure, "storage-quota-exceeded");
  assert.equal(result.storage.cancelled_write, "input-cancelled");
  assert.equal(result.storage.stress_entries, 16);
  assert.equal(result.worker.bundle_result, "analysis-bundle-validated");
  assert.equal(result.worker.module_result, "module-view-planned");
  assertBoundedAnalysisWorker(result);
  assert.equal(result.consent.trusted_click, true);
  return result;
}

function assertIsolationHeaderObservation(headers, navigation) {
  assert.ok(headers && typeof headers === "object", `${navigation} must report isolation response headers`);
  for (const name of ["cross_origin_opener_policy", "cross_origin_embedder_policy"]) {
    assert.ok(Object.hasOwn(headers, name), `${navigation} must report ${name}`);
    assert.ok(headers[name] === null || typeof headers[name] === "string", `${navigation} must report ${name} as a string or null`);
  }
}

function assertBaselineIsolationHeaders(result) {
  const expected = {
    cross_origin_opener_policy: null,
    cross_origin_embedder_policy: null
  };
  assert.deepEqual(result.service_worker.before_response_headers, expected, "the baseline's initial navigation must be header-free");
  assert.deepEqual(result.service_worker.after_response_headers, expected, "the baseline's controlled navigation must be header-free");
}

function assertIsolatedResponseHeaders(result) {
  const expected = {
    cross_origin_opener_policy: "same-origin",
    cross_origin_embedder_policy: "require-corp"
  };
  assert.deepEqual(result.service_worker.before_response_headers, expected, "the isolated initial navigation must carry both isolation headers");
  assert.deepEqual(result.service_worker.after_response_headers, expected, "the isolated controlled navigation must carry both isolation headers");
}

function assertBoundedAnalysisWorker(result) {
  const analysis = result.worker.analysis;
  assert.equal(analysis.lifecycle, "completed", "the bounded worker must reach a completed lifecycle state");
  assert.equal(analysis.status, "inconclusive", "the tracer bullet must not claim reachability without a kernel");
  assert.equal(analysis.transport, "transferable-message", "the baseline protocol must remain available without shared memory");
  assert.ok(Number.isSafeInteger(analysis.progress_events) && analysis.progress_events > 0, "the bounded worker must emit progress");
  assert.ok(Number.isFinite(analysis.elapsed_ms) && analysis.elapsed_ms >= 0, "the browser matrix must retain elapsed worker evidence");
  assert.equal(analysis.concurrency.active_workers, 1, "the worker pool must remain bounded to its profiled baseline");
  assert.equal(analysis.concurrency.shared_memory_enabled, false, "shared-memory transport must remain disabled until its self-test and profile are retained");
  for (const measurement of [analysis.memory_before_bytes, analysis.memory_after_bytes]) {
    assert.ok(measurement === "unavailable" || (Number.isSafeInteger(measurement) && measurement >= 0), "browser memory evidence must be measured or explicitly unavailable");
  }
}

function recordBoundedAnalysisEvidence(t, result) {
  t.diagnostic(JSON.stringify({
    evidence_scope: "bounded one-worker browser tracer bullet",
    browser_profile: result.capability_report.selected_profile,
    analysis: result.worker.analysis
  }));
}

function assertDeployedBaselineEvidence(result, pageURL) {
  const origin = new URL(pageURL).origin;
  assert.equal(result.test_origin, origin, "the reported fixture origin must match the configured deployed origin");
  assert.equal(result.service_worker.before_isolated, false, "the deployed baseline must load without cross-origin isolation");
  assert.equal(result.service_worker.after_isolated, false, "service-worker control must not add cross-origin isolation to the deployed baseline");
  assertBaselineIsolationHeaders(result);
  assert.notEqual(result.capability_report.selected_profile, "unavailable", "the deployed baseline must select a usable capability profile");
  assert.equal(result.storage.fallback_adapter, "in-memory-blob-storage", "the deployed baseline must exercise the no-OPFS fallback");
  assert.equal(result.storage.fallback_profile, "baseline-worker", "the deployed baseline must exercise the one-worker fallback profile");
}

function assertFixtureIntegrityStable(initialFixtureIntegrity, finalFixtureIntegrity) {
  assert.deepEqual(
    finalFixtureIntegrity,
    initialFixtureIntegrity,
    "the reviewed deployment fixture changed while the two-engine deployment evidence was running"
  );
}

function recordDeployedEvidence(t, results, pageURL, initialFixtureIntegrity, finalFixtureIntegrity) {
  t.diagnostic(JSON.stringify({
    evidence_scope: "two-engine deployed non-isolated baseline",
    page_url: pageURL,
    initial_fixture_integrity: initialFixtureIntegrity,
    final_fixture_integrity: finalFixtureIntegrity,
    engines: Object.freeze(Object.fromEntries(Object.entries(results).map(([browser, result]) => [browser, Object.freeze({
      test_origin: result.test_origin,
      user_agent: result.user_agent,
      capability_report: result.capability_report,
      service_worker: result.service_worker,
      storage: result.storage,
      worker: result.worker,
      consent: result.consent
    })])))
  }));
}

async function verifyDeployedFixtureIntegrity(pageURL) {
  const origin = new URL(pageURL).origin;
  const files = [];
  for (const path of browserIntegrationFixturePaths) {
    const expected = await readFile(resolve(webRoot, path));
    const response = await fetch(new URL(`/${path}`, origin), {
      cache: "no-store",
      credentials: "omit",
      redirect: "error"
    });
    if (!response.ok) {
      throw new Error(`deployed fixture ${path} returned HTTP ${response.status}`);
    }
    const observed = await readBoundedFixtureResponse(response, expected.byteLength, path);
    if (!observed.equals(expected)) {
      throw new Error(`deployed fixture ${path} does not match the reviewed fixture`);
    }
    files.push(Object.freeze({
      path,
      sha256: `sha256:${createHash("sha256").update(expected).digest("hex")}`
    }));
  }
  return Object.freeze({
    origin,
    files: Object.freeze(files)
  });
}

async function readBoundedFixtureResponse(response, expectedBytes, path) {
  if (!response.body) {
    throw new Error(`deployed fixture ${path} has no response body`);
  }
  const output = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    if (bytes.byteLength > expectedBytes - offset) {
      throw new Error(`deployed fixture ${path} exceeds its reviewed byte length`);
    }
    bytes.copy(output, offset);
    offset += bytes.byteLength;
  }
  if (offset !== expectedBytes) {
    throw new Error(`deployed fixture ${path} has ${offset} bytes; expected ${expectedBytes}`);
  }
  return output;
}

function configuredDeployedBaselinePageURL() {
  const value = process.env.VULNCHECK_DEPLOYED_ORIGIN;
  if (value === undefined || value === "") return undefined;

  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("VULNCHECK_DEPLOYED_ORIGIN must be an HTTPS origin without a path, query, fragment, or credentials");
  }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("VULNCHECK_DEPLOYED_ORIGIN must be an HTTPS origin without a path, query, fragment, or credentials");
  }
  return new URL("/browser-integration-page.html?isolation=absent", origin).href;
}

async function findExecutable(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate, 1);
      return candidate;
    } catch {
      // Try the next explicit browser location.
    }
  }
  return undefined;
}

async function startStaticServer({ crossOriginIsolated, fixtureOverrides } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      const decodedPath = decodeURIComponent(pathname);
      const filePath = resolve(webRoot, `.${decodedPath === "/" ? "/browser-integration-page.html" : decodedPath}`);
      if (relative(webRoot, filePath).startsWith(`..${sep}`) || relative(webRoot, filePath) === "..") {
        response.writeHead(404).end();
        return;
      }
      const fixturePath = relative(webRoot, filePath).split(sep).join("/");
      const contents = fixtureOverrides?.get(fixturePath) ?? await readFile(filePath);
      response.writeHead(200, {
        "content-type": contentType(filePath),
        "cache-control": "no-store",
        ...(crossOriginIsolated ? {
          "cross-origin-opener-policy": "same-origin",
          "cross-origin-embedder-policy": "require-corp"
        } : {})
      });
      response.end(contents);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string", "browser integration server did not bind a TCP port");
  return Object.freeze({
    port: address.port,
    async close() {
      server.close();
      await once(server, "close");
    }
  });
}

function contentType(filePath) {
  if (extname(filePath) === ".html") return "text/html; charset=utf-8";
  if (extname(filePath) === ".mjs") return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

async function reservePort() {
  const server = createTCPServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string", "could not reserve a Chromium debugging port");
  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForPageTarget(port, pageURL, stderr) {
  return waitFor(async () => {
    let targets;
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    } catch {
      return undefined;
    }
    return targets.find((target) => target.type === "page" && target.url === pageURL);
  }, "Chromium did not expose the browser integration target", stderr);
}

async function waitForWebDriver(port, stderr) {
  return waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      if (!response.ok) return undefined;
      const status = await response.json();
      return status.value?.ready === true ? status : undefined;
    } catch {
      return undefined;
    }
  }, "Firefox WebDriver did not become ready", stderr, "Firefox WebDriver");
}

async function createFirefoxSession(port, firefox) {
  const session = await webDriverRequest(port, "POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "firefox",
        "moz:firefoxOptions": {
          binary: firefox,
          args: ["-headless"]
        }
      }
    }
  });
  assert.equal(typeof session.sessionId, "string", "Firefox WebDriver did not return a session id");
  return session.sessionId;
}

async function deleteWebDriverSession(port, sessionID) {
  try {
    await webDriverRequest(port, "DELETE", `/session/${sessionID}`);
  } catch {
    // A browser crash or geckodriver shutdown can invalidate the session before
    // test cleanup; the dedicated temporary profile is still removed below.
  }
}

async function webDriverRequest(port, method, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json; charset=utf-8" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Firefox WebDriver returned a non-JSON response for ${method} ${pathname}`);
  }
  if (!response.ok || payload.value?.error) {
    throw new Error(`Firefox WebDriver request ${method} ${pathname} failed: ${payload.value?.message ?? response.status}`);
  }
  return payload.value;
}

async function evaluateFirefox(port, sessionID, script) {
  return webDriverRequest(port, "POST", `/session/${sessionID}/execute/sync`, { script, args: [] });
}

async function waitForFirefoxState(port, sessionID, expected, stderr) {
  return waitFor(async () => {
    try {
      const state = await evaluateFirefox(port, sessionID, "return document.body.dataset.testState;");
      if (state === "failed") {
        throw new Error(await evaluateFirefox(port, sessionID, "return document.querySelector('#results').textContent;"));
      }
      return state === expected ? state : undefined;
    } catch (error) {
      if (String(error?.message).startsWith("{")) throw error;
      return undefined;
    }
  }, `Firefox integration did not reach ${expected}`, stderr, "Firefox WebDriver");
}

async function connectCDP(url) {
  const socket = new WebSocket(url);
  await Promise.race([
    once(socket, "open"),
    once(socket, "error").then(([error]) => Promise.reject(error))
  ]);
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const resolver = pending.get(message.id);
    if (!resolver) return;
    pending.delete(message.id);
    if (message.error) resolver.reject(new Error(`${message.error.message} (${message.error.code})`));
    else resolver.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const { reject } of pending.values()) reject(new Error("Chromium CDP connection closed"));
    pending.clear();
  });
  return Object.freeze({
    send(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    }
  });
}

async function evaluate(connection, expression) {
  const response = await connection.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

async function waitForBrowserState(connection, expected, stderr) {
  return waitFor(async () => {
    try {
      const state = await evaluate(connection, "document.body.dataset.testState");
      if (state === "failed") {
        throw new Error(await evaluate(connection, "document.querySelector('#results').textContent"));
      }
      return state === expected ? state : undefined;
    } catch (error) {
      if (String(error?.message).startsWith("{")) throw error;
      return undefined;
    }
  }, `browser integration did not reach ${expected}`, stderr);
}

async function waitFor(operation, message, stderr, logName = "Chromium") {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${message}; ${logName} stderr: ${stderr().slice(-2_000)}`);
}

async function stopBrowser(browser) {
  if (browser.exitCode !== null || browser.signalCode !== null) return;
  browser.kill("SIGTERM");
  await Promise.race([
    once(browser, "exit"),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
  if (browser.exitCode === null && browser.signalCode === null) browser.kill("SIGKILL");
}
