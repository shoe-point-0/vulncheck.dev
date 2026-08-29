// IngestionError carries a stable, source-free code that callers can turn into
// a v1 diagnostic without exposing archive contents or browser internals.
export class IngestionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "IngestionError";
    this.code = code;
  }
}

export function ingestionError(code, message, options) {
  return new IngestionError(code, message, options);
}

export function assertNotCancelled(signal) {
  if (signal?.aborted) {
    throw ingestionError("input-cancelled", "input processing cancelled");
  }
}
