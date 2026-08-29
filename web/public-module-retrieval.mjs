import { createModuleInput } from "./input.mjs";
import { ingestionError } from "./ingestion-error.mjs";
import { parseModuleRoute } from "./module-route.mjs";
import { hardResourceBudget, resolveResourceBudget } from "./resource-budget.mjs";

const cacheStatuses = new Set(["cached", "missing"]);

// planModuleRoute turns a side-effect-free route into either a local cache
// plan, an explicit consent disclosure, or an offline diagnostic. It never
// performs a lookup or constructs an executable network request by itself.
export function planModuleRoute(location, options = {}) {
  const route = parseModuleRoute(location);
  const cacheStatus = options.cache_status;
  if (!cacheStatuses.has(cacheStatus)) {
    throw ingestionError("module-cache-status-invalid", "module cache status must be cached or missing");
  }
  if (cacheStatus === "cached") {
    return Object.freeze({
      type: "module-view-cached",
      assurance: "module-view",
      reachability: "inconclusive",
      canonical_path: route.canonical_path,
      input: createModuleInput({ coordinate: route.coordinate })
    });
  }
  if (options.offline === true) {
    return Object.freeze({
      type: "module-view-unavailable",
      code: "offline-module-not-cached",
      assurance: "module-view",
      reachability: "inconclusive",
      canonical_path: route.canonical_path
    });
  }
  if (options.offline !== undefined && options.offline !== false) {
    throw ingestionError("module-offline-invalid", "module offline mode must be a boolean when provided");
  }
  const sourceEndpoint = canonicalizeEndpoint(options.selected_endpoint);
  const budget = resolveResourceBudget(options.budget ?? hardResourceBudget);
  return Object.freeze({
    type: "public-module-consent-required",
    assurance: "module-view",
    reachability: "inconclusive",
    canonical_path: route.canonical_path,
    module_path: route.coordinate.path,
    module_version: route.coordinate.version,
    source_endpoint: sourceEndpoint,
    archive_url: moduleArchiveURL(sourceEndpoint, route.coordinate),
    transfer: Object.freeze({
      expected_size_bytes: "unknown",
      maximum_bytes: budget.maxBytes
    })
  });
}

// authorizePublicModuleRetrieval records a user-confirmed, exactly matching
// disclosure. Only this receipt may be handed to a later worker fetch adapter.
export function authorizePublicModuleRetrieval(plan, confirmation) {
  const validatedPlan = assertConsentPlan(plan);
  if (!confirmation || typeof confirmation !== "object" || confirmation.accepted !== true || confirmation.selected_endpoint !== validatedPlan.source_endpoint || confirmation.module_path !== validatedPlan.module_path) {
    throw ingestionError("module-consent-mismatch", "module retrieval consent must match the disclosed endpoint and module path");
  }
  return Object.freeze({
    type: "public-module-retrieval-authorized",
    assurance: "module-view",
    reachability: "inconclusive",
    canonical_path: validatedPlan.canonical_path,
    module_path: validatedPlan.module_path,
    source_endpoint: validatedPlan.source_endpoint,
    transfer: Object.freeze({
      expected_size_bytes: "unknown",
      maximum_bytes: validatedPlan.maximum_bytes
    }),
    request: Object.freeze({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      url: validatedPlan.archive_url
    })
  });
}

// publicModuleConsentDisclosure is the renderer-facing view of a validated
// plan. It deliberately contains no executable fetch function: a trusted UI
// activation must first create a bound authorization receipt.
export function publicModuleConsentDisclosure(plan) {
  const validatedPlan = assertConsentPlan(plan);
  return Object.freeze({
    assurance: "module-view",
    reachability: "inconclusive",
    canonical_path: validatedPlan.canonical_path,
    module_path: validatedPlan.module_path,
    module_version: validatedPlan.coordinate.version,
    source_endpoint: validatedPlan.source_endpoint,
    archive_url: validatedPlan.archive_url,
    transfer: Object.freeze({
      expected_size_bytes: "unknown",
      maximum_bytes: validatedPlan.maximum_bytes
    })
  });
}

