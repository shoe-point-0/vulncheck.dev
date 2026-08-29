import assert from "node:assert/strict";
import test from "node:test";

import { validateModuleCoordinate } from "./module-coordinate.mjs";
import { createModuleInput } from "./input.mjs";

test("accepts canonical public Go module coordinates", () => {
  for (const coordinate of [
    { path: "github.com/acme/demo", version: "v1.2.3" },
    { path: "github.com/Azure/azure-sdk-for-go", version: "v1.0.0" },
    { path: "example.com/demo/v2", version: "v2.0.0" },
    { path: "gopkg.in/yaml.v3", version: "v3.0.1" },
    { path: "example.com/demo", version: "v0.0.0-20240102030405-abcdefabcdef" },
    { path: "example.com/legacy", version: "v2.0.0+incompatible" }
  ]) {
    assert.deepEqual(validateModuleCoordinate(coordinate), coordinate);
  }
  assert.equal(createModuleInput({ coordinate: { path: "example.com/demo", version: "v1.2.3" } }).coordinate.version, "v1.2.3");
});

test("rejects non-canonical Go module paths and non-exact versions", () => {
  for (const coordinate of [
    { path: "GitHub.com/acme/demo", version: "v1.2.3" },
    { path: "github.com/acme/../demo", version: "v1.2.3" },
    { path: "github.com/acme/demo/v1", version: "v1.2.3" },
    { path: "example.com/demo/v2", version: "v1.2.3" },
    { path: "gopkg.in/yaml", version: "v1.2.3" },
    { path: "github.com/CON/demo", version: "v1.2.3" },
    { path: "github.com/acme/demo", version: "latest" },
    { path: "github.com/acme/demo", version: "v1.2" },
    { path: "github.com/acme/demo", version: "v1.02.3" },
    { path: "github.com/acme/demo", version: "v1.2.3+build" }
  ]) {
    assert.throws(() => validateModuleCoordinate(coordinate), { code: "module-coordinate-invalid" });
  }
});
