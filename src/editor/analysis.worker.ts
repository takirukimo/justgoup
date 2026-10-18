// Solver worker: keeps beta search and sample generation off the main thread while the player edits.

import { handleRequest, type AnalysisRequest, type AnalysisResponse } from './analysis';

interface WorkerScope {
  onmessage: ((e: MessageEvent<AnalysisRequest>) => void) | null;
  postMessage(msg: AnalysisResponse): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (e: MessageEvent<AnalysisRequest>): void => {
  scope.postMessage(handleRequest(e.data));
};