// assertPublicModuleRetrievalAuthorization is repeated in the worker because
// structured-clone messages are hostile. It recomputes the only allowed URL
// from the canonical route and selected endpoint, so message fields cannot
// select another proxy or resource.
export function assertPublicModuleRetrievalAuthorization(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "public-module-retrieval-authorized") {
    throw ingestionError("module-retrieval-authorization-invalid", "public module retrieval authorization is invalid");
  }
  assertOnlyKeys(value, ["type", "assurance", "reachability", "canonical_path", "module_path", "source_endpoint", "transfer", "request"], "module-retrieval-authorization-invalid");
  const route = parseModuleRoute({ pathname: value.canonical_path, search: "", hash: "" });
  const sourceEndpoint = canonicalizeEndpoint(value.source_endpoint);
  if (value.assurance !== "module-view" || value.reachability !== "inconclusive" || value.module_path !== route.coordinate.path || !value.transfer || typeof value.transfer !== "object" || Array.isArray(value.transfer)) {
    throw ingestionError("module-retrieval-authorization-invalid", "public module retrieval authorization is invalid");
  }
  assertOnlyKeys(value.transfer, ["expected_size_bytes", "maximum_bytes"], "module-retrieval-authorization-invalid");
  if (value.transfer.expected_size_bytes !== "unknown" || !Number.isSafeInteger(value.transfer.maximum_bytes)) {
    throw ingestionError("module-retrieval-authorization-invalid", "public module retrieval authorization is invalid");
  }
  resolveResourceBudget({ maxBytes: value.transfer.maximum_bytes });
  const request = value.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw ingestionError("module-retrieval-authorization-invalid", "public module retrieval authorization is invalid");
  }
  assertOnlyKeys(request, ["method", "credentials", "redirect", "url"], "module-retrieval-authorization-invalid");
  const expectedURL = moduleArchiveURL(sourceEndpoint, route.coordinate);
  if (request.method !== "GET" || request.credentials !== "omit" || request.redirect !== "error" || request.url !== expectedURL) {
    throw ingestionError("module-retrieval-authorization-invalid", "public module retrieval authorization is invalid");
  }
  return Object.freeze({
    canonical_path: route.canonical_path,
    coordinate: route.coordinate,
    module_path: route.coordinate.path,
    source_endpoint: sourceEndpoint,
    maximum_bytes: value.transfer.maximum_bytes,
    request: Object.freeze({ method: "GET", credentials: "omit", redirect: "error", url: expectedURL })
  });
}

function assertConsentPlan(plan) {
  if (!plan || typeof plan !== "object" || plan.type !== "public-module-consent-required") {
    throw ingestionError("module-consent-plan-invalid", "public module retrieval requires a consent plan");
  }
  const route = parseModuleRoute({ pathname: plan.canonical_path, search: "", hash: "" });
  const sourceEndpoint = canonicalizeEndpoint(plan.source_endpoint);
  if (plan.module_path !== route.coordinate.path || plan.module_version !== route.coordinate.version || plan.archive_url !== moduleArchiveURL(sourceEndpoint, route.coordinate) || !plan.transfer || plan.transfer.expected_size_bytes !== "unknown" || !Number.isSafeInteger(plan.transfer.maximum_bytes)) {
    throw ingestionError("module-consent-plan-invalid", "public module consent plan is malformed");
  }
  resolveResourceBudget({ maxBytes: plan.transfer.maximum_bytes });
  return Object.freeze({
    canonical_path: route.canonical_path,
    coordinate: route.coordinate,
    module_path: route.coordinate.path,
    source_endpoint: sourceEndpoint,
    archive_url: plan.archive_url,
    maximum_bytes: plan.transfer.maximum_bytes
  });
}

function assertOnlyKeys(value, allowed, code) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw ingestionError(code, "public module retrieval authorization is invalid");
  }
}

function canonicalizeEndpoint(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw ingestionError("endpoint-invalid", "selected endpoint must be a bounded absolute https url");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw ingestionError("endpoint-invalid", "selected endpoint must be a valid absolute https url");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname.includes("%") || !/^\/[A-Za-z0-9._~/-]*$/.test(parsed.pathname)) {
    throw ingestionError("endpoint-invalid", "selected endpoint must be an absolute https url without credentials, parameters, or encoded paths");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname}`;
}

function moduleArchiveURL(endpoint, coordinate) {
  return `${endpoint}/${escapeForGoProxy(coordinate.path)}/@v/${escapeForGoProxy(coordinate.version)}.zip`;
}

function escapeForGoProxy(value) {
  return value.replace(/[A-Z]/g, (character) => `!${character.toLowerCase()}`);
}
