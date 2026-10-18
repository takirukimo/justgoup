// Grade labels: V-scale (Hueco) with the Fontainebleau equivalent, plus UI chip colours.

/** Fontainebleau equivalents per V-grade (research §3.7 reference row: V3 6A, V4 6B, V5 6C, V8 7B). */
const FONT = ['4', '5', '5+', '6A', '6B', '6C', '7A', '7A+', '7B', '7C', '7C+', '8A', '8A+'] as const;

/** Grade chip colours: calm greens/blues for the easy end, warm oranges around V6–V7, CHIRAL pink at V8, violet at the top. */
const COLORS = [
  '#4FD18B', // V0
  '#4FD18B', // V1
  '#9AD4DE', // V2
  '#9AD4DE', // V3
  '#F2C230', // V4
  '#F2C230', // V5
  '#FF7A1A', // V6
  '#FF7A1A', // V7
  '#D54051', // V8 (CHIRAL pink)
  '#E5433B', // V9
  '#E5433B', // V10
  '#8B5CF6', // V11
  '#8B5CF6', // V12
] as const;

const norm = (g: number): number => (Number.isFinite(g) ? Math.max(0, Math.min(12, Math.round(g))) : 0);

/** 'V0' … 'V12'. */
export function gradeLabel(g: number): string {
  return `V${norm(g)}`;
}

/** Fontainebleau equivalent: '4', '5', '5+', '6A', … '8A+'. */
export function fontGrade(g: number): string {
  return FONT[norm(g)];
}

/** Hex colour for a grade chip. */
export function gradeColor(g: number): string {
  return COLORS[norm(g)];
}

/** Short difficulty word for the preview card. */
export function gradeWord(g: number): string {
  const n = norm(g);
  if (n <= 1) return 'Warm-up';
  if (n <= 3) return 'Moderate';
  if (n <= 5) return 'Hard';
  if (n <= 7) return 'Very hard';
  if (n <= 9) return 'Elite';
  return 'World class';
}
