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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../cli.ts';
import {
  renderDailyReport,
  renderIndex,
  reportPath,
  updateIndex,
  type DailyReportInput,
  type ReportIndex,
} from '../daily-report.ts';
import { emptySnapshot, gateKey, writeData, type Latest, type Snapshot } from '../data.ts';
import { esc, fill, h, raw, sparkline } from '../html.ts';
import { loadHandFiles } from '../load.ts';
import { addDays } from '../time.ts';
import { triage, type Triggers } from '../triggers.ts';
import { baseSpec, writeRepo } from './fixture.ts';

const DAY = '2026-09-19';
const NOW = new Date(`${DAY}T05:00:00Z`);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

/** A data directory holding a week of recorded days, and the repo that reads it. */
function recorded(over: Partial<Latest> = {}): DailyReportInput {
  const root = temp('ci-steward-repo-');
  writeRepo(baseSpec(), root);
  const dataDir = temp('ci-steward-data-');
  for (const d of Array.from({ length: 14 }, (_, i) => addDays(DAY, -13 + i)))
    writeData(dataDir, `snapshots/${d}.json`, snapshot(d));
  const l = latest(over);
  writeData(dataDir, 'latest.json', l);
  return {
    files: loadHandFiles(root).files!,
    dataDir,
    day: DAY,
    latest: l,
    triggers: null,
    verdicts: [],
    ledger: [],
    now: NOW,
  };
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
    // No network: nothing is fetched when the page is opened from a file.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('<script');
  });

  it('says everything is healthy, in plain words, when nothing fired', () => {
    const inp = recorded();
    const { html, index } = renderDailyReport({
      ...inp,
      triggers: triage({
        files: inp.files,
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
    expect(html).toContain('Everything is healthy.');
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
    expect(html).toContain('open 30 days');
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

describe('the template', () => {
  it('keeps its styling in the template file, where the engine does not reach', () => {
    const file = path.resolve(import.meta.dirname, '..', '..', 'templates', 'report.html');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('<style>');
    // No network at all: no web font, no CDN, no script tag.
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain('<script');
    for (const slot of ['{{headline}}', '{{{slos}}}', '{{{triggers}}}', '{{footer}}'])
      expect(text).toContain(slot);
  });

  it('renders the same bytes from the same inputs', () => {
    const inp = recorded();
    expect(renderDailyReport(inp).html).toBe(renderDailyReport(inp).html);
  });
});
