import assert from "node:assert/strict";
import test from "node:test";

import { parseModuleRoute } from "./module-route.mjs";

test("parses one canonical ModuleRoute without network behavior", () => {
  const route = parseModuleRoute({
    pathname: "/m/github.com/Azure/azure-sdk-for-go@v1.2.3",
    search: "",
    hash: ""
  });

  assert.deepEqual(route.coordinate, { path: "github.com/Azure/azure-sdk-for-go", version: "v1.2.3" });
  assert.equal(route.canonical_path, "/m/github.com/Azure/azure-sdk-for-go@v1.2.3");
});

test("fails closed for non-canonical, encoded, and parameterized ModuleRoutes", () => {
  const invalidRoutes = [
    [{ pathname: "/m/github.com%2Facme/demo@v1.2.3", search: "", hash: "" }, "module-route-encoded-separator"],
    [{ pathname: "/m/github.com/acme/%252e%252e/demo@v1.2.3", search: "", hash: "" }, "module-route-noncanonical"],
    [{ pathname: "/m/github.com/acme/demo@v1.2", search: "", hash: "" }, "module-route-noncanonical"],
    [{ pathname: "/m/github.com/acme:credential/demo@v1.2.3", search: "", hash: "" }, "module-route-noncanonical"],
    [{ pathname: "/m/github.com/acme/demo@v1.2.3", search: "?proxy=https://other.invalid", hash: "" }, "module-route-query-unsupported"],
    [{ pathname: "/m/github.com/acme/demo@v1.2.3", search: "", hash: "#private" }, "module-route-fragment-unsupported"]
  ];
  for (const [location, code] of invalidRoutes) {
    assert.throws(() => parseModuleRoute(location), { code });
  }
});
