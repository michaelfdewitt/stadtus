// Color parameters for the city. Buildings are lit 3D surfaces, so the
// saturated "light surface" categorical slots are used; the sequential ramp
// is a single blue hue, light -> dark.

export const CATEGORICAL = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#6250d6', // violet
  '#e34948', // red
];
export const OTHER = '#8a8a85';      // "Other" bucket / unmapped
export const NEUTRAL = '#9a9a94';    // when no field is mapped
export const GHOST = '#3a3b3f';      // filtered-out buildings
export const MISSING = '#5a5b5f';    // value absent

export const SEQUENTIAL = [
  '#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7',
  '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b',
];

// Second sequential hue (orange) when two magnitudes are shown at once
// (kept for a second magnitude encoding).
export const SEQUENTIAL_2 = [
  '#fde3d6', '#fbd0bb', '#f8bb9d', '#f5a681', '#f29066', '#ef7a4d',
  '#eb6834', '#d95926', '#c44d1f', '#ab4219', '#923814', '#782d10', '#5f230c',
];

export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#e34948',
};

export const SELECTION = '#ffffff';
export const HOVER = '#ffffff';

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

// Interpolate along a ramp. t in [0,1].
export function rampColor(ramp, t) {
  if (!(t >= 0)) t = 0;
  if (t > 1) t = 1;
  const pos = t * (ramp.length - 1);
  const i = Math.floor(pos);
  const j = Math.min(ramp.length - 1, i + 1);
  const f = pos - i;
  const a = hexToRgb(ramp[i]), b = hexToRgb(ramp[j]);
  return rgbToHex([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
}
