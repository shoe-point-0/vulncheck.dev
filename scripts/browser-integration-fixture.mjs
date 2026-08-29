import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export const browserIntegrationWebRoot = resolve(scriptDirectory, "../web");

// This is the reviewed local import closure of browser-integration-page.html,
// including the worker and service-worker entry points. A new runtime
// dependency must update this reviewed list deliberately.
export const expectedBrowserIntegrationFixturePaths = Object.freeze([
  "analysis-bundle.mjs",
  "analysis-input-workflow.mjs",
  "analysis-storage.mjs",
  "browser-integration-page.html",
  "browser-integration-page.mjs",
  "browser-integration-sw.mjs",
  "browser-integration-worker.mjs",
  "capabilities.mjs",
  "ingestion-error.mjs",
  "ingestion-worker.mjs",
  "input.mjs",
  "memory-storage.mjs",
  "module-archive.mjs",
  "module-coordinate.mjs",
  "module-route.mjs",
  "opfs-storage.mjs",
  "public-module-consent.mjs",
  "public-module-fetch.mjs",
  "public-module-retrieval.mjs",
  "resource-budget.mjs",
  "test-zip.mjs",
  "ui-policy.mjs",
  "zip-reader.mjs"
]);

export async function discoverBrowserIntegrationFixturePaths() {
  const pending = ["browser-integration-page.html"];
  const discovered = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (discovered.has(path)) continue;
    const source = await readFile(resolve(browserIntegrationWebRoot, path), "utf8");
    discovered.add(path);
    for (const specifier of staticFixtureSpecifiers(path, source)) {
      pending.push(resolveFixtureSpecifier(path, specifier));
    }
  }
  const paths = Object.freeze([...discovered].sort());
  assertReviewedFixturePaths(paths);
  return paths;
}

export function staticFixtureSpecifiers(path, source) {
  if (path.endsWith(".html")) {
    const specifiers = collectStaticSpecifiers(source, /<script type="module" src="([^"]+)"><\/script>/g, path);
    assertStaticSpecifierCoverage(source, /<script\b/g, specifiers, path, "script");
    return specifiers;
  }

  if (!path.endsWith(".mjs")) {
    throw new Error(`browser integration fixture ${path} has an unsupported runtime extension`);
  }
  if (/\bimport\s*\(/.test(source)) {
    throw new Error(`browser integration fixture ${path} does not permit dynamic imports`);
  }

  const importSpecifiers = collectStaticSpecifiers(
    source,
    /^\s*import\s+(?:[^\n]*?\s+from\s+)?["']([^"']+)["'];?\s*$/gm,
    path
  );
  assertStaticSpecifierCoverage(source, /^\s*import\s+(?!\()/gm, importSpecifiers, path, "module import");
  const reExportSpecifiers = collectStaticSpecifiers(
    source,
    /^\s*export\s+(?:\*|\*\s+as\s+\S+|\{[^\n]*\})\s+from\s+["']([^"']+)["'];?\s*$/gm,
    path
  );
  assertStaticSpecifierCoverage(source, /^\s*export\s+(?:\*|\*\s+as\s+\S+|\{[^\n]*\})\s+from\b/gm, reExportSpecifiers, path, "module re-export");
  const workerSpecifiers = collectStaticSpecifiers(source, /\bnew\s+Worker\(\s*["']([^"']+)["']/g, path);
  assertStaticSpecifierCoverage(source, /\bnew\s+Worker\s*\(/g, workerSpecifiers, path, "worker");
  const serviceWorkerSpecifiers = collectStaticSpecifiers(source, /\bserviceWorker\.register\(\s*["']([^"']+)["']/g, path);
  assertStaticSpecifierCoverage(source, /\bserviceWorker\.register\s*\(/g, serviceWorkerSpecifiers, path, "service-worker");
  const importScriptSpecifiers = collectStaticSpecifiers(source, /\bimportScripts\(\s*["']([^"']+)["']/g, path);
  assertStaticSpecifierCoverage(source, /\bimportScripts\s*\(/g, importScriptSpecifiers, path, "importScripts");
  return [...importSpecifiers, ...reExportSpecifiers, ...workerSpecifiers, ...serviceWorkerSpecifiers, ...importScriptSpecifiers];
}

function assertReviewedFixturePaths(paths) {
  if (paths.length !== expectedBrowserIntegrationFixturePaths.length || paths.some((path, index) => path !== expectedBrowserIntegrationFixturePaths[index])) {
    throw new Error("browser integration fixture manifest does not match the static page and worker runtime closure");
  }
}

function collectStaticSpecifiers(source, pattern, path) {
  const specifiers = [];
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (typeof specifier !== "string") {
      throw new Error(`browser integration fixture ${path} has an unreadable static runtime specifier`);
    }
    specifiers.push(specifier);
  }
  return specifiers;
}

function assertStaticSpecifierCoverage(source, referencePattern, specifiers, path, kind) {
  const references = [...source.matchAll(referencePattern)].length;
  if (references !== specifiers.length) {
    throw new Error(`browser integration fixture ${path} has an unresolved ${kind} runtime reference`);
  }
}

function resolveFixtureSpecifier(parentPath, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    throw new Error(`browser integration fixture ${parentPath} has a non-local static runtime specifier`);
  }
  if (specifier.includes("?") || specifier.includes("#")) {
    throw new Error(`browser integration fixture ${parentPath} has a parameterized static runtime specifier`);
  }
  const parentFile = resolve(browserIntegrationWebRoot, parentPath);
  const path = relative(browserIntegrationWebRoot, resolve(dirname(parentFile), specifier)).split(sep).join("/");
  if (path === "" || path === ".." || path.startsWith("../")) {
    throw new Error(`browser integration fixture ${parentPath} escapes the reviewed runtime root`);
  }
  return path;
}
