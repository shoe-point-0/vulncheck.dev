import { ingestionError } from "./ingestion-error.mjs";
import { validateModuleCoordinate } from "./module-coordinate.mjs";

export const moduleRouteKind = "module-route";

// parseModuleRoute is host-side only and has no network or storage effects.
// Browser Location.pathname is supplied separately from search and hash so
// unsupported parameters are rejected before any Module View planning begins.
export function parseModuleRoute(location) {
  const { pathname, search, hash } = assertLocation(location);
  if (search !== "") {
    throw ingestionError("module-route-query-unsupported", "module route query parameters are unsupported");
  }
  if (hash !== "") {
    throw ingestionError("module-route-fragment-unsupported", "module route fragments are unsupported");
  }
  if (!pathname.startsWith("/m/")) {
    throw ingestionError("module-route-invalid", "module route must begin with /m/");
  }
  const rawCoordinate = pathname.slice(3);
  const decodedCoordinate = decodeRouteCoordinate(rawCoordinate);
  const separator = decodedCoordinate.lastIndexOf("@");
  if (separator <= 0 || separator === decodedCoordinate.length - 1 || decodedCoordinate.indexOf("@") !== separator) {
    throw ingestionError("module-route-noncanonical", "module route must contain one module path and exact version");
  }
  let coordinate;
  try {
    coordinate = validateModuleCoordinate({
      path: decodedCoordinate.slice(0, separator),
      version: decodedCoordinate.slice(separator + 1)
    });
  } catch {
    throw ingestionError("module-route-noncanonical", "module route must contain a canonical module coordinate");
  }
  const canonicalPath = `/m/${coordinate.path}@${coordinate.version}`;
  if (pathname !== canonicalPath) {
    throw ingestionError("module-route-noncanonical", "module route must use canonical path spelling");
  }
  return Object.freeze({
    kind: moduleRouteKind,
    coordinate,
    canonical_path: canonicalPath
  });
}

function assertLocation(location) {
  if (!location || typeof location !== "object" || typeof location.pathname !== "string" || typeof location.search !== "string" || typeof location.hash !== "string") {
    throw ingestionError("module-route-invalid", "module route location must include pathname, search, and hash strings");
  }
  return location;
}

function decodeRouteCoordinate(rawCoordinate) {
  if (/%(?:2f|5c)/i.test(rawCoordinate)) {
    throw ingestionError("module-route-encoded-separator", "module route must not contain encoded separators");
  }
  let decoded;
  try {
    decoded = decodeURIComponent(rawCoordinate);
  } catch {
    throw ingestionError("module-route-encoding-invalid", "module route contains invalid percent encoding");
  }
  if (decoded !== rawCoordinate) {
    throw ingestionError("module-route-noncanonical", "module route must not use percent encoding");
  }
  return decoded;
}
