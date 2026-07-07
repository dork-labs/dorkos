import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { maybeShowNewsletterTip } from '../newsletter-tip.js';

let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;
const origHome = process.env.DORK_HOME;
const origSuppress = process.env.DORKOS_NO_NEWSLETTER_TIP;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dork-nl-'));
  process.env.DORK_HOME = home;
  delete process.env.DORKOS_NO_NEWSLETTER_TIP;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  logSpy.mockRestore();
  await rm(home, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.DORK_HOME;
  else process.env.DORK_HOME = origHome;
  if (origSuppress === undefined) delete process.env.DORKOS_NO_NEWSLETTER_TIP;
  else process.env.DORKOS_NO_NEWSLETTER_TIP = origSuppress;
});

function printedNewsletter(): boolean {
  return logSpy.mock.calls.flat().some((a) => String(a).includes('dorkos.ai/newsletter'));
}

describe('maybeShowNewsletterTip', () => {
  it('shows the tip once and writes a marker', async () => {
    await maybeShowNewsletterTip();
    expect(printedNewsletter()).toBe(true);
    const marker = JSON.parse(await readFile(join(home, 'cache', 'newsletter-tip.json'), 'utf-8'));
    expect(typeof marker.shownAt).toBe('number');
  });

  it('does not show a second time once the marker exists', async () => {
    await maybeShowNewsletterTip();
    logSpy.mockClear();
    await maybeShowNewsletterTip();
    expect(printedNewsletter()).toBe(false);
  });

  it('is fully suppressed by DORKOS_NO_NEWSLETTER_TIP', async () => {
    process.env.DORKOS_NO_NEWSLETTER_TIP = '1';
    await maybeShowNewsletterTip();
    expect(printedNewsletter()).toBe(false);
  });
});
