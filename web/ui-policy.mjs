const allowedActions = new Set([
  "display-report",
  "request-analysis",
  "cancel-analysis",
  "purge-local-data",
  "request-public-module-consent"
]);

// assertUIAction is the narrow UI-side allowlist. The present repository has
// no execution, auto-change, or AI feature; later UI work must use this gate.
export function assertUIAction(action) {
  if (!allowedActions.has(action)) {
    throw new Error("ui action is not permitted by the security contract");
  }
}
