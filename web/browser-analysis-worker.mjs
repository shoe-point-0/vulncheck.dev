import { installAnalysisWorker } from "./analysis-worker-runtime.mjs";

// Browser-fixture entry point for the bounded analysis protocol. It has no
// storage, network, source, or shared-memory authority.
installAnalysisWorker(self);
