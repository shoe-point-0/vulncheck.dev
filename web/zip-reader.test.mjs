import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { IngestionError } from "./ingestion-error.mjs";
import { readStrictZip } from "./zip-reader.mjs";
import { makeStoredZip, mutateZip } from "./test-zip.mjs";

test("reads a valid stored archive only after full container validation", async () => {
  const zip = makeStoredZip([
    { path: "src/", content: "" },
    { path: "src/main.go", content: "package main\n" },
    { path: "go.mod", content: "module example.com/demo\n" }
  ]);
  const result = await readStrictZip(zip, { boundary: "analysis-bundle" });
  assert.deepEqual(result.entries.map((entry) => entry.path), ["src/main.go", "go.mod"]);
  assert.equal(new TextDecoder().decode(result.entries[0].bytes), "package main\n");
});

test("reads raw-deflate entries with the browser decompression stream", async () => {
  const source = new TextEncoder().encode("package main\n");
  const zip = makeStoredZip([{ path: "main.go", bytes: source, method: 8, compressed: new Uint8Array(deflateRawSync(source)) }]);
  const result = await readStrictZip(zip);
  assert.equal(new TextDecoder().decode(result.entries[0].bytes), "package main\n");
});

test("rejects traversal, duplicates, crc mismatch, unsupported compression, and resource exhaustion", async () => {
  await assert.rejects(readStrictZip(makeStoredZip([{ path: "../private.go", content: "x" }])), { code: "zip-path-traversal" });
  await assert.rejects(readStrictZip(makeStoredZip([{ path: "a.go", content: "x" }, { path: "a.go", content: "y" }])), { code: "zip-path-duplicate" });
  await assert.rejects(readStrictZip(makeStoredZip([{ path: "dir/", content: "" }, { path: "dir", content: "x" }])), { code: "zip-path-duplicate" });
  await assert.rejects(readStrictZip(await mutateZip(makeStoredZip([{ path: "a.go", content: "x" }]), 14, 0)), { code: "zip-crc-invalid" });
  await assert.rejects(readStrictZip(await mutateZip(makeStoredZip([{ path: "a.go", content: "x" }]), 30 + 4 + 1 + 16, 0)), { code: "zip-central-directory-invalid" });
  await assert.rejects(readStrictZip(makeStoredZip([{ path: "a.go", content: "x", method: 12 }])), { code: "zip-compression-unsupported" });
  await assert.rejects(readStrictZip(makeStoredZip([{ path: "a.go", content: "xx" }]), { budget: { maxBytes: 1 } }), { code: "archive-limit" });
  await assert.rejects(readStrictZip(makeStoredZip([{ path: "a.go", content: "x" }, { path: "b.go", content: "y" }]), { budget: { maxFiles: 1 } }), { code: "archive-limit" });
  await assert.rejects(readStrictZip(makeStoredZip([{ path: "a.go", content: "x", method: 8, compressed: Uint8Array.of(1), uncompressedSize: 10 }]), { budget: { maxCompressionRatio: 2 } }), { code: "archive-limit" });
});

test("honors cancellation before archive bytes become visible", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readStrictZip(makeStoredZip([{ path: "a.go", content: "x" }]), { signal: controller.signal }), { code: "input-cancelled" });
});

test("fails closed when worker elapsed time reaches the conservative cpu ceiling", async () => {
  let clock = 0;
  await assert.rejects(readStrictZip(makeStoredZip([{ path: "a.go", content: "x" }]), {
    now: () => {
      clock += 6_000;
      return clock;
    }
  }), { code: "archive-limit" });
});

test("fuzz smoke keeps malformed zip bytes inside typed ingestion failures", async () => {
  let state = 0x5eed1234;
  for (let iteration = 0; iteration < 128; iteration += 1) {
    const length = state % 513;
    const bytes = new Uint8Array(length);
    for (let index = 0; index < bytes.length; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      bytes[index] = state & 0xff;
    }
    try {
      await readStrictZip(new Blob([bytes]));
    } catch (error) {
      assert.ok(error instanceof IngestionError, `unexpected fuzz error: ${error}`);
    }
  }
});
