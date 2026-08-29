import assert from "node:assert/strict";
import test from "node:test";

import { createModuleInput } from "./input.mjs";
import { hydrateModuleArchive, readModuleZip } from "./module-archive.mjs";
import { makeStoredZip } from "./test-zip.mjs";

const coordinate = Object.freeze({ path: "github.com/Azure/azure-sdk-for-go", version: "v1.2.3" });
const prefix = `${coordinate.path}@${coordinate.version}/`;

test("hydrates a module ZIP only when every entry has its canonical Go prefix", async () => {
  const archive = makeStoredZip([
    { path: prefix, content: "" },
    { path: `${prefix}go.mod`, content: "module github.com/Azure/azure-sdk-for-go\n" },
    { path: `${prefix}sdk/client.go`, content: "package sdk\n" }
  ]);

  const hydrated = await hydrateModuleArchive(createModuleInput({ archive }));
  assert.deepEqual(hydrated.coordinate, coordinate);
  assert.deepEqual(hydrated.entries.map((entry) => entry.path), ["go.mod", "sdk/client.go"]);

  const consentBound = await readModuleZip(archive, { coordinate });
  assert.deepEqual(consentBound.coordinate, coordinate);
});

test("rejects missing, mixed, escaped, and mismatched module ZIP prefixes", async () => {
  const valid = makeStoredZip([{ path: `${prefix}go.mod`, content: "module github.com/Azure/azure-sdk-for-go\n" }]);
  await assert.rejects(readModuleZip(makeStoredZip([{ path: "go.mod", content: "module example.com/demo\n" }])), { code: "module-zip-prefix-invalid" });
  await assert.rejects(readModuleZip(makeStoredZip([
    { path: `${prefix}go.mod`, content: "module github.com/Azure/azure-sdk-for-go\n" },
    { path: "example.com/other@v1.2.3/", content: "" }
  ])), { code: "module-zip-prefix-invalid" });
  await assert.rejects(readModuleZip(makeStoredZip([{ path: "github.com/!azure/azure-sdk-for-go@v1.2.3/go.mod", content: "module github.com/Azure/azure-sdk-for-go\n" }])), { code: "module-zip-prefix-invalid" });
  await assert.rejects(readModuleZip(valid, { coordinate: { path: "example.com/other", version: "v1.2.3" } }), { code: "module-zip-coordinate-mismatch" });
});
