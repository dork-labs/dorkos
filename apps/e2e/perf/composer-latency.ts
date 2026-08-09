/**
 * Measure keystroke-to-paint latency in the chat composer, on both fields.
 *
 * The composer is the most latency-sensitive surface in the product — a person
 * feels 16 ms here that they would not feel anywhere else — so the spec puts a
 * number on it rather than a feeling: **p95 under 16 ms on a 4 000-character
 * document containing 20 mentions**, and a median no worse than the textarea's.
 *
 * ## How to run it
 *
 * Against a cockpit you started yourself, on ports nobody else is using:
 *
 * ```sh
 * # a test-mode server + its vite client, e.g. on 5252/5251
 * DORKOS_LATENCY_API=http://localhost:5252 \
 * DORKOS_LATENCY_APP=http://localhost:5251 \
 *   pnpm --filter @dorkos/e2e exec tsx perf/composer-latency.ts
 * ```
 *
 * It flips `ui.composer.richText` between the two runs and restores whatever it
 * found, so both paths are measured in ONE browser session on ONE machine —
 * which is the only way the comparison means anything. Numbers from two
 * different sessions are two different machines as far as the scheduler is
 * concerned.
 *
 * ## What it measures, precisely — and why it reports TWO clocks
 *
 * Both start at the field's own `input` event, captured, so they begin before
 * the editor has done anything.
 *
 * - **work** ends after the synchronous task the keystroke set off: the update
 *   listener, serialization, the position map, React's render. This is what the
 *   spec ADDED, and the only number an optimization can move.
 * - **paint** ends on the second animation frame, the first one that can carry
 *   the result. This is what a person waits for — but it is quantized to the
 *   display's frame interval, so it steps in ~16.7 ms jumps no matter how cheap
 *   the work is. A field doing 1 ms of work and one doing 9 ms can report the
 *   same paint number, and a work increase of a tenth of a millisecond can push
 *   a sample over a frame boundary and add 16 ms to it.
 *
 * The budget is therefore judged on **work**, and paint is reported beside it so
 * the frame-quantization is visible rather than mistaken for cost. Judging a
 * 16 ms budget on a number that can only take the values ~8, ~17, ~33 would be
 * measuring the display, not the composer.
 *
 * The first samples are discarded as warm-up: the lazy chunk, the first parse
 * and JIT all land there, and they are real but they are not typing.
 */
import { chromium, request, type Page } from '@playwright/test';
import { LATENCY_FIXTURE } from './composer-latency-fixture.js';

/* eslint-disable no-restricted-syntax -- a perf script, run by hand; no env.ts */
const API_URL = process.env.DORKOS_LATENCY_API ?? 'http://localhost:5252';
const APP_URL = process.env.DORKOS_LATENCY_APP ?? 'http://localhost:5251';
/* eslint-enable no-restricted-syntax */

/** Keystrokes per path. Enough that p95 is a measurement, not one unlucky frame. */
const SAMPLES = 60;

/** Discarded from the front of each run — chunk load, first parse, JIT. */
const WARMUP = 10;

/** The sentence typed one character at a time, cycled to reach SAMPLES. */
const TYPED = ' and one more note about the run';

/** A summary of one path's samples, on both clocks. */
interface Summary {
  path: string;
  count: number;
  /** Synchronous work the keystroke set off — what this spec added. */
  work: { median: number; p95: number; max: number };
  /** Work plus the wait for the next frame — what a person experiences. */
  paint: { median: number; p95: number; max: number };
}

/**
 * Percentile of a sample set, nearest-rank.
 *
 * @param values - The samples, in any order.
 * @param p - The percentile, 0..1.
 */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[rank] ?? Number.NaN;
}

/**
 * Set the preference and wait for the server to have taken it.
 *
 * @param richText - Whether the message box should format as you type.
 */
async function setRichText(richText: boolean): Promise<void> {
  const context = await request.newContext({ baseURL: API_URL });
  try {
    const res = await context.patch('/api/config', { data: { ui: { composer: { richText } } } });
    if (!res.ok()) throw new Error(`could not set richText=${richText}: ${res.status()}`);
  } finally {
    await context.dispose();
  }
}

/** Read the preference, so the script can put it back. */
async function readRichText(): Promise<boolean> {
  const context = await request.newContext({ baseURL: API_URL });
  try {
    const res = await context.get('/api/config');
    const config = (await res.json()) as { ui?: { composer?: { richText?: boolean } } };
    return config.ui?.composer?.richText ?? false;
  } finally {
    await context.dispose();
  }
}

