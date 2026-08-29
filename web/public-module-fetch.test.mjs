import assert from "node:assert/strict";
import test from "node:test";

import { fetchAuthorizedModuleArchive } from "./public-module-fetch.mjs";
import { authorizePublicModuleRetrieval, planModuleRoute } from "./public-module-retrieval.mjs";

const location = Object.freeze({ pathname: "/m/example.com/demo@v1.2.3", search: "", hash: "" });

function authorization(budget = {}) {
  const plan = planModuleRoute(location, {
    cache_status: "missing",
    selected_endpoint: "https://proxy.example.test",
    budget
  });
  return authorizePublicModuleRetrieval(plan, {
    accepted: true,
    selected_endpoint: "https://proxy.example.test",
    module_path: "example.com/demo"
  });
}

test("fetches exactly the consented archive in a worker with bounded credential-free options", async () => {
  const archive = new Blob([new Uint8Array([1, 2, 3])]);
  const calls = [];
  const result = await fetchAuthorizedModuleArchive(authorization(), {
    async fetchAPI(url, options) {
      calls.push({ url, options });
      return new Response(archive, { status: 200, headers: { "content-length": "3" } });
    }
  });
  assert.equal(result.archive.size, 3);
  assert.deepEqual(result.coordinate, { path: "example.com/demo", version: "v1.2.3" });
  assert.equal(result.source_endpoint, "https://proxy.example.test");
  assert.equal(result.transfer_bytes, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://proxy.example.test/example.com/demo/@v/v1.2.3.zip");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.referrerPolicy, "no-referrer");
});

test("rejects declared and streamed transfers above the consented limit before archive validation", async () => {
  const smallAuthorization = authorization({ maxBytes: 2 });
  await assert.rejects(fetchAuthorizedModuleArchive(smallAuthorization, {
    async fetchAPI() {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-length": "3" } });
    }
  }), { code: "module-fetch-limit" });

  let cancelled = false;
  const stream = {
    getReader() {
      return {
        async read() { return { done: false, value: new Uint8Array([1, 2, 3]) }; },
        async cancel() { cancelled = true; },
        releaseLock() {}
      };
    }
  };
  await assert.rejects(fetchAuthorizedModuleArchive(smallAuthorization, {
    async fetchAPI() {
      return { ok: true, redirected: false, body: stream, headers: { get() { return null; } } };
    }
  }), { code: "module-fetch-limit" });
  assert.equal(cancelled, true);
});

test("fails closed for unavailable workers, malformed responses, and cancellation without a request", async () => {
  await assert.rejects(fetchAuthorizedModuleArchive(authorization(), { fetchAPI: undefined }), { code: "module-fetch-unavailable" });
  await assert.rejects(fetchAuthorizedModuleArchive(authorization(), {
    async fetchAPI() { return new Response("not found", { status: 404 }); }
  }), { code: "module-fetch-response-invalid" });

  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(fetchAuthorizedModuleArchive(authorization(), {
    signal: controller.signal,
    async fetchAPI() { called = true; throw new Error("must not run"); }
  }), { code: "input-cancelled" });
  assert.equal(called, false);
});
