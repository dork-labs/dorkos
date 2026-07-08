// packages/cli/src/newsletter-tip.ts

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** URL the tip points at — the newsletter landing page (ADR 260707-025214). */
const NEWSLETTER_URL = 'https://dorkos.ai/newsletter';

/** Env var that suppresses the tip entirely (for CI, scripts, or preference). */
const SUPPRESS_ENV = 'DORKOS_NO_NEWSLETTER_TIP';

interface NewsletterTipMarker {
  shownAt: number;
}

/** Lazily resolve the marker path so process.env.DORK_HOME (set by cli.ts) is available. */
function getMarkerPath(): string {
  // eslint-disable-next-line no-restricted-syntax -- DORK_HOME is set imperatively by cli.ts after module load; env.ts is parsed too early
  const home = process.env.DORK_HOME || join(homedir(), '.dork');
  return join(home, 'cache', 'newsletter-tip.json');
}

/** True if the tip has already been shown once (marker present). */
async function alreadyShown(): Promise<boolean> {
  try {
    const raw = await readFile(getMarkerPath(), 'utf-8');
    const marker = JSON.parse(raw) as NewsletterTipMarker;
    return typeof marker.shownAt === 'number';
  } catch {
    return false;
  }
}

/** Persist the marker so the tip never shows again. */
async function markShown(): Promise<void> {
  const path = getMarkerPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ shownAt: Date.now() } satisfies NewsletterTipMarker));
}

/**
 * Print the newsletter tip at most once, ever.
 *
 * Shows a single, non-nagging line pointing at the newsletter, then records a
 * marker in the dork data dir so it never prints again. Fully suppressed when
 * `DORKOS_NO_NEWSLETTER_TIP` is set. Never makes a network call and never
 * throws — any failure silently skips the tip so it can't disrupt startup.
 */
export async function maybeShowNewsletterTip(): Promise<void> {
  try {
    if (process.env[SUPPRESS_ENV]) return;
    if (await alreadyShown()) return;

    console.log('');
    console.log('  📬  Release notes + fleet reports, about twice a month:');
    console.log(`      ${NEWSLETTER_URL}`);
    console.log(`      (shown once; set ${SUPPRESS_ENV}=1 to always skip)`);
    console.log('');

    await markShown();
  } catch {
    // Never let a tip break startup.
  }
}
