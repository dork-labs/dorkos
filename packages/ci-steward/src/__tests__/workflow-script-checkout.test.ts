/**
 * A job that runs a repo script must have that script on disk (DOR-5130).
 *
 * On 2026-11-24 the merge queue ejected #4206 and every group behind it: the
 * new `attest` job ran `bash scripts/attest-pr-check.sh`, but its checkout was
 * a sparse checkout of `main`, and `main` had no such script until #4206
 * itself landed. bash exited 127 and four required checks went red. The job
 * runs only on `merge_group`, so no pull request run ever exercised it. This
 * suite reads every real workflow and fails the PR instead, on three rules:
 *
 * 1. A `run:` step that invokes a repo path (`bash scripts/…`, `./scripts/…`,
 *    `node scripts/…`, `bash .github/…`) or `pnpm` comes after an
 *    `actions/checkout` step in the same job. Before it the workspace is empty.
 * 2. If that checkout is sparse, the invoked file is inside it.
 * 3. In a job that runs in the merge queue but never on a pull request, a
 *    script read from a checkout of the default branch (not the commit under
 *    test) is guarded against being absent (`[ -f <path> ]` or `test -f`).
 *    The PR that adds the script reaches the queue before main has it, and
 *    nothing on its PR run would have shown that. A job that also runs on
 *    `pull_request` fails there first, in plain sight; one that runs only
 *    after merge (push, schedule, workflow_run) finds the script on main.
 *
 * Existing violations on main when this landed are listed in EXEMPT, each with
 * its reason, so a new one cannot hide among them.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflows } from '../workflows.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');

/** `<file>/<job>/<step key>` → why it is allowed to break a rule. */
const EXEMPT: Record<string, string> = {};

const workflows = loadWorkflows(REPO, '.github/workflows', (file, message) => {
  throw new Error(`${file}: ${message}`);
});

type Obj = Record<string, unknown>;

interface Checkout {
  /** Directory the checkout lands in, relative to the workspace ('' for the root). */
  dir: string;
  /** Non-null for a sparse checkout: its patterns. */
  sparse: string[] | null;
  /** True when it reads the default branch rather than the commit under test. */
  readsMain: boolean;
}

const MAIN_REFS = [/default_branch/, /^main$/, /^refs\/heads\/main$/];

function checkoutOf(step: Obj): Checkout | null {
  if (typeof step.uses !== 'string' || !step.uses.startsWith('actions/checkout@')) return null;
  const w = (typeof step.with === 'object' && step.with !== null ? step.with : {}) as Obj;
  const ref = typeof w.ref === 'string' ? w.ref.trim() : '';
  const sparse =
    typeof w['sparse-checkout'] === 'string'
      ? w['sparse-checkout']
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : null;
  return {
    dir: typeof w.path === 'string' ? w.path.replace(/^\.\/|\/$/g, '') : '',
    sparse,
    readsMain: MAIN_REFS.some((re) => re.test(ref)),
  };
}

/** Repo-relative files a run block executes, plus `pnpm` when it calls pnpm. */
function invoked(run: string): string[] {
  const out = new Set<string>();
  // Drop comment lines so prose cannot fake or hide a call.
  const body = run
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  const file =
    /(?:^|[\s;&|(`])(?:(?:bash|sh|node|tsx|python3?)\s+(?:-\S+\s+)*)?(\.\/)?((?:scripts|\.github)\/[A-Za-z0-9._/-]+\.(?:sh|ts|mjs|cjs|js|py))\b/g;
  for (const m of body.matchAll(file)) {
    out.add(m[2] as string);
  }
  if (/(?:^|[\s;&|(`])pnpm\s+(?!dlx\b)/m.test(body)) out.add('pnpm');
  return [...out];
}

