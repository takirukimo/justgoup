// Self-contained stylesheet for the limb-control overlay (injected once into <head>).
// Tokens mirror PALETTE / FONTS in src/config/brand.ts ("alpine technical": dark matte glass,
// hairlines, bone glyphs, one hot signal accent used sparingly).

import { FONTS, PALETTE } from '../config/brand';

const STYLE_ID = 'jgu-limb-controls-css';

const CSS = /* css */ `
.jgl {
  position: absolute; inset: 0; overflow: hidden; z-index: 0;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent; pointer-events: auto;
  font-family: ${FONTS.mono};
  opacity: 1; visibility: visible;
  transition: opacity .24s cubic-bezier(.2,.8,.2,1), visibility 0s linear 0s;
  contain: strict;
}
.jgl.is-hidden {
  opacity: 0; visibility: hidden; pointer-events: none;
  transition: opacity .18s cubic-bezier(.2,.8,.2,1), visibility 0s linear .18s;
}
.jgl.is-disabled { pointer-events: none; }
.jgl-cv { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; }

/* ── handle ── */
.jgl-h {
  position: absolute; left: 0; top: 0; width: 70px; height: 70px; margin: -35px 0 0 -35px;
  pointer-events: none; will-change: transform; contain: layout style;
}
.jgl-n, .jgl-b { position: absolute; inset: 0; }
.jgl-b {
  transition: transform .26s cubic-bezier(.34,1.45,.5,1), opacity .2s cubic-bezier(.2,.8,.2,1);
}
.jgl-glow {
  position: absolute; inset: -16px; border-radius: 50%; opacity: 0;
  background: radial-gradient(closest-side, rgba(246,244,239,.30), rgba(246,244,239,.10) 58%, rgba(246,244,239,0) 100%);
  transition: opacity .2s cubic-bezier(.2,.8,.2,1);
}
.jgl-ring { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; will-change: transform; }
.jgl-trk { fill: none; stroke: rgba(255,255,255,.16); stroke-width: 2.5; }
.jgl-arc { fill: none; stroke: ${PALETTE.good}; stroke-width: 3.25; stroke-linecap: round; }
.jgl-halo { fill: none; stroke: ${PALETTE.bad}; stroke-width: 9; opacity: 0; transition: opacity .2s; }
.jgl-spin {
  fill: none; stroke: ${PALETTE.glacier}; stroke-width: 3.25; stroke-linecap: round;
  stroke-dasharray: 46 156; opacity: 0; transform-origin: 50% 50%; transform-box: view-box;
}
.jgl-shd {
  position: absolute; left: 1px; right: 1px; top: 9px; bottom: -9px; border-radius: 50%;
  background: radial-gradient(closest-side, rgba(0,0,0,.5) 0%, rgba(0,0,0,.28) 52%, rgba(0,0,0,0) 100%);
}
.jgl-disc {
  position: absolute; inset: 7px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: ${PALETTE.bone};
  /* no blurred box-shadows here: blur re-rasterises badly on low-end GPUs (shadow lives in .jgl-shd) */
  background:
    radial-gradient(120% 70% at 50% 0%, rgba(255,255,255,.10) 0%, rgba(255,255,255,0) 60%),
    radial-gradient(120% 95% at 50% 4%, rgba(92,99,110,.55) 0%, rgba(40,44,51,.72) 34%, rgba(20,22,26,.88) 70%, rgba(11,12,14,.94) 100%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.18), inset 0 0 0 1px rgba(255,255,255,.085);
  transition: box-shadow .2s cubic-bezier(.2,.8,.2,1), color .2s;
}
.jgl-g { width: 27px; height: 27px; margin-top: -7px; transition: opacity .2s; }
.jgl-l .jgl-g { transform: scaleX(-1); }
.jgl-side {
  position: absolute; left: 0; right: 0; bottom: 7.5px; text-align: center;
  font-size: 8.5px; font-weight: 700; line-height: 1; letter-spacing: .2em; text-indent: .2em;
  color: rgba(185,190,197,.82);
}
.jgl-key {
  position: absolute; top: 1px; right: 1px; width: 17px; height: 17px; border-radius: 6px;
  display: none; align-items: center; justify-content: center;
  font-size: 9.5px; font-weight: 700; line-height: 1; color: ${PALETTE.mist};
  background: rgba(13,14,16,.86); box-shadow: inset 0 0 0 1px rgba(255,255,255,.14);
}
@media (hover: hover) and (pointer: fine) { .jgl-key { display: flex; } }

/* states */
.jgl-h.is-free .jgl-trk { stroke: rgba(246,244,239,.34); stroke-dasharray: 1.5 5.2; stroke-linecap: round; }
.jgl-h.is-free .jgl-g { opacity: .62; }
.jgl-h.is-smear .jgl-trk { stroke: rgba(154,212,222,.32); }
.jgl-h.is-drag .jgl-b { transform: scale(1.12); }
.jgl-h.is-drag .jgl-glow { opacity: 1; }
.jgl-h.is-drag .jgl-disc {
  color: ${PALETTE.chalk};
  box-shadow: inset 0 1px 0 rgba(255,255,255,.24), inset 0 0 0 1.5px rgba(246,244,239,.62), 0 0 0 1px rgba(13,14,16,.45);
}
.jgl-h.is-drag .jgl-trk { stroke: rgba(246,244,239,.42); }
.jgl-h.is-dim .jgl-b { opacity: .3; transform: scale(.84); }
.jgl-h.is-locked .jgl-b { opacity: .34; transform: scale(.9); }
.jgl-h.is-locked .jgl-disc { color: ${PALETTE.fog}; }
.jgl-h.is-locked .jgl-arc { opacity: 0; }
.jgl-h.is-locked .jgl-trk { stroke-dasharray: 1.5 5.2; stroke-linecap: round; }
.jgl-h.is-over .jgl-halo { opacity: .2; }
.jgl-h.is-over .jgl-ring { animation: jgl-pulse .5s cubic-bezier(.45,0,.55,1) infinite alternate; }
.jgl-h.is-crit .jgl-ring { animation-duration: .26s; }
.jgl-h.is-crit .jgl-halo { opacity: .32; }
.jgl-h.is-busy .jgl-arc { opacity: 0; }
.jgl-h.is-busy .jgl-spin { opacity: 1; animation: jgl-spin .9s linear infinite; }
.jgl-h.is-busy .jgl-g { opacity: .5; }
.jgl-h.is-armed .jgl-disc {
  box-shadow: inset 0 1px 0 rgba(255,255,255,.18), inset 0 0 0 1.5px ${PALETTE.signal}, 0 0 0 3px rgba(255,79,31,.22);
}
.jgl-h.is-armed .jgl-key { background: ${PALETTE.signal}; color: ${PALETTE.basalt}; box-shadow: none; }

.jgl-h.is-focus .jgl-b::after {
  content: ''; position: absolute; inset: 3px; border-radius: 50%; pointer-events: none;
  border: 1.5px solid rgba(246,244,239,.75);
  animation: jgl-ping 1.7s cubic-bezier(.2,.8,.2,1) infinite;
}

/* hip handle */
.jgl-hip { width: 50px; height: 50px; margin: -25px 0 0 -25px; }
.jgl-hip .jgl-disc { inset: 6px; }
.jgl-hip .jgl-g { width: 21px; height: 21px; margin: 0; }
.jgl-hip .jgl-trk { stroke: rgba(154,212,222,.42); stroke-width: 2; stroke-dasharray: 2.2 3.6; }
.jgl-hip .jgl-glow { inset: -12px; background: radial-gradient(closest-side, rgba(154,212,222,.34), rgba(154,212,222,.1) 58%, rgba(154,212,222,0)); }
.jgl-hip.is-drag .jgl-trk { stroke: ${PALETTE.glacier}; stroke-dasharray: none; }
.jgl-hip.is-drag .jgl-disc { color: ${PALETTE.glacier}; box-shadow: inset 0 1px 0 rgba(255,255,255,.2), inset 0 0 0 1.5px rgba(154,212,222,.7); }
.jgl-hip .jgl-shd { top: 7px; bottom: -7px; }

/* labels */
.jgl-tag {
  position: absolute; left: 0; top: 0; height: 23px; padding: 0 9px 0 8px; border-radius: 7px;
  display: flex; align-items: center; gap: 6px; white-space: nowrap; pointer-events: none;
  font-size: 10px; font-weight: 700; line-height: 1; letter-spacing: .15em;
  color: ${PALETTE.bone};
  background: rgba(13,14,16,.82);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.07), inset 0 0 0 1px rgba(255,255,255,.1), 0 6px 14px -8px rgba(0,0,0,.8);
  opacity: 0; will-change: transform, opacity; transition: opacity .14s cubic-bezier(.2,.8,.2,1);
}
.jgl-tag.on { opacity: 1; }
.jgl-tag i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; box-shadow: 0 0 6px currentColor; }
.jgl-tag b { font-weight: 700; }
.jgl-tag span { color: rgba(185,190,197,.92); font-weight: 500; }
.jgl-tag span:empty { display: none; }
.jgl-tag.is-clip { background: ${PALETTE.signal}; color: ${PALETTE.basalt}; box-shadow: 0 8px 18px -8px rgba(255,79,31,.75); }
.jgl-tag.is-clip i { background: ${PALETTE.basalt}; box-shadow: none; }
.jgl-tag.is-clip span { color: rgba(13,14,16,.72); }
.jgl.no-assist .jgl-tag, .jgl.no-assist .jgl-side { display: none; }

@keyframes jgl-pulse { from { transform: scale(1); } to { transform: scale(1.085); } }
@keyframes jgl-spin { to { transform: rotate(360deg); } }
@keyframes jgl-ping { 0% { transform: scale(1); opacity: .9; } 70%, 100% { transform: scale(1.42); opacity: 0; } }

.jgl.is-reduced .jgl-ring, .jgl.is-reduced .jgl-spin, .jgl.is-reduced .jgl-b::after { animation: none !important; }
.jgl.is-reduced .jgl-b, .jgl.is-reduced .jgl-tag { transition: none; }
@media (prefers-reduced-motion: reduce) {
  .jgl-ring, .jgl-b::after { animation: none !important; }
  .jgl-b { transition: opacity .2s; }
}
`;

/** Inject the overlay stylesheet once per document. */
export function ensureLimbControlStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  doc.head.appendChild(el);
}
