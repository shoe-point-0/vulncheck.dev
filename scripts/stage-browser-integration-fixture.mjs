import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  browserIntegrationWebRoot,
  discoverBrowserIntegrationFixturePaths
} from "./browser-integration-fixture.mjs";

export async function stageBrowserIntegrationFixture(outputDirectory) {
  const destination = await assertNewDestination(outputDirectory);
  const fixturePaths = await discoverBrowserIntegrationFixturePaths();

  // Keep the staging directory private to its creator. Together with
  // COPYFILE_EXCL below, this prevents a concurrent local user from placing a
  // replacement target between directory creation and the reviewed copy.
  await mkdir(destination, { mode: 0o700 });
  const files = [];
  for (const path of fixturePaths) {
    const source = resolve(browserIntegrationWebRoot, path);
    const target = resolve(destination, path);
    if (!isContainedBy(destination, target)) {
      throw new Error(`browser integration fixture ${path} escapes the staging directory`);
    }
    await copyFile(source, target, fsConstants.COPYFILE_EXCL);
    const [sourceBytes, targetBytes] = await Promise.all([readFile(source), readFile(target)]);
    if (!targetBytes.equals(sourceBytes)) {
      throw new Error(`staged browser integration fixture ${path} does not match the reviewed source`);
    }
    files.push(Object.freeze({
      path,
      sha256: `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`
    }));
  }

  await verifyStagedFixture(destination, fixturePaths, files);

  const stagedNames = (await readdir(destination)).sort();
  if (stagedNames.length !== fixturePaths.length || stagedNames.some((path, index) => path !== fixturePaths[index])) {
    throw new Error("staged browser integration fixture contains unexpected files");
  }
  return Object.freeze({
    fixture_directory: destination,
    files: Object.freeze(files)
  });
}

async function verifyStagedFixture(destination, fixturePaths, files) {
  const finalFixturePaths = await discoverBrowserIntegrationFixturePaths();
  if (!samePaths(finalFixturePaths, fixturePaths)) {
    throw new Error("reviewed browser integration fixture changed while staging");
  }

  for (const file of files) {
    const [sourceBytes, targetBytes] = await Promise.all([
      readFile(resolve(browserIntegrationWebRoot, file.path)),
      readFile(resolve(destination, file.path))
    ]);
    const sourceDigest = `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`;
    if (!targetBytes.equals(sourceBytes) || sourceDigest !== file.sha256) {
      throw new Error(`staged browser integration fixture ${file.path} changed while staging`);
    }
  }
}

function samePaths(left, right) {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

async function assertNewDestination(outputDirectory) {
  if (typeof outputDirectory !== "string" || outputDirectory === "") {
    throw new Error("provide one new staging directory path");
  }
  const requestedDestination = resolve(outputDirectory);
  const [reviewedSourceRoot, resolvedParent] = await Promise.all([
    realpath(browserIntegrationWebRoot),
    realpath(dirname(requestedDestination))
  ]);
  const destination = resolve(resolvedParent, basename(requestedDestination));
  if (!isOutside(reviewedSourceRoot, destination)) {
    throw new Error("the staging directory must be outside web to protect reviewed source files");
  }
  return destination;
}

function isOutside(root, candidate) {
  const path = relative(root, candidate);
  return path === ".." || path.startsWith(`..${sep}`);
}

function isContainedBy(root, candidate) {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
}

async function main() {
  const [, , outputDirectory, ...extraArguments] = process.argv;
  if (extraArguments.length > 0) {
    throw new Error("provide exactly one new staging directory path");
  }
  const stagedFixture = await stageBrowserIntegrationFixture(outputDirectory);
  process.stdout.write(`${JSON.stringify(stagedFixture)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
