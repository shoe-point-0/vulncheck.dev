import assert from "node:assert/strict";
import test from "node:test";

import { assertAnalysisInput, assertProjectEvidenceInput, createAnalysisBundleInput, createModuleInput, inputKind } from "./input.mjs";

test("models module and bundle workflows as disjoint input types", () => {
  const module = createModuleInput({ coordinate: { path: "example.com/mod", version: "v1.2.3" } });
  const bundle = createAnalysisBundleInput(new Blob(["bundle"]));

  assert.equal(module.kind, inputKind.module);
  assert.equal(bundle.kind, inputKind.analysisBundle);
  assert.throws(() => assertProjectEvidenceInput(module), { code: "project-evidence-required" });
  assert.doesNotThrow(() => assertProjectEvidenceInput(bundle));
});

test("rejects mixed, malformed, and unsupported browser-message inputs", () => {
  assert.throws(() => createModuleInput({ coordinate: { path: "example.com/mod", version: "v1.2.3" }, archive: new Blob() }), { code: "module-input-invalid" });
  assert.throws(() => assertAnalysisInput({ kind: inputKind.analysisBundle, archive: new Blob(), coordinate: {} }), { code: "analysis-bundle-input-invalid" });
  assert.throws(() => assertAnalysisInput({ kind: inputKind.module, coordinate: { path: "example.com/mod", version: "v1.2.3" }, network: true }), { code: "module-input-invalid" });
  assert.throws(() => assertAnalysisInput({ kind: "project-snapshot" }), { code: "input-kind-unsupported" });
});
