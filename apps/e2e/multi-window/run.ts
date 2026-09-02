import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium, type BrowserContext, type Page } from '@playwright/test';

/**
 * Drives a running DorkOS cockpit through several browser windows at once and
 * reports what an operator would actually see.
 *
 * This is a diagnostic, not a spec. `tests/streams/multi-window.spec.ts` is the
 * regression guard that runs in CI against the deterministic test-mode runtime;
 * this drives a REAL instance with REAL agent turns, at whatever window count
 * you ask for, and is the thing to reach for when you want to go looking rather
 * than to prove a known bug stays fixed.
 *
 * It found the DOR-927 connection ceiling and the DOR-928 resume bug. The
 * checks it runs are the ones those bugs would have failed.
 *
 * @module multi-window/run
 */

/** One PASS/FAIL line in the report. */
interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/** A driven window: its page, the agent it is on, and its unique marker. */
interface Window {
  page: Page;
  agentDir: string;
  marker: string;
  openMs: number;
  openError: string | null;
  submitted: boolean;
  pageErrors: string[];
}

/** What a window renders right now, read from the DOM rather than any store. */
interface Probe {
  session: string | null;
  messageCount: number;
  assistantText: string;
  working: boolean;
}

const args = process.argv.slice(2);
/**
 * Read a `--flag value` pair, or its default.
 *
 * A flag given with no value is an ERROR rather than a silent fall back to the
 * default: `--windows` as the last argument used to spend a default six real
 * agent turns while the operator believed they had asked for something else.
 */
const arg = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) {
    console.error(`--${name} needs a value`);
    process.exit(2);
  }
  return value;
};

const BASE = arg('base', 'http://localhost:6241').replace(/\/$/, '');
const API = arg('api', BASE).replace(/\/$/, '');
const HEADED = args.includes('--headed');

const windowsRaw = arg('windows', '6');
const WINDOWS = Number(windowsRaw);
// Validated before a browser opens. The old version accepted anything and then
// died on `wins[0]` with a TypeError, after paying to launch Chromium.
if (!Number.isInteger(WINDOWS) || WINDOWS < 1 || WINDOWS > 24) {
  console.error(`--windows must be a whole number from 1 to 24, got ${JSON.stringify(windowsRaw)}`);
  process.exit(2);
}

/** Time a plain API GET issued from INSIDE a window. */
async function probeHealth(page: Page): Promise<{ ms: number; status: number | string }> {
  return page.evaluate(async () => {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch('/api/health', { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timer);
      return { ms: Math.round(performance.now() - started), status: res.status };
    } catch {
      clearTimeout(timer);
      return { ms: -1, status: 'NO RESPONSE' };
    }
  });
}

/** Read a window's visible chat state. */
async function probe(page: Page): Promise<Probe> {
  try {
    return await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-testid="message-item"]')];
      const stopping = [...document.querySelectorAll('button')].some((b) =>
        /stop|cancel|interrupt/i.test(b.getAttribute('aria-label') ?? '')
      );
      return {
        session: new URLSearchParams(location.search).get('session'),
        messageCount: items.length,
        assistantText: items
          .filter((i) => i.getAttribute('data-role') === 'assistant')
          .map((i) => (i.textContent ?? '').trim())
          .join('\n'),
        working:
          stopping || !!document.querySelector('[data-testid="inference-indicator-streaming"]'),
      };
    });
  } catch {
    return { session: null, messageCount: 0, assistantText: '', working: false };
  }
}

/**
 * Whether the RUNTIME recorded this marker in the agent's reply, asked through
 * the server rather than read off disk.
 *
 * This is the check that catches "the agent answered and the browser never
 * showed it", so it has to be independent of the browser's stream — and it is:
 * for claude-code the server derives this history from the SDK's own JSONL.
 *
 * It deliberately does NOT reconstruct the transcript path itself. Doing that
 * means reimplementing the SDK's project-slug (every non-alphanumeric character
 * becomes a dash, with a hash-truncation branch past a length cap — see
 * `services/runtimes/claude-code/sessions/project-slug.ts`) AND the active-account
 * resolution that sits in front of `CLAUDE_CONFIG_DIR`. An earlier version of
 * this file replaced only `/`, which silently resolved to a directory that never
 * existed for any agent path containing a dot — including the default
 * `~/.dork/agents/*` — so the check returned "no transcript" every time and its
 * PASS meant nothing. Ask the server; it already knows.
 *
 * @returns `true`/`false` when the runtime could be asked, `null` when it could
 *   not — which the caller must treat as "unknown", never as agreement.
 */
