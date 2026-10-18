// Generation worker: problem generation (layout + beta verification) runs off the main thread so a
// new boulder never hitches the 60 fps loop.

import { handleGen, type GenRequest, type GenResponse } from './gen-core';

interface WorkerScope {
  onmessage: ((e: MessageEvent<GenRequest>) => void) | null;
  postMessage(msg: GenResponse): void;
}

const scope = self as unknown as WorkerScope;
scope.onmessage = (e: MessageEvent<GenRequest>): void => {
  scope.postMessage(handleGen(e.data));
};
