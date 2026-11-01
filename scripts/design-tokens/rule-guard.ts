/**
 * The design-token gate's rule guard (DOR-3557): with `--base`, refuse a PR
 * that removes a rule the base defined, or changes one in a way that could
 * match less, unless a fresh `guard-rule-change` label covers it.
 *
 * WHY A SEPARATE FILE. The base's rules are read by importing the base's copy
 * of `scripts/check-design-tokens.ts` from a scratch directory, so that file
 * must import nothing relative. Its `main` loads this one only when it runs.
 *
 * WHAT THE LABEL PROVES, AND WHAT IT DOES NOT. It proves a person added it to
 * the PR after every push of the head being checked: after the activity feed's
 * push, any force push, the head's committer date and its first check suite.
 * The head-time rule is the security gate's own (`labelNewerThanHead` in
 * `.github/scripts/security-label-at-head.mjs`), not a copy. It does not prove
 * who: "only Security adds `guard-rule-change`" is a team rule, NOT enforced,
 * because agents can label as Dorian (posture item 22). Once agents have their
 * own GitHub identities, this check should also require that Security added
 * it. And the gate runs from the PR's own tree, so a PR that edits this file
 * can edit this check; reading its diff is still the review.
 *
 * @module scripts/design-tokens/rule-guard
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  COVERAGE,
  DesignTokensError,
  OVERRIDE_LABEL,
  RULES,
  RULE_HELPERS,
  SCRIPT_PATH,
  type Finding,
  type Rule,
} from '../check-design-tokens.ts';

/** One tree's rules, with what they share. */
export interface RuleSet {
  rules: Rule[];
  /** That tree's `RULE_HELPERS`; absent on a base older than DOR-3557. */
  helpers?: Record<string, unknown> | undefined;
  /** That tree's `COVERAGE`; absent on a base older than DOR-3557. */
  coverage?: unknown;
}

/** A value as text, so a RegExp or a function compares by its source. */
function spelled(value: unknown): unknown {
  if (value instanceof RegExp) return `${value}`;
  if (typeof value === 'function') return value.toString();
  if (Array.isArray(value)) return value.map(spelled);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, spelled(v)])
    );
  return value ?? null;
}

/**
 * A rule's matching fields as one string: id, kind, pattern, only, except,
 * files and count, plus its tree's helpers when it has a `count`. `fix` is
 * left out, since rewording advice matches nothing differently.
 */
export function fingerprint(rule: Rule, helpers: RuleSet['helpers']): string {
  const { id, kind, pattern, only, except, files, count } = rule;
  return JSON.stringify(
    spelled({
      id,
      kind,
      pattern,
      only,
      except,
      files,
      count,
      helpers: count ? (helpers ?? 'unknown') : null,
    })
  );
}

/**
 * The base's rules this tree removed or changed, one line each. Any difference
 * counts as one that could match less, since telling a tighter regex from a
 * looser one is not decidable here. A rule this tree adds is not listed:
 * `seedableRules` and `raisedAgainst` hold a new one.
 */
export function ruleChanges(base: RuleSet, head: RuleSet): string[] {
  const out: string[] = [];
  if (
    JSON.stringify(spelled(base.coverage ?? 'unknown')) !== JSON.stringify(spelled(head.coverage))
  )
    out.push('what every rule reads (COVERAGE) changed');
  for (const rule of base.rules) {
    const now = head.rules.find((r) => r.id === rule.id);
    if (!now) out.push(`rule ${rule.id} was removed`);
    else if (fingerprint(rule, base.helpers) !== fingerprint(now, head.helpers))
      out.push(`rule ${rule.id} changed`);
  }
  return out;
}

/** Whether `value` has a rule's shape, so a base's RULES can be compared. */
function isRule(value: unknown): value is Rule {
  const r = value as Partial<Rule> | null;
  return Boolean(
    r &&
    typeof r.id === 'string' &&
    (r.kind === 'hard' || r.kind === 'ratchet') &&
    r.pattern instanceof RegExp &&
    (r.count === undefined || typeof r.count === 'function')
  );
}

/**
 * The rules `ref` defined, by importing its copy of the gate from a scratch
 * directory. The base is trusted: it is main, or the branch the PR targets.
 * Anything unreadable fails closed.
 */
