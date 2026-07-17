import { OG_SIZE } from '@/lib/og';

// Twitter uses the exact same image as OpenGraph for consistency.
// Route segment config must be defined directly (Next.js static analysis requirement).
export { default } from './opengraph-image';

export const alt = 'DorkOS: mission control for every coding agent you run';
export const size = OG_SIZE;
export const contentType = 'image/png';
