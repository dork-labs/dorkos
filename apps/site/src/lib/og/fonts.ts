/**
 * @module lib/og/fonts
 *
 * Loads the bundled IBM Plex TTFs (the site's real brand fonts) for
 * `ImageResponse`/satori rendering. The TTFs live beside this file under
 * `fonts/` and are read from disk on the Node runtime via `readFile`, not
 * fetched per-request from Google Fonts: Slack's unfurl timeout is tight, and a
 * local read is both faster and offline-safe. Every OG route must run on the
 * Node runtime (no `runtime = 'edge'`) so this read works.
 */
import { readFile } from 'node:fs/promises';
import { OG_FONT_MONO, OG_FONT_SANS } from './palette';

/** A single font registration accepted by `ImageResponse`'s `fonts` option. */
export interface OgFont {
  name: string;
  data: Buffer;
  weight: 400 | 700;
  style: 'normal';
}

/**
 * Fonts are static assets that never change between renders, so read them once
 * per server process and reuse the buffers.
 */
let cachedFonts: OgFont[] | null = null;

/**
 * Read the bundled IBM Plex Mono + Sans TTFs (regular + bold) and return them as
 * `ImageResponse` font registrations. Result is memoized for the process.
 *
 * The paths are resolved relative to this module (`import.meta.url`) so Next's
 * file tracing bundles the TTFs into the serverless output on Vercel.
 */
export async function loadOgFonts(): Promise<OgFont[]> {
  if (cachedFonts) return cachedFonts;

  const [monoRegular, monoBold, sansRegular, sansBold] = await Promise.all([
    readFile(new URL('./fonts/IBMPlexMono-Regular.ttf', import.meta.url)),
    readFile(new URL('./fonts/IBMPlexMono-Bold.ttf', import.meta.url)),
    readFile(new URL('./fonts/IBMPlexSans-Regular.ttf', import.meta.url)),
    readFile(new URL('./fonts/IBMPlexSans-Bold.ttf', import.meta.url)),
  ]);

  cachedFonts = [
    { name: OG_FONT_MONO, data: monoRegular, weight: 400, style: 'normal' },
    { name: OG_FONT_MONO, data: monoBold, weight: 700, style: 'normal' },
    { name: OG_FONT_SANS, data: sansRegular, weight: 400, style: 'normal' },
    { name: OG_FONT_SANS, data: sansBold, weight: 700, style: 'normal' },
  ];
  return cachedFonts;
}
