import assert from "node:assert/strict";
import test from "node:test";

import { assertUIAction } from "./ui-policy.mjs";

test("permits only evidence-workbench actions", () => {
  assert.doesNotThrow(() => assertUIAction("display-report"));
  assert.throws(() => assertUIAction("execute-analyzed-code"));
  assert.throws(() => assertUIAction("apply-automatic-change"));
  assert.throws(() => assertUIAction("enable-ai-rule"));
});