async function runtimeRecorded(
  sessionId: string | null,
  agentDir: string,
  marker: string
): Promise<boolean | null> {
  if (!sessionId) return null;
  const url = `${API}/api/sessions/${sessionId}/messages?cwd=${encodeURIComponent(agentDir)}`;
  // The runtime's history lags the stream: the browser paints a reply the moment
  // the tokens arrive, while this reads what the SDK has written down. Asking
  // once produces a false "the browser is showing something the runtime never
  // recorded" — observed live, one window in two. Give it a bounded moment to
  // catch up, and only then report disagreement.
  const deadline = Date.now() + 15_000;
  let last: boolean | null;
  do {
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      return null;
    }
    if (!res.ok) return null;
    last = assistantSaid(await res.json(), marker);
    if (last === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  return last;
}

/**
 * Whether an `/api/sessions/:id/messages` payload contains the marker in
 * ASSISTANT text.
 *
 * Pure, and exported so it can be pinned: the role filter is the whole point.
 * The prompt asks the agent to "reply with exactly {marker}", so the user's own
 * message contains it verbatim — a search across every role reports that the
 * agent answered when it never did, which is the failure this check exists to
 * detect.
 *
 * @param body - The parsed response body, in either shape the route returns.
 * @param marker - The string the agent was asked to reply with.
 * @returns `null` when the payload is not a message list, meaning "unknown".
 * @internal Exported for testing.
 */
export function assistantSaid(body: unknown, marker: string): boolean | null {
  const messages = Array.isArray(body)
    ? body
    : ((body as { messages?: unknown[] } | null)?.messages ?? null);
  if (!Array.isArray(messages)) return null;
  return messages.some(
    (m) =>
      (m as { role?: string }).role === 'assistant' &&
      JSON.stringify((m as { content?: unknown }).content ?? '').includes(marker)
  );
}

/** Agent directories on disk, which is where the server keeps them (ADR-0043). */
async function discoverAgents(): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${API}/api/config`);
  } catch {
    // Undici's raw `fetch failed` + AggregateError buries the one fact that
    // matters, which is that nothing is listening.
    throw new Error(`Could not reach ${API} — start an instance, or pass --api`);
  }
  if (!res.ok)
    throw new Error(`GET /api/config answered ${res.status} — is ${API} a DorkOS server?`);
  const { dorkHome } = (await res.json()) as { dorkHome?: string };
  if (!dorkHome) throw new Error('GET /api/config returned no dorkHome');
  const agentsRoot = join(dorkHome, 'agents');
  if (!existsSync(agentsRoot)) throw new Error(`No agents directory at ${agentsRoot}`);
  const dirs = readdirSync(agentsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(agentsRoot, e.name));
  if (dirs.length === 0) throw new Error(`No agents under ${agentsRoot} — create one first`);
  return dirs;
}

/** Open one window on an agent, with a brand-new session. */
async function openWindow(ctx: BrowserContext, agentDir: string, index: number): Promise<Window> {
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
  const url = `${BASE}/session?dir=${encodeURIComponent(agentDir)}&session=${randomUUID()}`;
  const started = Date.now();
  let openError: string | null = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  } catch (e) {
    openError = (e as Error).message.split('\n')[0];
  }
  return {
    page,
    agentDir,
    marker: `MW${index + 1}X${Date.now().toString().slice(-5)}`,
    openMs: Date.now() - started,
    openError,
    submitted: false,
    pageErrors,
  };
}

/** Type into the composer and submit with the app's submit chord. */
async function send(page: Page, text: string): Promise<void> {
  const composer = page.getByRole('combobox', { name: /^(message |send a message)/i }).first();
  await composer.waitFor({ state: 'visible', timeout: 20_000 });
  await composer.click();
  await composer.fill(text);
  await page.keyboard.press('Meta+Enter');
}

/** The sidebar row for one agent, by name. */
const agentRow = (page: Page, name: string) =>
  page
    .locator('li')
    .filter({ has: page.locator('[data-slot="agent-list-item"]') })
    .filter({ hasText: name })
    .first();

async function main(): Promise<void> {
  const agents = await discoverAgents();
  const checks: Check[] = [];
  const record = (name: string, pass: boolean, detail: string): void => {
    checks.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  };

  console.log(`\nDriving ${WINDOWS} windows against ${BASE} (${agents.length} agents available)\n`);

  // One context on purpose: real windows of one browser share a socket pool,
  // and that sharing is the whole subject. Separate contexts pass vacuously.
  const ctx = await chromium.launchPersistentContext('', {
    headless: !HEADED,
    viewport: { width: 1440, height: 900 },
  });

  const wins: Window[] = [];
  for (let i = 0; i < WINDOWS; i++) {
    wins.push(await openWindow(ctx, agents[i % agents.length], i));
  }
  await wins[0].page.waitForTimeout(6000);

  record(
    'every window loads',
    wins.every((w) => !w.openError),
    wins.map((w, i) => `w${i + 1}:${w.openMs}ms`).join(' ')
  );

  const before = await Promise.all(wins.map((w) => probeHealth(w.page)));
  record(
    `the app still answers with ${WINDOWS} windows open`,
    before.every((h) => h.status === 200),
    before.map((h, i) => `w${i + 1}:${h.status === 200 ? `${h.ms}ms` : h.status}`).join(' ')
  );

  for (const w of wins) {
    try {
      await send(w.page, `Reply with exactly this line and nothing else: ${w.marker}-REPLY`);
      w.submitted = true;
    } catch {
      w.submitted = false;
    }
  }
  record(
    'every window accepts a message',
    wins.every((w) => w.submitted),
    wins.map((w, i) => `w${i + 1}:${w.submitted ? 'ok' : 'BLOCKED'}`).join(' ')
  );

  // Sample the working indicator FIRST and fast. It is only up between submit
  // and turn end, which for a one-line reply can be under five seconds — a loop
  // that sleeps before its first look reports "never showed it" for a window
  // that simply finished quickly.
  const sawWorking = new Set<string>();
  for (let i = 0; i < 12 && sawWorking.size < WINDOWS; i++) {
    for (const w of wins) if ((await probe(w.page)).working) sawWorking.add(w.marker);
    await wins[0].page.waitForTimeout(400);
  }

  for (let i = 0; i < 60; i++) {
    await wins[0].page.waitForTimeout(5000);
    const seen = await Promise.all(wins.map((w) => probe(w.page)));
    seen.forEach((p, n) => {
      if (p.working) sawWorking.add(wins[n].marker);
    });
    if (seen.every((p, n) => p.assistantText.includes(`${wins[n].marker}-REPLY`))) break;
  }

  const finals = await Promise.all(wins.map((w) => probe(w.page)));
  record(
    'every window shows its own reply',
    finals.every((p, i) => p.assistantText.includes(`${wins[i].marker}-REPLY`)),
    finals
      .map(
        (p, i) => `w${i + 1}:${p.assistantText.includes(`${wins[i].marker}-REPLY`) ? 'yes' : 'NO'}`
      )
      .join(' ')
  );
  // Requires every window to have rendered its OWN marker first. Without that
  // precondition this passes on a set of blank windows, which is precisely the
  // state a broken build leaves behind.
  const allRendered = finals.every((p, i) => p.assistantText.includes(`${wins[i].marker}-REPLY`));
  record(
    "no window shows another window's conversation",
    allRendered &&
      finals.every((p, i) =>
        wins.every((w, j) => i === j || !p.assistantText.includes(`${w.marker}-REPLY`))
      ),
    allRendered
      ? 'every marker checked against every window'
      : 'inconclusive — not every window rendered its own reply, so there was nothing to confuse'
  );
  record(
    'each window showed the agent working',
    sawWorking.size === WINDOWS,
    `${sawWorking.size}/${WINDOWS}`
  );

  const recorded = await Promise.all(
    wins.map((w, i) => runtimeRecorded(finals[i].session, w.agentDir, `${w.marker}-REPLY`))
  );
  const comparable = recorded.map((r, i) => ({
    runtime: r,
    screen: finals[i].assistantText.includes(`${wins[i].marker}-REPLY`),
  }));
  // A window the runtime could not be asked about is UNKNOWN, and unknown is not
  // agreement — it fails, loudly, rather than certifying nothing.
  record(
    "the browser matches the runtime's own record",
    comparable.every(({ runtime, screen }) => runtime !== null && runtime === screen),
    comparable
      .map(
        ({ runtime, screen }, i) =>
          `w${i + 1}:${runtime === null ? 'COULD-NOT-ASK' : `runtime=${runtime}/screen=${screen}`}`
      )
      .join(' ')
  );

  const after = await Promise.all(wins.map((w) => probeHealth(w.page)));
  record(
    'the app still answers after all those turns',
    after.every((h) => h.status === 200),
    after.map((h, i) => `w${i + 1}:${h.status === 200 ? `${h.ms}ms` : h.status}`).join(' ')
  );

  // Switching away and back must land on the conversation you were having.
  //
  // Both checks are always recorded, pass or fail, so the denominator does not
  // move between runs — a table that silently shrinks from 12 to 11 hides which
  // check went missing.
  const w = wins[0];
  const ownName = w.agentDir.split('/').pop() ?? '';
  const otherDir = agents.find((a) => a !== w.agentDir);
  let backOk = false;
  let backDetail: string;
  let awayOk = false;
  let awayDetail: string;

  if (!otherDir) {
    // With one agent there is nothing to switch TO, and clicking your own row
    // would pass while proving nothing.
    awayDetail = 'inconclusive — this instance has only one agent';
    backDetail = awayDetail;
  } else {
    try {
      const mine = (await probe(w.page)).session;
      const otherName = otherDir.split('/').pop() ?? '';
      await agentRow(w.page, otherName).click();
      await w.page.waitForTimeout(6000);
      const away = await probe(w.page);
      await agentRow(w.page, ownName).click();
      await w.page.waitForTimeout(6000);
      const back = await probe(w.page);

      backOk = back.session === mine && back.assistantText.includes(`${w.marker}-REPLY`);
      backDetail = `left ${mine?.slice(0, 8)}, returned to ${back.session?.slice(0, 8)}`;
      // The subject is "its EXISTING conversation", so the landing session must
      // differ from the one we left. A count alone passes when the switch never
      // happened at all.
      awayOk = away.messageCount > 0 && away.session !== mine;
      awayDetail = `landed on ${away.session?.slice(0, 8)} with ${away.messageCount} messages${
        away.session === mine ? ' (never left the original session)' : ''
      }`;
    } catch (e) {
      const why = `threw: ${(e as Error).message.split('\n')[0]}`;
      backDetail = why;
      awayDetail = why;
    }
  }
  record('returning to an agent reopens the conversation you were having', backOk, backDetail);
  record('switching to another agent opens its existing conversation', awayOk, awayDetail);

  try {
    const w = wins[WINDOWS - 1];
    const pre = await probe(w.page);
    await w.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await w.page.waitForTimeout(8000);
    const post = await probe(w.page);
    record(
      'reloading a window keeps the conversation',
      post.messageCount >= pre.messageCount && post.messageCount > 0,
      `${pre.messageCount} messages before, ${post.messageCount} after`
    );
  } catch (e) {
    record(
      'reloading a window keeps the conversation',
      false,
      `threw: ${(e as Error).message.split('\n')[0]}`
    );
  }

  const errors = wins.reduce((n, w) => n + w.pageErrors.length, 0);
  record('no uncaught errors in any window', errors === 0, `${errors} uncaught error(s)`);

  await ctx.close();

  const failed = checks.filter((c) => !c.pass);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed with ${WINDOWS} windows`
  );
  for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

// Only when run as a command. Without this guard, importing `assistantSaid`
// from a unit test launches a browser and drives a live instance.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
