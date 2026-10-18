// Custom inline SVG glyphs for the limb handles (24×24 grid, round technical strokes,
// single colour via currentColor). Right-side versions; the left ones are mirrored in CSS.

const svg = (body: string, cls: string): string =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

/** Right hand seen from behind (the climber faces the wall): fingers up, thumb toward the body. */
export const HAND_GLYPH = svg(
  '<path d="M8.6 15.6V6.4a1.3 1.3 0 0 1 2.6 0v5.2"/>' +
    '<path d="M11.2 6.4V5a1.3 1.3 0 0 1 2.6 0v6.6"/>' +
    '<path d="M13.8 6.2a1.3 1.3 0 0 1 2.6 0v5.6"/>' +
    '<path d="M16.4 8.8a1.3 1.3 0 0 1 2.6 0v5.5c0 3.7-2.6 6.4-6.3 6.4h-1c-1.9 0-3.1-.6-4.2-1.8l-3.5-3.9a1.35 1.35 0 0 1 2-1.8l2.6 2.5"/>' +
    '<path d="M10.6 17.4h3.2" stroke-opacity=".45"/>',
  'jgl-g jgl-g-hand',
);

/** Right climbing shoe in profile: aggressive downturned toe pointing outward, velcro strap. */
export const FOOT_GLYPH = svg(
  '<path d="M4.9 16.4c-1.1-.1-1.7-1-1.5-2.1l.9-5c.2-1.1 1-1.7 2.1-1.6l3.4.4 1.9 1.9c2.2 2 5.1 2.7 7.7 3.2 1.6.3 2.2 1.8 1.4 3-.6.9-1.7 1.3-3 1.2l-5.2-.7c-2.7-.3-5.1-.2-7.7-.3z"/>' +
    '<path d="M7.6 7.9 9.4 13"/>' +
    '<path d="M3.9 13.9c5.2-.5 10.6.1 16.6.8" stroke-opacity=".45"/>',
  'jgl-g jgl-g-foot',
);

/** Hips / weight shift: four-way pull around the centre of mass. */
export const HIP_GLYPH = svg(
  '<circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>' +
    '<path d="M12 7.2V3.6M12 16.8v3.6M7.2 12H3.6M16.8 12h3.6"/>' +
    '<path d="M9.9 5.6 12 3.5l2.1 2.1M9.9 18.4l2.1 2.1 2.1-2.1M5.6 9.9 3.5 12l2.1 2.1M18.4 9.9l2.1 2.1-2.1 2.1"/>',
  'jgl-g jgl-g-hip',
);
