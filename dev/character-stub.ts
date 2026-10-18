// Headless stand-ins for the browser canvas APIs the procedural textures use (materials.ts, heads),
// so the CHARACTER rig can be built and posed in node (offline anatomy QA). Every drawing call is a
// no-op; reads return blank pixels. Import this module before anything from src/render.

const noop = (): void => undefined;
const gradient = { addColorStop: noop };

function fakeContext(canvas: { width: number; height: number }): unknown {
  const state: Record<string | symbol, unknown> = {};
  return new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      switch (key) {
        case 'canvas':
          return canvas;
        case 'getImageData':
        case 'createImageData':
          return (_x: number, _y: number, w?: number, h?: number) => {
            const W = Math.max(1, Math.floor(w ?? canvas.width));
            const H = Math.max(1, Math.floor(h ?? canvas.height));
            return { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
          };
        case 'measureText':
          return (t: string) => ({ width: t.length * 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
        case 'createLinearGradient':
        case 'createRadialGradient':
        case 'createConicGradient':
        case 'createPattern':
          return () => gradient;
        case 'getTransform':
          return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
        case 'isPointInPath':
        case 'isPointInStroke':
          return () => false;
        default:
          return noop;
      }
    },
    set(target, key, v) {
      target[key] = v;
      return true;
    },
  });
}

class FakeCanvas {
  width = 300;
  height = 150;
  style: Record<string, string> = {};
  private ctx: unknown = null;
  getContext(): unknown {
    this.ctx ??= fakeContext(this);
    return this.ctx;
  }
  toDataURL(): string {
    return 'data:image/png;base64,';
  }
  addEventListener = noop;
  removeEventListener = noop;
}

class FakePath2D {
  constructor(_d?: unknown) {}
  addPath = noop;
  moveTo = noop;
  lineTo = noop;
  bezierCurveTo = noop;
  quadraticCurveTo = noop;
  arc = noop;
  arcTo = noop;
  ellipse = noop;
  rect = noop;
  roundRect = noop;
  closePath = noop;
}

class FakeDOMMatrix {
  constructor(_m?: unknown) {}
}

const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.document === 'undefined') {
  g.document = {
    createElement: (tag: string) => (tag === 'canvas' ? new FakeCanvas() : { style: {}, addEventListener: noop }),
    createElementNS: (_ns: string, tag: string) => (tag === 'canvas' ? new FakeCanvas() : { style: {} }),
  };
}
g.Path2D ??= FakePath2D;
g.DOMMatrix ??= FakeDOMMatrix;
g.OffscreenCanvas ??= FakeCanvas;
g.self ??= globalThis;
