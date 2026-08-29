import { detectCapabilities } from "./capabilities.mjs";
import { installIngestionWorker } from "./ingestion-worker.mjs";
import { MemoryAnalysisStorage } from "./memory-storage.mjs";

// This is a browser-test worker entry point. It deliberately uses the same
// baseline storage and ingestion boundary as a production host, so the native
// browser fixture cannot bypass the tested worker contract.
installIngestionWorker(self, {
  capabilityReport: detectCapabilities(self),
  storage: new MemoryAnalysisStorage()
});
