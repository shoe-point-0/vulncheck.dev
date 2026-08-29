import { assertNotCancelled, ingestionError } from "./ingestion-error.mjs";
import { assertResourceBudget, hardResourceBudget, resolveResourceBudget } from "./resource-budget.mjs";

const localHeaderSignature = 0x04034b50;
const centralHeaderSignature = 0x02014b50;
const endOfCentralDirectorySignature = 0x06054b50;
const localHeaderLength = 30;
const centralHeaderLength = 46;
const endOfCentralDirectoryLength = 22;
const maxZipCommentLength = 0xffff;
const utf8Flag = 0x0800;
const supportedFlags = utf8Flag;
const storedMethod = 0;
const deflateMethod = 8;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

// readStrictZip reads only small headers and one entry at a time from Blob
// slices. It holds no entry out to a caller until every local and central ZIP
// record, size, CRC, duplicate, path, and resource check has passed.
export async function readStrictZip(archive, options = {}) {
  assertArchive(archive);
  const budget = resolveResourceBudget(options.budget ?? hardResourceBudget);
  const boundary = options.boundary ?? "archive";
  const signal = options.signal;
  const now = options.now ?? defaultNow;
  const startedAt = now();
  const state = { compressedBytes: 0, files: 0, observedBytes: 0, pathDepth: 0 };

  assertBudgetState(state, archive.size, budget, boundary, signal, startedAt, now);
  const end = await readEndOfCentralDirectory(archive, signal);
  if (end.centralOffset + end.centralSize !== end.offset) {
    throw ingestionError("zip-central-directory-invalid", "zip central directory does not end at the footer");
  }

  const paths = new Set();
  const logicalPaths = new Set();
  const localRecords = [];
  const visibleEntries = [];
  let offset = 0;
  while (offset < end.centralOffset) {
    assertNotCancelled(signal);
    assertBudgetState(state, archive.size, budget, boundary, signal, startedAt, now);
    const header = await readAt(archive, offset, localHeaderLength, signal);
    if (uint32(header, 0) !== localHeaderSignature) {
      throw ingestionError("zip-local-header-invalid", "zip local header is invalid");
    }
    const flags = uint16(header, 6);
    const method = uint16(header, 8);
    const crc = uint32(header, 14);
    const compressedSize = uint32(header, 18);
    const uncompressedSize = uint32(header, 22);
    const nameLength = uint16(header, 26);
    const extraLength = uint16(header, 28);
    assertZipFlags(flags);
    assertCompressionMethod(method);
    const bodyOffset = offset + localHeaderLength + nameLength + extraLength;
    const bodyEnd = bodyOffset + compressedSize;
    if (bodyOffset > end.centralOffset || bodyEnd > end.centralOffset || bodyEnd < bodyOffset) {
      throw ingestionError("zip-entry-size-invalid", "zip entry exceeds the local-data region");
    }
    const path = await readZipPath(archive, offset + localHeaderLength, nameLength, flags, budget, signal);
    const directory = path.endsWith("/");
    const logicalPath = directory ? path.slice(0, -1) : path;
    validateZipPath(logicalPath, budget.maxPathDepth);
    if (paths.has(path) || logicalPaths.has(logicalPath)) {
      throw ingestionError("zip-path-duplicate", "zip contains duplicate entry paths");
    }
    paths.add(path);
    logicalPaths.add(logicalPath);
    if (directory && (compressedSize !== 0 || uncompressedSize !== 0 || crc !== 0)) {
      throw ingestionError("zip-directory-invalid", "zip directory entries must be empty");
    }
    if (uncompressedSize > 0 && compressedSize === 0) {
      throw ingestionError("zip-entry-size-invalid", "zip entry has uncompressed bytes without compressed bytes");
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > budget.maxCompressionRatio) {
      throw ingestionError(`${boundary}-limit`, "compression-ratio limit exceeded");
    }
    state.compressedBytes += compressedSize;
    state.files += 1;
    state.pathDepth = Math.max(state.pathDepth, logicalPath.split("/").length);
    if (!directory) {
      if (state.observedBytes + uncompressedSize > budget.maxBytes || state.observedBytes + uncompressedSize > budget.maxMemoryBytes) {
        throw ingestionError(`${boundary}-limit`, "byte or memory limit exceeded");
      }
      const compressed = await readAt(archive, bodyOffset, compressedSize, signal);
      const bytes = await decompressEntry(compressed, method, uncompressedSize, {
        signal,
        maxBytes: Math.min(budget.maxBytes - state.observedBytes, budget.maxMemoryBytes - state.observedBytes),
        decompress: options.decompress
      });
      if (bytes.byteLength !== uncompressedSize) {
        throw ingestionError("zip-entry-size-invalid", "zip entry observed size differs from declared size");
      }
      if (crc32(bytes) !== crc) {
        throw ingestionError("zip-crc-invalid", "zip entry crc does not match its declared value");
      }
      state.observedBytes += bytes.byteLength;
      visibleEntries.push(Object.freeze({
        path: logicalPath,
        bytes,
        crc,
        compressedSize,
        uncompressedSize,
        method,
        flags,
        localOffset: offset
      }));
    }
    localRecords.push(Object.freeze({
      archivePath: path,
      path: logicalPath,
      directory,
      crc,
      compressedSize,
      uncompressedSize,
      method,
      flags,
      localOffset: offset
    }));
    offset = bodyEnd;
  }
  if (offset !== end.centralOffset) {
    throw ingestionError("zip-local-data-invalid", "zip local-data region is malformed");
  }
  assertBudgetState(state, archive.size, budget, boundary, signal, startedAt, now);
  await validateCentralDirectory(archive, end, localRecords, paths, signal);
  assertBudgetState(state, archive.size, budget, boundary, signal, startedAt, now);
  // Archive paths deliberately omit content bytes. Container-specific readers
  // use them to validate their own namespace rules (for example, a Go module
  // ZIP's required module@version prefix) after this reader has verified the
  // complete container, including explicit directory records.
  return Object.freeze({
    entries: Object.freeze(visibleEntries),
    archivePaths: Object.freeze(localRecords.map((entry) => entry.archivePath))
  });
}

