/**
 * The daily HTML report: it renders from a recorded snapshot, it escapes
 * everything that came from outside, the index lists the days newest first,
 * and `pnpm ci:report` writes nothing to the data branch.
 *
 * The escaping test is the one that matters most. Pull request titles, branch
 * names and API error messages all reach this page, and any of them can hold
 * `<script>`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../cli.ts';
import {
  INDEX_DATA,
  renderDailyReport,
  renderIndex,
  reportPath,
  shorten,
  updateIndex,
  type DailyReportInput,
  type ReportIndex,
} from '../daily-report.ts';
import {
  emptySnapshot,
  gateKey,
  LatestSchema,
  writeData,
  type Latest,
  type SloReading,
  type Snapshot,
} from '../data.ts';
import { esc, fill, h, raw, sparkline } from '../html.ts';
import { loadHandFiles } from '../load.ts';
import { loadWorkflows } from '../workflows.ts';
import { addDays } from '../time.ts';
import { triage, type Triggers } from '../triggers.ts';
import { baseSpec, writeRepo } from './fixture.ts';

const TEMPLATE = path.resolve(import.meta.dirname, '..', '..', 'templates', 'report.html');
const DAY = '2026-09-19';
const NOW = new Date(`${DAY}T05:00:00Z`);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * The page must make no request when it is opened: no CDN, no web font, no
 * script, no favicon fetch. The one http URL allowed anywhere is SVG's XML
 * namespace, which is an identifier and is never fetched.
 */