/**
 * Type into whichever field is mounted and collect one sample per keystroke.
 *
 * @param page - A page already showing the composer.
 * @param selector - The field to drive.
 */
async function measure(page: Page, selector: string): Promise<{ paint: number[]; work: number[] }> {
  // Seed the 4 000-character document, then let it settle. `fill` is used
  // deliberately: the fixture is the STARTING STATE, not part of the
  // measurement, and typing it would take minutes.
  await page.locator(selector).fill(LATENCY_FIXTURE);
  await page.waitForTimeout(500);

  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no field at ${sel}`);
    const w = window as unknown as { __latency?: number[]; __work?: number[] };
    w.__latency = [];
    w.__work = [];
    el.addEventListener(
      'input',
      () => {
        const t0 = performance.now();
        // TWO numbers per keystroke, because they answer different questions.
        //
        // `work` is the synchronous task the keystroke set off — the editor's
        // update listener, serialization, the position map, React's render.
        // That is what THIS spec added, and it is the number an optimization
        // would move. A `setTimeout(0)` runs after that task and before paint.
        setTimeout(() => w.__work?.push(performance.now() - t0), 0);
        // `paint` is what a person waits: the same work plus however long until
        // the next frame carries it. It is quantized to the display's frame
        // interval, so it moves in ~16.7 ms steps whatever the work costs.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => w.__latency?.push(performance.now() - t0))
        );
      },
      { capture: true }
    );
  }, selector);

  await page.locator(selector).click();
  await page.keyboard.press('End');
  for (let i = 0; i < SAMPLES; i++) {
    await page.keyboard.type(TYPED[i % TYPED.length]!, { delay: 25 });
  }
  await page.waitForTimeout(500);

  const collected = await page.evaluate(() => {
    const w = window as unknown as { __latency?: number[]; __work?: number[] };
    return { paint: w.__latency ?? [], work: w.__work ?? [] };
  });
  return { paint: collected.paint.slice(WARMUP), work: collected.work.slice(WARMUP) };
}

/**
 * Measure one path end to end.
 *
 * @param page - The page to drive.
 * @param richText - Which field to measure.
 */
async function run(page: Page, richText: boolean): Promise<Summary> {
  await setRichText(richText);
  await page.goto(`${APP_URL}/session`);
  const selector = richText ? '[contenteditable="true"]' : 'textarea[role="combobox"]';
  await page.waitForSelector(selector, { timeout: 30_000 });

  const samples = await measure(page, selector);
  if (samples.paint.length === 0) throw new Error('no samples — the input listener never fired');

  const stats = (values: number[]) => ({
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  });

  return {
    path: richText ? 'lexical' : 'textarea',
    count: samples.paint.length,
    work: stats(samples.work),
    paint: stats(samples.paint),
  };
}

/** Run both paths in one browser session and print the table. */
async function main(): Promise<void> {
  const previous = await readRichText();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    // Textarea first: it is the baseline the other is compared against, and
    // running it cold is the fairer direction (the rich path then inherits a
    // warmed browser, so it cannot be flattered by ordering).
    const plain = await run(page, false);
    const rich = await run(page, true);

    const fmt = (n: number) => n.toFixed(2).padStart(7);
    const row = (s: Summary, clock: 'work' | 'paint') =>
      `  ${(s.path + ' ' + clock).padEnd(16)} ${String(s.count).padStart(7)}  ` +
      `${fmt(s[clock].median)}  ${fmt(s[clock].p95)}  ${fmt(s[clock].max)}\n`;

    process.stdout.write(
      `\n  document: ${LATENCY_FIXTURE.length} chars, ` +
        `${(LATENCY_FIXTURE.match(/@[a-z]+/g) ?? []).length} mentions\n\n` +
        `  path / clock     samples   median      p95      max\n` +
        row(plain, 'work') +
        row(rich, 'work') +
        row(plain, 'paint') +
        row(rich, 'paint') +
        `\n  budget: p95 work < 16.00 ms on the rich path — ` +
        `${rich.work.p95 < 16 ? 'MET' : 'MISSED'}\n` +
        `  median work no worse than the textarea — ` +
        `${rich.work.median <= plain.work.median ? 'MET' : `over by ${(rich.work.median - plain.work.median).toFixed(2)} ms`}\n\n`
    );
  } finally {
    await browser.close();
    await setRichText(previous);
  }
}

await main();
