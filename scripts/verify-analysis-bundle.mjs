import { readFile } from "node:fs/promises";

import { hydrateAnalysisBundle } from "../web/analysis-bundle.mjs";
import { __canonicalizeSnapshotForTests } from "../web/analysis-bundle.mjs";
import { createAnalysisBundleInput } from "../web/input.mjs";
import { readStrictZip } from "../web/zip-reader.mjs";

const canonicalOnly = process.argv[2] === "--canonical";
const bundlePath = process.argv[canonicalOnly ? 3 : 2];
if (!bundlePath) {
  throw new Error("usage: node scripts/verify-analysis-bundle.mjs <bundle-path>");
}

const archive = new Blob([await readFile(bundlePath)]);
if (canonicalOnly) {
  const zip = await readStrictZip(archive, { boundary: "analysis-bundle" });
  const manifest = JSON.parse(new TextDecoder().decode(zip.entries.find((entry) => entry.path === "manifest.json").bytes));
  manifest.bundle_digest = `sha256:${"0".repeat(64)}`;
  process.stdout.write(__canonicalizeSnapshotForTests(manifest));
  process.exit(0);
}
const snapshot = await hydrateAnalysisBundle(createAnalysisBundleInput(archive));
process.stdout.write(`${JSON.stringify({
  assurance: snapshot.assurance,
  bundle_digest: snapshot.bundle_digest,
  content_paths: snapshot.content.map((entry) => entry.path),
  package_paths: snapshot.package_inventory.map((entry) => entry.path)
})}\n`);