function expectOffline(html: string): void {
  expect(html).not.toContain('<script');
  const urls = [...html.matchAll(/https?:\/\/[^"'\s)]+/g)].map((m) => m[0]);
  expect(urls.filter((u) => u !== 'http://www.w3.org/2000/svg')).toEqual([]);
}

function temp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function snapshot(date: string, over: Partial<Snapshot> = {}): Snapshot {
  const s = emptySnapshot(date, `${date}T05:00:00Z`, 700);
  return {
    ...s,
    complete: true,
    healthy: true,
    health: { ...s.health, ok: true },
    counts: {
      ...s.counts,
      merged_prs: 6,
      queue_builds: 8,
      queue_builds_green: 7,
      job_minutes: 420,
    },
    queue_builds: Array.from({ length: 8 }, (_, i) => ({
      sha: `sha${i}`,
      pr: 1000 + i,
      created_at: `${date}T0${i}:00:00Z`,
      outcome: (i === 0 ? 'red' : 'green') as 'red' | 'green',
      failed_gates: i === 0 ? ['wf.test.test-shard'] : [],
    })),
    gates: {
      [gateKey('wf.test.test-shard', 'merge_group')]: {
        durations: Array.from({ length: 40 }, (_, i) => [3600 + i, 600 + i] as [number, number]),
        conclusions: { success: 38, failure: 2 },
        retried: 0,
        runs: 40,
      },
    },
    ...over,
  };
}

function latest(over: Partial<Latest> = {}): Latest {
  return {
    schema: 1,
    date: DAY,
    collected_at: `${DAY}T05:00:00Z`,
    snapshot: `snapshots/${DAY}.json`,
    report_ref: null,
    healthy: true,
    failures: [],
    warnings: [],
    api_calls: 42,
    slos: [
      {
        id: 'queue-green',
        kind: 'quality',
        from: addDays(DAY, -6),
        to: DAY,
        n: 40,
        min_n: 30,
        stats: { share: 0.88 },
        status: 'ok',
        excess_hours: null,
      },
    ],
    constraint: {
      tier: 'quality',
      id: 'queue-green',
      reason: 'Merge-queue builds come back green: share 0.88 breaches its floor.',
      ...(over.constraint ?? {}),
    },
    local_breaches: [],
    safeguards_ok: true,
    ...over,
  };
}

const roots = new WeakMap<DailyReportInput, string>();
/** The throwaway repo a `recorded()` input was built against. */
const repoRootOf = (inp: DailyReportInput): string => roots.get(inp)!;

/** A data directory holding a week of recorded days, and the repo that reads it. */
function recorded(over: Partial<Latest> = {}): DailyReportInput {
  const root = temp('ci-steward-repo-');
  writeRepo(baseSpec(), root);
  const dataDir = temp('ci-steward-data-');
  for (const d of Array.from({ length: 14 }, (_, i) => addDays(DAY, -13 + i)))
    writeData(dataDir, `snapshots/${d}.json`, snapshot(d));
  const l = latest(over);
  writeData(dataDir, 'latest.json', l);
  const inp: DailyReportInput = {
    files: loadHandFiles(root).files!,
    workflows: loadWorkflows(root, '.github/workflows', () => undefined),
    dataDir,
    day: DAY,
    latest: l,
    triggers: null,
    verdicts: [],
    ledger: [],
    now: NOW,
  };
  roots.set(inp, root);
  return inp;
}

describe('the HTML helpers', () => {
  it('escapes every value put on the page, including inside attributes', () => {
    expect(esc('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
    );
    expect(h`<p>${'<b>&</b>'}</p>`.value).toBe('<p>&lt;b&gt;&amp;&lt;/b&gt;</p>');
    expect(h`<p>${raw('<b>ok</b>')}</p>`.value).toBe('<p><b>ok</b></p>');
  });

  it('fills the slots it knows and leaves an unknown one visible', () => {
    expect(fill('<i>{{a}}</i>{{{b}}}{{c}}', { a: '<x>', b: raw('<b>y</b>') })).toBe(
      '<i>&lt;x&gt;</i><b>y</b>{{c}}'
    );
  });

  it('never re-scans what a slot inserted, so a value cannot splice in another section', () => {
    // Trigger text carries GitHub's words. Two passes would let this one pull
    // the whole SLO table into the headline.
    const out = fill('<h1>{{{markup}}}</h1><p>{{text}}</p>', {
      markup: raw('<b>{{text}}</b>'),
      text: 'plain {{{markup}}}',
      slos: raw('<table>SECRET</table>'),
    });
    expect(out).toBe('<h1><b>{{text}}</b></h1><p>plain {{{markup}}}</p>');
    expect(out).not.toContain('SECRET');
  });

  it('escapes a value that tries to break out of an attribute, a style block or a slot', () => {
    const attr = h`<a title="${'" onmouseover="alert(1)'}">x</a>`.value;
    expect(attr).toBe('<a title="&quot; onmouseover=&quot;alert(1)">x</a>');
    expect(esc('</style><script>x</script>')).toBe('&lt;/style&gt;&lt;script&gt;x&lt;/script&gt;');
    expect(h`<p>${'{{title}} {{{slos}}}'}</p>`.value).toBe('<p>{{title}} {{{slos}}}</p>');
    // And that text, once on the page, is inert: fill has already run.
    expect(fill('{{a}}', { a: '{{b}}', b: 'LEAKED' })).toBe('{{b}}');
  });

  it('reads a latest.json written by a newer collector instead of demanding a migration', () => {
    // A checkout days behind the collector must not throw on a field it has
    // never heard of. Every other file here is strict; this one cannot be.
    const parsed = LatestSchema.safeParse({ ...latest(), something_new: { a: 1 } });
    expect(parsed.success).toBe(true);
  });

  it('draws a sparkline as inline SVG, and breaks the line over a missing day', () => {
    const svg = sparkline([1, null, 3], 'a line').value;
    expect(svg).toContain('<svg class="spark"');
    expect(svg).toMatch(/d="M[\d. ]+M[\d. ]+"/);
    expect(sparkline([1], 'a line').value).toContain('not enough days yet');
  });
});

describe('the daily report', () => {
  it('renders one page from a recorded week, with the headline, the constraint and a sparkline', () => {
    const { html } = renderDailyReport(recorded());
    expect(html).toContain('<title>CI report for 2026-09-19</title>');
    expect(html).toContain('Queue builds are green');
    expect(html).toContain('queue-green');
    expect(html).toContain('<svg class="spark"');
    expect(html).toContain('<strong>6</strong> pull requests merged');
    expect(html).toContain('<strong>420</strong> job minutes');
    // A day with no canary result says so, rather than leaving the line out:
    // a canary that stopped running reads exactly like a healthy main.
    expect(html).toContain('<strong>0</strong> main-canary runs');
    expectOffline(html);
  });

  it('names the main canary s red workflows on a day it caught something', () => {
    const inp = recorded();
    const at = (m: string, red: boolean, workflow: string) => ({
      workflow,
      sha: 'abc123def456',
      event: 'schedule',
      started: `${DAY}T00:${m}:00Z`,
      done: `${DAY}T01:${m}:00Z`,
      red,
    });
    writeData(inp.dataDir, `snapshots/${DAY}.json`, {
      ...snapshot(DAY),
      canary: [at('37', false, 'test.yml'), at('41', true, 'browser-test.yml')],
    });
    const { html } = renderDailyReport(inp);
    expect(html).toContain(
      '<strong>2</strong> main-canary runs against main, 1 red (browser-test.yml)'
    );
  });

  it('says everything is healthy, in plain words, when nothing fired', () => {
    const inp = recorded();
    const { html, index } = renderDailyReport({
      ...inp,
      triggers: triage({
        files: inp.files,
        workflows: inp.workflows,
        ledger: [],
        verdicts: [],
        latest: inp.latest,
        snapshots: [],
        prior: null,
        now: NOW,
      }),
    });
    expect(index.light).toBe('green');
    expect(html).toContain('headline green');
    expect(html).toContain('All healthy.');
  });

  it('never says healthy while the table below shows a measure under its floor', () => {
    const breach = (id: string, kind: SloReading['kind']): SloReading => ({
      id,
      kind,
      from: addDays(DAY, -6),
      to: DAY,
      n: 40,
      min_n: 30,
      stats: { share: 0.5 },
      status: 'breach',
      excess_hours: null,
    });
    // The live branch's shape: no triggers.json at all, three breaches.
    const inp = recorded({
      slos: [
        breach('queue-green', 'quality'),
        breach('review-completes', 'quality'),
        breach('pr-feedback', 'speed'),
      ],
    });
    const { html, index } = renderDailyReport(inp);
    expect(index.light).toBe('red');
    expect(html).not.toContain('All healthy');
    expect(html).toContain('Under floor: queue-green, review-completes');
    expect(html).toContain('Triggers not computed.');
    expect(html).toContain(`No triggers for ${DAY}`);
    // A speed breach on its own is amber, not red.
    const speedOnly = renderDailyReport(recorded({ slos: [breach('pr-feedback', 'speed')] }));
    expect(speedOnly.index.light).toBe('amber');
  });

  it("treats yesterday's triggers as no triggers, and says so", () => {
    const inp = recorded();
    const stale: Triggers = {
      schema: 1,
      date: addDays(DAY, -1),
      computed_at: `${addDays(DAY, -1)}T05:00:00Z`,
      constraint: null,
      canary_since: null,
      open: [],
      cleared: [],
    };
    const { html, index } = renderDailyReport({ ...inp, triggers: stale });
    expect(index.light).toBe('amber');
    expect(html).not.toContain('All healthy');
    expect(html).toContain(`newest are ${addDays(DAY, -1)}`);
  });

  it('escapes text that came from GitHub, so a pull request title cannot run a script', () => {
    const nasty = '<script>alert("pwned")</script>';
    const inp = recorded({
      healthy: false,
      failures: [`the run list for PR ${nasty} came back short`],
      warnings: [nasty],
    });
    const { html } = renderDailyReport(inp);
    expect(html).toContain('&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<script');
  });

  it('escapes a trigger that carries the same text, and shows how long it has been open', () => {
    const inp = recorded();
    const triggers: Triggers = {
      schema: 1,
      date: DAY,
      computed_at: `${DAY}T05:00:00Z`,
      constraint: 'queue-green',
      canary_since: null,
      open: [
        {
          id: 'collector-health',
          rule: 'collector-health',
          severity: 'red',
          scope: '',
          what: 'the fetch failed on <img src=x onerror=alert(1)>',
          action: 'fix it',
          ledger_entry: null,
          first_fired: addDays(DAY, -30),
          last_fired: DAY,
        },
      ],
      cleared: [],
    };
    const { html, index } = renderDailyReport({ ...inp, triggers });
    expect(index.light).toBe('red');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('open 30d');
  });

  it('lists the days newest first in the index, and keeps one row per day', () => {
    const now = NOW;
    let index: ReportIndex | null = null;
    for (const d of ['2026-09-17', '2026-09-19', '2026-09-18', '2026-09-19'])
      index = updateIndex(index, { date: d, light: 'green', headline: `all fine on ${d}` }, now);
    expect(index!.days.map((d) => d.date)).toEqual(['2026-09-19', '2026-09-18', '2026-09-17']);
    const html = renderIndex(index!, now);
    expect(html.indexOf('2026-09-19.html')).toBeLessThan(html.indexOf('2026-09-17.html'));
    expect(html).toContain('<h2>Every day</h2>');
    expect(html).not.toContain('<h2>Open triggers</h2>');
  });
});

describe('pnpm ci:report', () => {
  it('writes the page to a temp path and nothing at all to the data branch', () => {
    const root = temp('ci-steward-repo-');
    writeRepo(baseSpec(), root);
    const origin = temp('ci-steward-origin-');
    const git = (cwd: string, args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git(origin, ['init', '--bare', '--initial-branch=ci-steward-data', '.']);
    const seed = temp('ci-steward-seed-');
    git(seed, ['init', '--initial-branch=ci-steward-data', '.']);
    git(seed, ['config', 'user.email', 'ci@example.com']);
    git(seed, ['config', 'user.name', 'CI']);
    writeData(seed, 'latest.json', latest());
    writeData(seed, `snapshots/${DAY}.json`, snapshot(DAY));
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-m', 'seed']);
    git(seed, ['push', origin, 'ci-steward-data']);
    git(root, ['init', '.']);
    git(root, ['remote', 'add', 'origin', origin]);
    git(root, ['fetch', 'origin', 'ci-steward-data']);
    const before = git(root, ['rev-parse', 'origin/ci-steward-data']);

    const out: string[] = [];
    const code = main(
      ['daily-report', '--root', root, '--now', NOW.toISOString()],
      { out: (s) => out.push(s), err: (s) => out.push(s) },
      root
    );
    expect(code).toBe(0);
    const written = out.join('').trim();
    dirs.push(path.dirname(path.dirname(written)));
    expect(written.endsWith(`${reportPath(DAY)}`)).toBe(true);
    expect(written.startsWith(root)).toBe(false);
    expect(readFileSync(written, 'utf8')).toContain('CI report for 2026-09-19');
    // Nothing reached the branch, the remote, or the checkout.
    expect(git(root, ['rev-parse', 'origin/ci-steward-data'])).toBe(before);
    expect(git(origin, ['rev-parse', 'ci-steward-data'])).toBe(before);
    expect(git(root, ['status', '--porcelain', '--', 'reports'])).toBe('');
  });

  it("refuses to rebuild an older day rather than stamping today's numbers with its date", () => {
    const inp = recorded();
    const out: string[] = [];
    const err: string[] = [];
    const code = main(
      [
        'daily-report',
        '--data',
        inp.dataDir,
        '--day',
        addDays(DAY, -6),
        '--now',
        NOW.toISOString(),
      ],
      { out: (x) => out.push(x), err: (x) => err.push(x) },
      repoRootOf(inp)
    );
    expect(code).toBe(1);
    expect(err.join('')).toContain('cannot be rebuilt');
    expect(err.join('')).toContain(DAY);
    expect(out.join('')).toBe('');
    // And the index was not stamped with a row for a day it never wrote.
    expect(existsSync(path.join(inp.dataDir, INDEX_DATA))).toBe(false);
  });

  it('serves an older day from the page already on the branch', () => {
    const inp = recorded();
    const older = addDays(DAY, -6);
    writeData(inp.dataDir, reportPath(older), '<html><title>old</title></html>');
    const out: string[] = [];
    const code = main(
      ['daily-report', '--data', inp.dataDir, '--day', older, '--now', NOW.toISOString()],
      { out: (x) => out.push(x), err: (x) => out.push(x) },
      repoRootOf(inp)
    );
    expect(code).toBe(0);
    expect(out.join('').trim()).toBe(path.join(inp.dataDir, reportPath(older)));
  });

  it('says what to run when the data branch was never fetched here', () => {
    const root = temp('ci-steward-repo-');
    writeRepo(baseSpec(), root);
    execFileSync('git', ['init', '.'], { cwd: root });
    const err: string[] = [];
    const code = main(
      ['daily-report', '--root', root, '--now', NOW.toISOString()],
      { out: () => {}, err: (s) => err.push(s) },
      root
    );
    expect(code).toBe(1);
    expect(err.join('')).toContain('git fetch origin ci-steward-data');
  });
});

/** The visible text of every element matching a class, whitespace collapsed. */
function cells(html: string, pattern: RegExp): string[] {
  return [...html.matchAll(pattern)].map((m) =>
    m[1]!
      .replace(/<svg[\s\S]*?<\/svg>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;|&#\d+;/g, 'x')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

describe('the copy rule', () => {
  /** A page with a trigger of several rules on it, rendered from real triage. */
  function busy() {
    const inp = recorded();
    const day = (over: Partial<Snapshot>) => snapshot(addDays(DAY, -2), over);
    const triggers = triage({
      files: inp.files,
      workflows: inp.workflows,
      ledger: [],
      verdicts: [],
      latest: inp.latest,
      snapshots: [
        day({
          counts: { ...emptySnapshot('x', 'x', 0).counts, ejections_failed_checks: 6 },
          ejections_caused: { 'wf.test.test': 6 },
          real_catches: { 'wf.test.test': 1 },
          main: [
            {
              sha: 'deadbeef',
              at: `${addDays(DAY, -2)}T01:00:00Z`,
              done: `${addDays(DAY, -2)}T01:00:00Z`,
              red: true,
            },
          ],
        }),
      ],
      prior: null,
      now: NOW,
    });
    return renderDailyReport({ ...inp, triggers }).html;
  }

  /** The same page, with an experiment whose reason is the long, date-listing kind. */
  function withVerdict(): string {
    const inp = recorded();
    const days = Array.from({ length: 13 }, (_, i) => addDays('2026-08-30', i));
    return renderDailyReport({
      ...inp,
      ledger: [
        {
          id: '260830-213616',
          title: 'Queue test sweep split across four shards',
          kind: 'experiment',
          status: 'active',
          actor: 'agent',
          gates: [],
          prs: [1391],
          'ratchet-release': [],
          'floor-release': [],
          'field-changes': [],
        },
      ],
      verdicts: [
        {
          schema: 1,
          id: '260830-213616',
          verdict: 'pending',
          reason: `Waiting for data: 13 day(s) of the after-window have no complete snapshot yet (${days.join(', ')}); the collector's backfill reaches them first.`,
          computed_at: `${DAY}T05:00:00Z`,
          hypothesis_hash: 'abc',
          metric: 'gate.wf.test.test-shard.duration_p50',
          anchor: `${DAY}T00:00:00Z`,
          prs: [1391],
          baseline: { value: 26, source: 'ledger' },
          target: 10,
          min_n: 10,
          before: { from: '', to: '', n: 10, value: 26 },
          after: { from: '', to: '', n: 10, value: 12.2 },
          confounders: [],
          // The movement line shares the cell with the reason, so the cap
          // has to hold for both together.
          slo: {
            id: 'queue-build',
            before: 41.6,
            after: 33,
            stat: 'p90',
            movement: 'better',
          },
        },
      ],
    }).html;
  }

  it('keeps every cell short: values under 40, names under 80, anything under 120', () => {
    // Every table on the page, not only the SLO one: the experiments table was
    // where a 313-character cell listing 13 dates one by one survived.
    const html = withVerdict();
    const long = cells(html, /<td class="num[^"]*"[^>]*>([\s\S]*?)<\/td>/g).filter(
      (c) => c.length > 40
    );
    expect(long).toEqual([]);
    // A measure's own name is ours to keep short; a ledger entry's title is
    // its name and is never truncated, so it lives under the 120 cap instead.
    const names = cells(html, /<td class="measure"[^>]*>([\s\S]*?)<\/td>/g).filter(
      (c) => c.length > 80
    );
    expect(names).toEqual([]);
    const all = cells(html, /<td[^>]*>([\s\S]*?)<\/td>/g).filter((c) => c.length > 120);
    expect(all).toEqual([]);
    // The selector really found both tables' cells, so the check means something.
    expect(cells(html, /<td[^>]*>([\s\S]*?)<\/td>/g).length).toBeGreaterThanOrEqual(10);
  });

  it('compresses consecutive dates into a run, and keeps a gap a gap', () => {
    expect(
      shorten('Waiting for data: 13 day(s) (2026-08-30, 2026-08-31, 2026-09-01, 2026-09-11).')
    ).toBe('Waiting for data: 13 days (2026-08-30 to 09-01, 09-11).');
    expect(shorten('1 day(s) left')).toBe('1 day left');
    expect(shorten('no day(s) here')).toBe('no days here');
    // Two dates are already as short as they get; they are left alone.
    expect(shorten('between 2026-08-30, 2026-09-11')).toBe('between 2026-08-30, 2026-09-11');
  });

  it('never drops a caveat and then writes a full stop', () => {
    // Both of these say the opposite of themselves without their last clause.
    const confounded =
      'gate.wf.test.test-shard.duration_p50 moved from 26 to 12.2, a 32% improvement on the objective; this is NOT attributable to the change, because 260824-121951 touched the same gate inside the window';
    const thin =
      'wf.test.test-shard failed 15% against 5%, which looks like a spike; the comparison window holds only 1 day of data, so it means nothing yet';
    for (const text of [confounded, thin]) {
      const out = shorten(text);
      expect(out.length).toBeLessThanOrEqual(120);
      // Either the caveat survives, or the sentence is visibly unfinished.
      expect(out.endsWith('…') || out.includes(text.split('; ')[1]!)).toBe(true);
      // Never a clean full stop on a sentence whose caveat was cut.
      expect(out.endsWith('objective.')).toBe(false);
      expect(out.endsWith('spike.')).toBe(false);
    }
    expect(shorten(confounded)).toContain('this is NOT');
    expect(shorten(thin)).toContain('holds only 1 day of data');
  });

  it('swaps a long wording for a true synonym before it cuts anything', () => {
    const out = shorten(
      "Waiting for data: 13 day(s) of the after-window have no complete snapshot yet (2026-08-30, 2026-08-31, 2026-09-01, 2026-09-11); the collector's backfill reaches them first."
    );
    expect(out).toBe(
      'Waiting: 13 days of the after-window not collected (2026-08-30 to 09-01, 09-11); backfill reaches them first.'
    );
    expect(out.endsWith('…')).toBe(false);
  });

  it('bans the filler words', () => {
    const banned = /\b(actually|simply|just|please note|it is worth noting|in order to)\b/i;
    const pages = [
      busy(),
      withVerdict(),
      renderDailyReport(recorded()).html,
      readFileSync(TEMPLATE, 'utf8'),
    ];
    for (const page of pages) {
      const body = page.slice(page.indexOf('<body>'));
      const hit = banned.exec(body.replace(/<[^>]+>/g, ' '));
      expect(hit?.[0] ?? null).toBeNull();
    }
  });
});

describe('the template', () => {
  it('keeps its styling in the template file, where the engine does not reach', () => {
    const text = readFileSync(TEMPLATE, 'utf8');
    expect(text).toContain('<style>');
    expectOffline(text);
    for (const slot of ['{{headline}}', '{{{slos}}}', '{{{triggers}}}', '{{footer}}'])
      expect(text).toContain(slot);
  });

  it('renders the same bytes from the same inputs', () => {
    const inp = recorded();
    expect(renderDailyReport(inp).html).toBe(renderDailyReport(inp).html);
  });
});
