import assert from "node:assert/strict";
import test from "node:test";

import { MemoryAnalysisStorage } from "./memory-storage.mjs";

test("stores bounded Blob input and purges one analysis namespace", async () => {
  const storage = new MemoryAnalysisStorage({ quotaBytes: 32 });
  await storage.put("analysis-1", "bundle", new Blob(["first"]));
  await storage.put("analysis-2", "bundle", new Blob(["second"]));
  assert.equal(await (await storage.get("analysis-1", "bundle")).text(), "first");

  await storage.purgeAnalysis("analysis-1");
  assert.equal(await storage.get("analysis-1", "bundle"), undefined);
  assert.equal(await (await storage.get("analysis-2", "bundle")).text(), "second");
  await storage.purge();
  assert.equal(storage.usedBytes, 0);
});

test("fails closed for quota pressure, cancellation, and use after close", async () => {
  const storage = new MemoryAnalysisStorage({ quotaBytes: 4 });
  await assert.rejects(storage.put("analysis-1", "bundle", new Blob(["five!"])), { code: "storage-quota-exceeded" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(storage.put("analysis-1", "bundle", new Blob(["one"]), { signal: controller.signal }), { code: "input-cancelled" });
  await storage.close();
  await assert.rejects(storage.get("analysis-1", "bundle"), { code: "storage-closed" });
});