async function readEndOfCentralDirectory(archive, signal) {
  const length = Math.min(archive.size, endOfCentralDirectoryLength + maxZipCommentLength);
  const start = archive.size - length;
  const tail = await readAt(archive, start, length, signal);
  for (let index = tail.byteLength - endOfCentralDirectoryLength; index >= 0; index -= 1) {
    if (uint32(tail, index) !== endOfCentralDirectorySignature) continue;
    const commentLength = uint16(tail, index + 20);
    if (index + endOfCentralDirectoryLength + commentLength !== tail.byteLength) continue;
    const disk = uint16(tail, index + 4);
    const centralDisk = uint16(tail, index + 6);
    const entriesOnDisk = uint16(tail, index + 8);
    const entries = uint16(tail, index + 10);
    const centralSize = uint32(tail, index + 12);
    const centralOffset = uint32(tail, index + 16);
    if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw ingestionError("zip-unsupported", "zip uses unsupported multi-disk or ZIP64 fields");
    }
    return { entries, centralSize, centralOffset, offset: start + index };
  }
  throw ingestionError("zip-footer-invalid", "zip end-of-central-directory record is missing or malformed");
}

async function validateCentralDirectory(archive, end, localRecords, paths, signal) {
  const byOffset = new Map(localRecords.map((entry) => [entry.localOffset, entry]));
  const centralPaths = new Set();
  let offset = end.centralOffset;
  const limit = end.centralOffset + end.centralSize;
  let records = 0;
  while (offset < limit) {
    assertNotCancelled(signal);
    const header = await readAt(archive, offset, centralHeaderLength, signal);
    if (uint32(header, 0) !== centralHeaderSignature) {
      throw ingestionError("zip-central-directory-invalid", "zip central directory header is invalid");
    }
    const flags = uint16(header, 8);
    const method = uint16(header, 10);
    const crc = uint32(header, 16);
    const compressedSize = uint32(header, 20);
    const uncompressedSize = uint32(header, 24);
    const nameLength = uint16(header, 28);
    const extraLength = uint16(header, 30);
    const commentLength = uint16(header, 32);
    const disk = uint16(header, 34);
    const localOffset = uint32(header, 42);
    assertZipFlags(flags);
    assertCompressionMethod(method);
    const nextOffset = offset + centralHeaderLength + nameLength + extraLength + commentLength;
    if (nextOffset > limit || nextOffset < offset) {
      throw ingestionError("zip-central-directory-invalid", "zip central directory entry exceeds its declared region");
    }
    const path = await readZipPath(archive, offset + centralHeaderLength, nameLength, flags, { maxPathDepth: 32 }, signal);
    const directory = path.endsWith("/");
    const logicalPath = directory ? path.slice(0, -1) : path;
    if (!paths.has(path) || centralPaths.has(path)) {
      throw ingestionError("zip-central-directory-invalid", "zip central directory does not match local entries");
    }
    centralPaths.add(path);
    if (directory && (compressedSize !== 0 || uncompressedSize !== 0 || crc !== 0)) {
      throw ingestionError("zip-central-directory-invalid", "zip central directory has a non-empty directory entry");
    }
    const local = byOffset.get(localOffset);
    if (!local || local.archivePath !== path || local.path !== logicalPath || local.directory !== directory || local.flags !== flags || local.method !== method || local.crc !== crc || local.compressedSize !== compressedSize || local.uncompressedSize !== uncompressedSize) {
      throw ingestionError("zip-central-directory-invalid", "zip central directory metadata does not match local entry metadata");
    }
    records += 1;
    offset = nextOffset;
  }
  if (offset !== limit || records !== end.entries || centralPaths.size !== paths.size || localRecords.length !== records) {
    throw ingestionError("zip-central-directory-invalid", "zip central directory entry count does not match local entries");
  }
}

