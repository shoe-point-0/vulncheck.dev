import { assertNotCancelled, ingestionError } from "./ingestion-error.mjs";
import { assertPublicModuleRetrievalAuthorization } from "./public-module-retrieval.mjs";

// fetchAuthorizedModuleArchive is worker-only. It accepts only the exact URL
// derived from a consent receipt, sends no credentials or referrer, never
// retries against another proxy, and bounds the response while it streams.
export async function fetchAuthorizedModuleArchive(authorization, options = {}) {
  const retrieval = assertPublicModuleRetrievalAuthorization(authorization);
  const signal = options.signal;
  assertNotCancelled(signal);
  const fetchAPI = Object.hasOwn(options, "fetchAPI") ? options.fetchAPI : globalThis.fetch;
  if (typeof fetchAPI !== "function") {
    throw ingestionError("module-fetch-unavailable", "public module retrieval is unavailable in this worker runtime");
  }

  let response;
  try {
    response = await fetchAPI(retrieval.request.url, {
      method: retrieval.request.method,
      credentials: retrieval.request.credentials,
      redirect: retrieval.request.redirect,
      mode: "cors",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal
    });
  } catch (cause) {
    if (signal?.aborted) assertNotCancelled(signal);
    throw ingestionError("module-fetch-failed", "public module retrieval failed", { cause });
  }
  assertNotCancelled(signal);
  assertFetchResponse(response, retrieval.maximum_bytes);
  const archive = await readBoundedResponse(response.body, retrieval.maximum_bytes, signal);
  return Object.freeze({
    archive,
    coordinate: retrieval.coordinate,
    source_endpoint: retrieval.source_endpoint,
    transfer_bytes: archive.size,
    maximum_bytes: retrieval.maximum_bytes
  });
}

function assertFetchResponse(response, maximumBytes) {
  if (!response || typeof response !== "object" || response.ok !== true || response.redirected === true || !response.body || typeof response.body.getReader !== "function") {
    throw ingestionError("module-fetch-response-invalid", "public module retrieval returned an unsupported response");
  }
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength === null || contentLength === undefined || contentLength === "") return;
  if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
    throw ingestionError("module-fetch-response-invalid", "public module retrieval returned an invalid content length");
  }
  const declaredBytes = Number(contentLength);
  if (!Number.isSafeInteger(declaredBytes)) {
    throw ingestionError("module-fetch-response-invalid", "public module retrieval returned an invalid content length");
  }
  if (declaredBytes > maximumBytes) {
    throw ingestionError("module-fetch-limit", "public module retrieval exceeds the disclosed transfer limit");
  }
}

async function readBoundedResponse(stream, maximumBytes, signal) {
  const reader = stream.getReader();
  const chunks = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      assertNotCancelled(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw ingestionError("module-fetch-response-invalid", "public module retrieval returned invalid response bytes");
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        throw ingestionError("module-fetch-limit", "public module retrieval exceeds the disclosed transfer limit");
      }
      chunks.push(value);
    }
    assertNotCancelled(signal);
  } catch (cause) {
    await cancelReader(reader);
    if (signal?.aborted) assertNotCancelled(signal);
    if (cause?.name === "IngestionError") throw cause;
    throw ingestionError("module-fetch-failed", "public module retrieval response could not be read", { cause });
  } finally {
    reader.releaseLock?.();
  }
  return new Blob(chunks, { type: "application/zip" });
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is best effort after a stream has already failed.
  }
}
