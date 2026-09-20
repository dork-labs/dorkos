/**
 * `ci-steward status` (`pnpm ci:status`, the `/ci-status` skill): one screen
 * joining the ledger on `main` with what the data branch computed. The SLO
 * table, the constraint, the open improvement triggers, every experiment with
 * its verdict, and the collector's health.
 *
 * It reads the data branch through git (`git show origin/ci-steward-data:...`),
 * with no network, so it shows what the last fetch brought. `ci:pulse` renders
 * the same view from a fresh local collection instead.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LatestSchema, VerdictSchema, type Latest, type Verdict } from './data.ts';
import { openDays, TriggersSchema } from './triggers.ts';
import type { LedgerEntry } from './verdicts.ts';

/** Reads data-branch files from somewhere. */
export interface DataReader {
  /** A human label for where the data came from. */
  label: string;
  read(rel: string): string | null;
  list(dir: string): string[];
}

/**
 * Read the data branch through git objects, without touching the network.
 *
 * @param root - A checkout of the repository.
 * @param ref - The ref, e.g. `origin/ci-steward-data`.
 */
export function gitReader(root: string, ref: string): DataReader | null {
  const run = (args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    return null;
  }
  return {
    label: ref,
    read: (rel) => {
      try {
        return run(['show', `${ref}:${rel}`]);
      } catch {
        return null;
      }
    },
    list: (dir) => {
      try {
        return run(['ls-tree', '--name-only', `${ref}:${dir}`])
          .split('\n')
          .filter(Boolean)
          .sort();
      } catch {
        return [];
      }
    },
  };
}

/**
 * Read a working tree or a pulse's temp directory.
 *
 * @param dir - The directory.
 */
export function dirReader(dir: string): DataReader {
  return {
    label: dir,
    read: (rel) =>
      existsSync(path.join(dir, rel)) ? readFileSync(path.join(dir, rel), 'utf8') : null,
    list: (d) => (existsSync(path.join(dir, d)) ? readdirSync(path.join(dir, d)).sort() : []),
  };
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

function sloTable(latest: Latest): string[] {
  const rows = latest.slos.map((r) => {
    const stats = Object.entries(r.stats)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    return [r.id, r.status, stats || '-', `n=${r.n}/${r.min_n}`, r.note ?? ''];
  });
  const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i]!.length), 4));
  return rows.map((r) => `  ${r.map((c, i) => (i < 4 ? pad(c, w[i]!) : c)).join('  ')}`.trimEnd());
}

/**
 * Render the status screen.
 *
 * @param reader - Where the data branch is read from, or `null` when it does not exist.
 * @param ledger - The ledger entries on this checkout.
 * @param now - The clock (for the snapshot's age).
 */
export function renderStatus(
  reader: DataReader | null,
  ledger: readonly LedgerEntry[],
  now: Date
): string {
  const out: string[] = [];
  if (!reader) {
    out.push(
      'CI Steward: the ci-steward-data branch does not exist yet (or was never fetched).',
      'The daily collector (.github/workflows/ci-steward.yml) creates it on its first run. Until then:',
      '  - `git fetch origin ci-steward-data` if it should exist;',
      '  - `pnpm ci:pulse` collects now, locally, into a temp directory, and shows this screen from it.',
      ''
    );
  }
  const latestText = reader?.read('latest.json') ?? null;
  const latest = latestText ? LatestSchema.safeParse(JSON.parse(latestText)) : null;
  if (reader && !latest) out.push(`CI Steward: ${reader.label} has no latest.json yet.`, '');
  const verdicts = new Map<string, Verdict>();
  for (const f of reader?.list('verdicts') ?? []) {
    const text = reader!.read(`verdicts/${f}`);
    const v = text ? VerdictSchema.safeParse(JSON.parse(text)) : null;
    if (v?.success) verdicts.set(v.data.id, v.data);
  }
  if (latest?.success) {
    const l = latest.data;
    const ageH = Math.round((now.getTime() - Date.parse(l.collected_at)) / 3_600_000);
    out.push(
      `CI Steward status: data for ${l.date} from ${reader!.label}, collected ${ageH} h ago (${l.api_calls} API requests).`,
      `Health: ${l.healthy ? 'OK' : `FAILED (${l.failures.length})`}${l.safeguards_ok ? '' : '; DATA-BRANCH SAFEGUARDS NOT OK'}${ageH > 48 ? '; SNAPSHOT IS OVER 2 DAYS OLD' : ''}`
    );
    for (const f of l.failures) out.push(`  ! ${f}`);
    for (const w of l.warnings) out.push(`  - ${w}`);
    out.push(
      '',
      `Constraint: ${l.constraint.id ?? 'none'} (${l.constraint.tier}). ${l.constraint.reason}`,
      '',
      `SLOs, 7 days to ${l.date}:`
    );
    out.push(...sloTable(l));
    if (l.report_ref)
      out.push('', `Weekly deep summary: git show ${reader!.label}:${l.report_ref}`);
    out.push(`Daily report: git show ${reader!.label}:reports/${l.date}.html, or pnpm ci:report`);
  }
  const triggersText = reader?.read('triggers.json') ?? null;
  const triggers = triggersText ? TriggersSchema.safeParse(JSON.parse(triggersText)) : null;
  if (triggers?.success) {
    const t = triggers.data;
    out.push('', `Triggers (${t.open.length} open, computed ${t.date}):`);
    if (t.open.length === 0) out.push('  nothing is asking for attention');
    for (const x of t.open) {
      const age = openDays(x, t.date);
      out.push(
        `  [${x.severity}] ${x.id}${age > 0 ? ` (open ${age}d)` : ''}${x.ledger_entry ? ` (proposed: ${x.ledger_entry})` : ''}`,
        `      ${x.what}`,
        `      -> ${x.action}`
      );
    }
    if (t.cleared.length)
      out.push(`  cleared since the last run: ${t.cleared.map((c) => c.id).join(', ')}`);
  }
  const live = ledger.filter((e) => e.kind !== 'hygiene' && e.status !== 'withdrawn');
  const started = live.filter((e) => e.status !== 'proposed');
  out.push('', `Experiments (${started.length} live or reverted; hygiene entries not shown):`);
  for (const e of started.sort(
    (a, b) => a.status.localeCompare(b.status) || a.id.localeCompare(b.id)
  )) {
    const v = verdicts.get(e.id);
    const slo =
      v?.slo && (v.slo.before !== null || v.slo.after !== null)
        ? ` SLO ${v.slo.id} ${v.slo.movement} (${v.slo.before ?? '-'} -> ${v.slo.after ?? '-'}).`
        : '';
    out.push(
      `  ${e.id} ${pad(e.status, 8)} ${e.title}`,
      `      ${v ? `${v.verdict}: ${v.reason}${slo}` : 'no verdict yet'}`
    );
  }
  const proposed = live.filter((e) => e.status === 'proposed');
  if (proposed.length) {
    out.push('', `Proposed, not started (${proposed.length}):`);
    for (const e of proposed) out.push(`  ${e.id} ${e.title}`);
  }
  return `${out.join('\n')}\n`;
}
