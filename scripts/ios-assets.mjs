// Renders the native iOS app icon and launch splash from the CHIRAL mark (src/config/brand.ts paths,
// same artwork as public/icons/icon.svg) into the Xcode asset catalog.
//
// usage: node scripts/ios-assets.mjs
// Needs the pre-installed Chromium (CHROMIUM_PATH, default /opt/pw-browsers/chromium). PNGs are written
// without an alpha channel: App Store Connect rejects an app icon that has one, even a fully opaque one.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { chromium } from 'playwright-core';

const root = new URL('../', import.meta.url);
const brand = readFileSync(new URL('src/config/brand.ts', root), 'utf8');
const block = brand.match(/const MARK_PATHS = \[([\s\S]*?)\];/)?.[1];
if (!block) throw new Error('MARK_PATHS not found in brand.ts');
const markPaths = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const MARK_W = 126.37, MARK_H = 66.04;
const BG = '#0D0E10', PINK = '#D54051';

/** The mark in pink, `w` px wide, centred on (cx, cy) in an svg of the given size. */
const mark = (cx, cy, w) => {
  const s = w / MARK_W;
  const x = cx - (MARK_W * s) / 2, y = cy - (MARK_H * s) / 2;
  return `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${s.toFixed(4)})" fill="${PINK}">${markPaths
    .map((d) => `<path d="${d}"/>`)
    .join('')}</g>`;
};

// Icon: full bleed (iOS applies its own corner mask), the same graphite glow and pink mark as the PWA icon.
const icon = (n) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 ${n} ${n}">` +
  `<defs><radialGradient id="g" cx="50%" cy="30%" r="75%"><stop offset="0" stop-color="#1D2025"/>` +
  `<stop offset=".62" stop-color="#111215"/><stop offset="1" stop-color="#0B0C0E"/></radialGradient>` +
  `<radialGradient id="p" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${PINK}" stop-opacity=".22"/>` +
  `<stop offset="1" stop-color="${PINK}" stop-opacity="0"/></radialGradient></defs>` +
  `<rect width="${n}" height="${n}" fill="url(#g)"/>` +
  `<ellipse cx="${n / 2}" cy="${n * 0.537}" rx="${n * 0.385}" ry="${n * 0.341}" fill="url(#p)"/>` +
  mark(n / 2, n * 0.5, n * 0.62) +
  `</svg>`;

// Splash: flat basalt with a small mark in the middle, matching the first frame of the web splash. The
// image is aspect-filled on every screen, so everything stays inside the central square.
const splash = (n) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 ${n} ${n}">` +
  `<rect width="${n}" height="${n}" fill="${BG}"/>` +
  mark(n / 2, n / 2, n * 0.11) +
  `</svg>`;

/** Re-encode an 8-bit RGBA PNG as RGB (drops the alpha channel; the images are opaque). */
function stripAlpha(png) {
  const sig = png.subarray(0, 8);
  let off = 8, ihdr = null;
  const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off), type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = Buffer.from(data);
    else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4), depth = ihdr[8], color = ihdr[9];
  if (depth !== 8) throw new Error(`unexpected bit depth ${depth}`);
  if (color === 2) return png; // already RGB
  if (color !== 6) throw new Error(`unexpected colour type ${color}`);
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp;
  const prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  const out = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    const o = y * (1 + w * 3);
    out[o] = 0;
    for (let x = 0; x < w; x++) cur.copy(out, o + 1 + x * 3, x * 4, x * 4 + 3);
    cur.copy(prev);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  ihdr[9] = 2;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
async function render(svg, n, path) {
  const page = await browser.newPage({ viewport: { width: n, height: n }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:${BG}">${svg}</body></html>`);
  const png = stripAlpha(await page.screenshot({ type: 'png' }));
  writeFileSync(new URL(path, root), png);
  await page.close();
  console.log('wrote', path, `(${(png.length / 1024).toFixed(0)} KB)`);
}

const cat = 'ios/App/App/Assets.xcassets/';
await render(icon(1024), 1024, cat + 'AppIcon.appiconset/AppIcon-512@2x.png');
for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'])
  await render(splash(2732), 2732, cat + 'Splash.imageset/' + f);
await browser.close();