export async function rulesAt(root: string, ref: string): Promise<RuleSet> {
  let text: string;
  try {
    text = execFileSync('git', ['show', `${ref}:${SCRIPT_PATH}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new DesignTokensError(`cannot read ${SCRIPT_PATH} at ${ref}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'design-tokens-base-'));
  try {
    const file = join(dir, 'check-design-tokens.ts');
    writeFileSync(file, text);
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const rules = mod.RULES;
    if (!Array.isArray(rules) || !rules.length || !rules.every(isRule))
      throw new Error('no readable RULES');
    return { rules, helpers: mod.RULE_HELPERS as RuleSet['helpers'], coverage: mod.COVERAGE };
  } catch (err) {
    throw new DesignTokensError(
      `cannot parse the rules at ${ref}: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The GitHub reads the override needs. `githubApi` in security-gate.mjs provides them. */
export interface OverrideApi {
  pr(number: number): Promise<{ head: { sha: string; ref: string }; labels?: { name: string }[] }>;
  timeline(number: number): Promise<object[]>;
  activity(ref: string): Promise<object[]>;
  commit(sha: string): Promise<{ commit?: { committer?: { date?: string } } }>;
  checkSuites(sha: string): Promise<{ created_at: string }[]>;
  queue(baseRef: string): Promise<object[]>;
  compare(base: string, head: string): Promise<object>;
}

/** A merge queue entry, as the gate's `groupMembers` returns it. */
interface QueueEntry {
  pullRequest: { number: number; headRefOid: string };
  baseCommit: { oid: string };
  headCommit: { oid: string };
}

/** What the override reuses from the security gate, so each rule has one copy. */
export interface Gate {
  labelNewerThanHead(input: {
    name: string;
    sha: string;
    ref: string;
    labels: { name: string }[];
    timeline: object[];
    activity: object[];
    after: (string | undefined)[];
  }): { passed: boolean; reason: string };
  firstCheckSuite(suites: { created_at: string }[]): string | undefined;
  groupMembers(entries: object[], group: { head_sha: string; base_sha: string }): QueueEntry[];
  queuedSensitiveDiff(
    api: OverrideApi,
    base: string,
    sha: string,
    pattern: string
  ): Promise<boolean>;
}

/** The event the check runs under: `GITHUB_EVENT_NAME` and the parsed `GITHUB_EVENT_PATH`. */
export interface OverrideEvent {
  name: string | undefined;
  payload: {
    pull_request?: { number: number; head: { sha: string } };
    merge_group?: { base_ref: string; base_sha: string; head_sha: string };
  };
}

/** A verdict and the reason a person reads. */
export interface Verdict {
  passed: boolean;
  reason: string;
}

/** The gate file, as the pattern `queuedSensitiveDiff` takes. */
const SCRIPT_PATTERN = `^${SCRIPT_PATH.replace(/\./g, '\\.')}$`;

/** Whether PR `number`'s label is newer than every push of `sha`. */
async function labelCovers(
  api: OverrideApi,
  gate: Gate,
  number: number,
  sha: string
): Promise<Verdict> {
  const pr = await api.pr(number);
  if (pr.head.sha !== sha) return { passed: false, reason: `#${number}'s head moved from ${sha}` };
  const [timeline, activity, commit, suites] = await Promise.all([
    api.timeline(number),
    api.activity(pr.head.ref),
    api.commit(sha),
    api.checkSuites(sha),
  ]);
  const verdict = gate.labelNewerThanHead({
    name: OVERRIDE_LABEL,
    sha,
    ref: pr.head.ref,
    labels: pr.labels ?? [],
    timeline,
    activity,
    after: [commit.commit?.committer?.date, gate.firstCheckSuite(suites)],
  });
  return { passed: verdict.passed, reason: `#${number}: ${verdict.reason}` };
}

/**
 * Whether a `guard-rule-change` label covers this run's rule changes.
 *
 * - `pull_request`: the PR's own label, newer than its head.
 * - `merge_group`: a group has no labels, so each PR in it is read the way the
 *   security gate's `checkMergeGroup` reads them. Every PR whose queued diff
 *   touches the gate file needs its own fresh label, at least one must touch
 *   it, and the queue must not change while it is read.
 * - anything else has no PR to read a label from, and refuses.
 *
 * Any failed read refuses.
 */
export async function overrideCovers(
  api: OverrideApi | null,
  gate: Gate | null,
  event: OverrideEvent
): Promise<Verdict> {
  try {
    if (!api || !gate) return { passed: false, reason: 'no GitHub token to read the label with' };
    if (event.name === 'pull_request' && event.payload.pull_request) {
      const { number, head } = event.payload.pull_request;
      return await labelCovers(api, gate, number, head.sha);
    }
    if (event.name === 'merge_group' && event.payload.merge_group) {
      const group = event.payload.merge_group;
      const members = gate.groupMembers(await api.queue(group.base_ref), group);
      const reasons: string[] = [];
      for (const entry of members) {
        const { baseCommit, headCommit, pullRequest } = entry;
        if (!(await gate.queuedSensitiveDiff(api, baseCommit.oid, headCommit.oid, SCRIPT_PATTERN)))
          continue;
        const verdict = await labelCovers(api, gate, pullRequest.number, pullRequest.headRefOid);
        if (!verdict.passed) return verdict;
        reasons.push(verdict.reason);
      }
      if (!reasons.length)
        return { passed: false, reason: `no PR in the group touches ${SCRIPT_PATH}` };
      const now = gate.groupMembers(await api.queue(group.base_ref), group);
      if (JSON.stringify(now) !== JSON.stringify(members))
        return { passed: false, reason: 'the merge queue changed while the labels were read' };
      return { passed: true, reason: reasons.join('; ') };
    }
    return { passed: false, reason: `no PR to read a ${OVERRIDE_LABEL} label from` };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { passed: false, reason: `cannot read the ${OVERRIDE_LABEL} label: ${why}` };
  }
}

/** The GitHub client and gate helpers when this run has a token, or nulls. */
async function githubFromEnv(): Promise<{ api: OverrideApi | null; gate: Gate | null }> {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL } = process.env;
  if (!GH_TOKEN || !GITHUB_REPOSITORY) return { api: null, gate: null };
  // Specifiers in variables, so TypeScript takes the interfaces above for them.
  const gatePath = new URL('../../.github/scripts/security-gate.mjs', import.meta.url).href;
  const labelPath = new URL('../../.github/scripts/security-label-at-head.mjs', import.meta.url)
    .href;
  const gateMod = (await import(gatePath)) as Gate & {
    githubApi(repo: string, token: string, apiUrl?: string): OverrideApi;
  };
  const labelMod = (await import(labelPath)) as Gate;
  return {
    api: gateMod.githubApi(GITHUB_REPOSITORY, GH_TOKEN, GITHUB_API_URL),
    gate: {
      labelNewerThanHead: labelMod.labelNewerThanHead,
      firstCheckSuite: labelMod.firstCheckSuite,
      groupMembers: gateMod.groupMembers,
      queuedSensitiveDiff: gateMod.queuedSensitiveDiff,
    },
  };
}

function eventFromEnv(): OverrideEvent {
  const { GITHUB_EVENT_NAME, GITHUB_EVENT_PATH } = process.env;
  if (!GITHUB_EVENT_PATH) return { name: GITHUB_EVENT_NAME, payload: {} };
  try {
    return {
      name: GITHUB_EVENT_NAME,
      payload: JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8')) as OverrideEvent['payload'],
    };
  } catch {
    throw new DesignTokensError(`cannot read the event at ${GITHUB_EVENT_PATH}`);
  }
}

/**
 * The CI events with no PR behind them. The canary runs on main, already past
 * the queue, and a dispatch is a person's re-run; neither merges anything, and
 * a canary after a labelled rule change would otherwise fail for good.
 */
const NOT_A_MERGE = new Set(['schedule', 'workflow_dispatch']);

/**
 * Compare `ref`'s rules with this tree's and refuse what no label covers.
 *
 * @returns The findings, and the base's rule ids for `seedableRules`.
 */
export async function checkRules(
  root: string,
  ref: string
): Promise<{ findings: Finding[]; baseIds: string[] }> {
  const base = await rulesAt(root, ref);
  const baseIds = base.rules.map((r) => r.id);
  const changes = ruleChanges(base, { rules: RULES, helpers: RULE_HELPERS, coverage: COVERAGE });
  const event = eventFromEnv();
  if (!changes.length) return { findings: [], baseIds };
  if (event.name && NOT_A_MERGE.has(event.name)) {
    console.log(`design-tokens: ${changes.join('; ')}; not checked on ${event.name}.`);
    return { findings: [], baseIds };
  }
  const { api, gate } = await githubFromEnv();
  const verdict = await overrideCovers(api, gate, event);
  if (verdict.passed) {
    console.log(
      `design-tokens: ${changes.join('; ')}; covered by ${OVERRIDE_LABEL} (${verdict.reason}).`
    );
    return { findings: [], baseIds };
  }
  const findings = changes.map((change): Finding => ({
    kind: 'rule',
    rule: change,
    file: SCRIPT_PATH,
    count: 0,
    detail: `${change} against ${ref}, and no ${OVERRIDE_LABEL} label covers it (${verdict.reason})`,
  }));
  return { findings, baseIds };
}
