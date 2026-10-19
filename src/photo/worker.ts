// Photo detector worker: rectification, Lab conversion and hold detection run off the main thread, so
// dragging the sensitivity slider never hitches the page.

import { PhotoCore, type CoreRequest, type CoreResponse } from './core';

interface WorkerScope {
  onmessage: ((e: MessageEvent<CoreRequest>) => void) | null;
  postMessage(msg: CoreResponse, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const core = new PhotoCore();
scope.onmessage = (e: MessageEvent<CoreRequest>): void => {
  const { res, transfer } = core.handle(e.data);
  scope.postMessage(res, transfer);
};
