// Twitter uses the exact same image as OpenGraph for consistency.
// Route segment config must be defined directly (Next.js static analysis requirement).
export { default } from './opengraph-image';

export const runtime = 'edge';
export const alt = 'DorkOS - The operating system for autonomous AI agents';
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = 'image/png';
