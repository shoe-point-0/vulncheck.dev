// The integration origin deliberately sends no COOP or COEP headers. This
// worker claims the reload only to prove that service-worker control does not
// make cross-origin isolation a prerequisite for the baseline workflow.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