async function readZipPath(archive, offset, length, flags, budget, signal) {
  if (length === 0) {
    throw ingestionError("zip-path-invalid", "zip entry path is required");
  }
  const bytes = await readAt(archive, offset, length, signal);
  let path;
  try {
    if ((flags & utf8Flag) === 0 && bytes.some((byte) => byte > 0x7f)) {
      throw new TypeError("non-ascii legacy zip name");
    }
    path = textDecoder.decode(bytes);
  } catch {
    throw ingestionError("zip-path-encoding-invalid", "zip entry path must be valid utf-8 or ascii");
  }
  validateZipPath(path.endsWith("/") ? path.slice(0, -1) : path, budget.maxPathDepth);
  return path;
}

function validateZipPath(path, maxPathDepth) {
  if (!path || path.length > 4_096 || path.includes("\u0000") || path.includes("\\") || path.startsWith("/")) {
    throw ingestionError("zip-path-invalid", "zip entry path must be a bounded relative slash-separated path");
  }
  const parts = path.split("/");
  if (parts.length > maxPathDepth) {
    throw ingestionError("zip-path-depth", "zip entry path exceeds the configured depth");
  }
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      throw ingestionError("zip-path-traversal", "zip entry path must not contain traversal or redundant segments");
    }
  }
}

function assertZipFlags(flags) {
  if ((flags & ~supportedFlags) !== 0) {
    throw ingestionError("zip-flags-unsupported", "zip encryption and data descriptors are unsupported");
  }
}

function assertCompressionMethod(method) {
  if (method !== storedMethod && method !== deflateMethod) {
    throw ingestionError("zip-compression-unsupported", "zip compression method is unsupported");
  }
}

async function decompressEntry(compressed, method, expectedSize, options) {
  assertNotCancelled(options.signal);
  if (method === storedMethod) return compressed;
  if (typeof options.decompress === "function") {
    const bytes = await options.decompress(compressed, method, options);
    return asByteArray(bytes);
  }
  if (typeof DecompressionStream !== "function") {
    throw ingestionError("zip-compression-unsupported", "raw deflate is unavailable in this browser runtime");
  }
  let stream;
  try {
    stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  } catch (cause) {
    throw ingestionError("zip-compression-unsupported", "raw deflate is unavailable in this browser runtime", { cause });
  }
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      assertNotCancelled(options.signal);
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > expectedSize || length > options.maxBytes) {
        await reader.cancel();
        throw ingestionError("archive-limit", "decompressed entry exceeds its declared or configured size");
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof Error && cause.name === "IngestionError") throw cause;
    throw ingestionError("zip-decompression-invalid", "zip deflate entry could not be decompressed", { cause });
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function asByteArray(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw ingestionError("zip-decompression-invalid", "zip decompressor returned unsupported bytes");
}

function assertBudgetState(state, declaredBytes, budget, boundary, signal, startedAt, now) {
  const elapsed = Math.max(0, now() - startedAt);
  assertResourceBudget({
    declaredBytes,
    observedBytes: state.observedBytes,
    compressedBytes: state.compressedBytes || declaredBytes,
    files: state.files,
    pathDepth: state.pathDepth,
    nesting: 1,
    // Browser APIs do not expose thread CPU time. Charging elapsed worker time
    // to this ceiling is conservative and cannot admit a CPU-bound archive
    // that exceeds the v1 five-second CPU ceiling.
    cpuTimeMs: elapsed,
    memoryBytes: state.observedBytes,
    wallTimeMs: elapsed
  }, budget, boundary, signal);
}

async function readAt(archive, offset, length, signal) {
  assertNotCancelled(signal);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > archive.size) {
    throw ingestionError("zip-range-invalid", "zip range exceeds the archive");
  }
  const bytes = new Uint8Array(await archive.slice(offset, offset + length).arrayBuffer());
  assertNotCancelled(signal);
  if (bytes.byteLength !== length) {
    throw ingestionError("zip-range-invalid", "zip range was truncated");
  }
  return bytes;
}

function assertArchive(archive) {
  if (!archive || typeof archive.size !== "number" || !Number.isSafeInteger(archive.size) || archive.size < 0 || typeof archive.slice !== "function") {
    throw ingestionError("archive-input-invalid", "archive input must be a Blob or File with a finite size");
  }
}

function uint16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

const crcTable = createCRCTable();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createCRCTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}