/** Whether a sparse pattern list (cone mode off: paths or dirs) covers a file. */
function sparseCovers(patterns: string[], file: string): boolean {
  return patterns.some((p) => {
    const pat = p.replace(/^\//, '');
    return (
      pat === file || (pat.endsWith('/') && file.startsWith(pat)) || file.startsWith(`${pat}/`)
    );
  });
}

interface Violation {
  site: string;
  rule: string;
}

/**
 * Whether a job runs in the merge queue but is never exercised by a pull
 * request run: its workflow has `merge_group` and either no `pull_request`
 * trigger or a job `if:` that names `merge_group` alone.
 */
function queueOnly(
  wf: (typeof workflows)[number],
  job: (typeof workflows)[number]['jobs'][number]
) {
  if (!wf.triggers.has('merge_group')) return false;
  const onPr = wf.triggers.has('pull_request') || wf.triggers.has('pull_request_target');
  if (!onPr) return true;
  const cond = typeof job.if === 'string' ? job.if : '';
  return /github\.event_name\s*==\s*'merge_group'/.test(cond) && !/pull_request/.test(cond);
}

function violations(): Violation[] {
  const found: Violation[] = [];
  for (const wf of workflows) {
    for (const job of wf.jobs) {
      const inQueueOnly = queueOnly(wf, job);
      let checkout: Checkout | null = null;
      for (const s of job.steps) {
        const step = JSON.parse(s.text) as Obj;
        const co = checkoutOf(step);
        if (co) {
          // A checkout into a subdirectory does not put the repo at the root.
          if (co.dir === '') checkout = co;
          continue;
        }
        if (!s.run) continue;
        const site = `${wf.file}/${job.id}/${s.key}`;
        // A step with its own `working-directory` resolves paths elsewhere;
        // the root workspace is what these rules are about.
        if (typeof step['working-directory'] === 'string') continue;
        for (const target of invoked(s.run)) {
          if (!checkout) {
            found.push({ site, rule: `runs ${target} before any actions/checkout` });
            continue;
          }
          if (target === 'pnpm') continue;
          if (checkout.sparse && !sparseCovers(checkout.sparse, target)) {
            found.push({ site, rule: `runs ${target}, which its sparse checkout leaves out` });
          }
          const guarded = new RegExp(
            `(?:\\[\\s+!?\\s*-[fe]|test\\s+!?\\s*-[fe])\\s+"?(?:\\./)?${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
          ).test(s.run);
          if (inQueueOnly && checkout.readsMain && !guarded) {
            found.push({
              site,
              rule: `runs ${target} from main's checkout in a queue-only job without a [ -f ] guard; the PR that adds it would exit 127 in the queue`,
            });
          }
        }
      }
    }
  }
  return found;
}

describe('a job runs only repo scripts it has checked out', () => {
  const all = violations();

  it('reads the workflows (a silent no-op would pass everything)', () => {
    expect(workflows.length).toBeGreaterThan(20);
    const attest = workflows.flatMap((w) => w.jobs.filter((j) => j.id === 'attest'));
    expect(attest.length).toBeGreaterThanOrEqual(4);
  });

  it('has no violation outside EXEMPT', () => {
    const unexpected = all.filter((v) => !(v.site in EXEMPT)).map((v) => `${v.site}: ${v.rule}`);
    expect(unexpected).toEqual([]);
  });

  it('has no stale EXEMPT entry', () => {
    const sites = new Set(all.map((v) => v.site));
    expect(Object.keys(EXEMPT).filter((k) => !sites.has(k))).toEqual([]);
  });
});

describe('the rules catch the shapes they are for', () => {
  it('finds script calls and pnpm, and ignores comments and pnpm dlx', () => {
    expect(invoked('bash scripts/a.sh x >> "$GITHUB_OUTPUT"')).toEqual(['scripts/a.sh']);
    expect(invoked('./scripts/b.sh\nnode scripts/c.ts')).toEqual(['scripts/b.sh', 'scripts/c.ts']);
    expect(invoked('bash .github/scripts/d.sh')).toEqual(['.github/scripts/d.sh']);
    expect(invoked('pnpm install --frozen-lockfile')).toEqual(['pnpm']);
    expect(invoked('pnpm dlx foo')).toEqual([]);
    expect(invoked('# bash scripts/x.sh\necho hi')).toEqual([]);
  });

  it('reads a sparse checkout', () => {
    expect(sparseCovers(['scripts/a.sh', 'scripts/b.sh'], 'scripts/a.sh')).toBe(true);
    expect(sparseCovers(['scripts/a.sh'], 'scripts/c.sh')).toBe(false);
    expect(sparseCovers(['scripts'], 'scripts/c.sh')).toBe(true);
    expect(sparseCovers(['/.github/'], '.github/x.sh')).toBe(true);
  });
});
