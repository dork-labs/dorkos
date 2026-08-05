import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
/** Read a `--flag value` pair, or its default. */
const arg = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = arg('base', 'http://localhost:6241').replace(/\/$/, '');
const API = arg('api', BASE).replace(/\/$/, '');
const WINDOWS = Number(arg('windows', '6'));
const HEADED = args.includes('--headed');

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

/** Assistant-only text from the runtime's own transcript for this agent. */
function transcriptSays(agentDir: string, marker: string): boolean | null {
  // eslint-disable-next-line no-restricted-syntax -- the e2e package has no env.ts, and this reads the operator's own shell environment to locate the runtime's transcripts
  const home = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? '', '.claude');
  const dir = join(home, 'projects', agentDir.replace(/\//g, '-'));
  if (!existsSync(dir)) return null;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const raw = readFileSync(join(dir, file), 'utf8');
    if (!raw.includes(marker)) continue;
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
        // Assistant text only. The user's own message repeats the marker
        // verbatim ("reply with X"), so scanning every role reports the agent
        // answered when it never did.
        if (entry.type !== 'assistant') continue;
        const content = entry.message?.content;
        const parts = Array.isArray(content) ? content : [];
        for (const part of parts as { type?: string; text?: string }[]) {
          if (part.type === 'text' && part.text?.includes(marker)) return true;
        }
      } catch {
        // A partial line mid-write is expected while a turn streams.
      }
    }
  }
  return false;
}

/** Agent directories on disk, which is where the server keeps them (ADR-0043). */
async function discoverAgents(): Promise<string[]> {
  const res = await fetch(`${API}/api/config`);
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
  record(
    "no window shows another window's conversation",
    finals.every((p, i) =>
      wins.every((w, j) => i === j || !p.assistantText.includes(`${w.marker}-REPLY`))
    ),
    'every marker checked against every window'
  );
  record(
    'each window showed the agent working',
    sawWorking.size === WINDOWS,
    `${sawWorking.size}/${WINDOWS}`
  );

  const disk = wins.map((w) => transcriptSays(w.agentDir, `${w.marker}-REPLY`));
  const comparable = disk.map((d, i) => ({
    d,
    screen: finals[i].assistantText.includes(`${wins[i].marker}-REPLY`),
  }));
  record(
    'the browser matches the runtime transcript',
    comparable.every(({ d, screen }) => d === null || d === screen),
    comparable
      .map(
        ({ d, screen }, i) =>
          `w${i + 1}:${d === null ? 'no-transcript' : `disk=${d}/screen=${screen}`}`
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
  try {
    const w = wins[0];
    const mine = (await probe(w.page)).session;
    const ownName = w.agentDir.split('/').pop() ?? '';
    const otherName =
      agents
        .find((a) => a !== w.agentDir)
        ?.split('/')
        .pop() ?? ownName;
    await agentRow(w.page, otherName).click();
    await w.page.waitForTimeout(6000);
    const away = await probe(w.page);
    await agentRow(w.page, ownName).click();
    await w.page.waitForTimeout(6000);
    const back = await probe(w.page);
    record(
      'returning to an agent reopens the conversation you were having',
      back.session === mine && back.assistantText.includes(`${w.marker}-REPLY`),
      `left ${mine?.slice(0, 8)}, returned to ${back.session?.slice(0, 8)}`
    );
    record(
      'switching to another agent opens its existing conversation',
      away.messageCount > 0,
      `landed on ${away.session?.slice(0, 8)} with ${away.messageCount} messages`
    );
  } catch (e) {
    record('agent switching works', false, `threw: ${(e as Error).message.split('\n')[0]}`);
  }

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

await main();
