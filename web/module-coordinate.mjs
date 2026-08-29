import { ingestionError } from "./ingestion-error.mjs";

const maxModulePathLength = 1_024;
const maxModuleVersionLength = 256;
const reservedWindowsNames = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"
]);

// validateModuleCoordinate accepts only coordinates that have one stable Go
// module interpretation. It is deliberately a small browser-side validation
// mirror, not a browser implementation of Go module resolution.
export function validateModuleCoordinate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2) {
    throw invalidCoordinate();
  }
  const { path, version } = value;
  if (typeof path !== "string" || typeof version !== "string" || path.length === 0 || version.length === 0 || path.length > maxModulePathLength || version.length > maxModuleVersionLength) {
    throw invalidCoordinate();
  }
  const pathMajor = validateModulePath(path);
  const parsedVersion = parseCanonicalVersion(version);
  if (!versionMatchesPathMajor(version, parsedVersion.major, pathMajor)) {
    throw invalidCoordinate();
  }
  return Object.freeze({ path, version });
}

function validateModulePath(path) {
  const elements = path.split("/");
  if (elements.length === 0 || elements.some((element) => !isValidModulePathElement(element))) {
    throw invalidCoordinate();
  }
  const first = elements[0];
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(first) || !first.includes(".")) {
    throw invalidCoordinate();
  }

  if (path.startsWith("gopkg.in/")) return gopkgInPathMajor(path);
  const finalElement = elements[elements.length - 1];
  if (/^v[0-9.]+$/.test(finalElement)) {
    if (!/^v[2-9][0-9]*$/.test(finalElement)) throw invalidCoordinate();
    return Object.freeze({ kind: "slash", value: finalElement });
  }
  return Object.freeze({ kind: "none", value: "" });
}

function isValidModulePathElement(element) {
  if (!element || element.startsWith(".") || element.endsWith(".") || element.includes("..") || !/^[A-Za-z0-9._~-]+$/.test(element)) {
    return false;
  }
  const stem = element.split(".", 1)[0];
  if (reservedWindowsNames.has(stem.toLowerCase()) || /~[0-9]+$/.test(stem)) return false;
  return true;
}

function gopkgInPathMajor(path) {
  const match = /\.v(0|[1-9][0-9]*)(-unstable)?$/.exec(path);
  if (!match) throw invalidCoordinate();
  return Object.freeze({ kind: "dot", value: `v${match[1]}` });
}

function parseCanonicalVersion(version) {
  const match = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match) throw invalidCoordinate();
  const [, major, , , prerelease, build] = match;
  if (prerelease && prerelease.split(".").some((identifier) => /^[0-9]+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
    throw invalidCoordinate();
  }
  // Go's canonical form removes ordinary build metadata. The one historical
  // exception retained by module coordinates is +incompatible.
  if (build && build !== "incompatible") throw invalidCoordinate();
  return Object.freeze({ major: `v${major}`, prerelease: prerelease ?? "", build: build ?? "" });
}

function versionMatchesPathMajor(version, major, pathMajor) {
  if (pathMajor.kind === "slash" || pathMajor.kind === "dot") {
    if (pathMajor.kind === "dot" && pathMajor.value === "v1" && version.startsWith("v0.0.0-")) return true;
    return major === pathMajor.value;
  }
  return major === "v0" || major === "v1" || version.endsWith("+incompatible");
}

function invalidCoordinate() {
  return ingestionError("module-coordinate-invalid", "module coordinate must use a canonical public Go module path and exact version");
}
