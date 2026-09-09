/**
 * The reason-vocabulary guard — the pin that keeps this engine's sentences
 * inside the vocabulary the rest of the product is held to.
 *
 * Every `reason` string this package emits is now shown to a person. The Skills
 * page draws them verbatim under each chip, in the "Not shared with `<harness>`"
 * panels, in the removal disclosure and in the "what changed" summary
 * (`entities/harness`), and `dorkos harness sync` prints the same words in a
 * terminal. So they are product copy that happens to live in a package — and
 * they were never checked, because **neither vocabulary gate can reach here**:
 * `scripts/check-vocab-gate.ts` scans three `apps/<app>/src` roots and
 * `scripts/check-banned-words.sh` scans a literal file list plus `docs/` and
 * `blog/`. One string had gone stale by the time anybody looked
 * (`NON_PORTABLE_LAYER_REASONS.adapters`), and a hand sweep would have gone
 * stale again the next wave.
 *
 * ## It reads the list rather than restating it
 *
 * The terms come from `scripts/vocab-gate/banned-terms.json`, the same file the
 * app's gate reads, so a wave added there reaches this package on the day it
 * reaches the app and this file never becomes a second list to keep in step.
 *
 * ## The one carve-out, and why it is this narrow
 *
 * ADR `260804-021140` retired "adapter"/"adapters" as a user-facing noun and
 * kept it as the name of a marketplace package LAYER — the word a package author
 * writes in their own manifest. So `plugin layer "adapters" …` is correct and
 * `messaging adapters run inside DorkOS` was not. The exemption is therefore
 * scoped to a quoted span whose WHOLE content is one of the nine layer names a
 * package manifest may declare (`@dorkos/marketplace`'s `LAYER_LABELS`), never
 * to quoted text in general: quoting a sentence must not launder it.
 *
 * ## What it covers, and what it does not
 *
 * Every sentence the ENGINE writes: the note on an action, the reason on a
 * drop, a `ProjectionWarning`, what `checkPlan().blocked` says is in the way of
 * a write (the `conflict` chip), what a sweep removes, and what `manifestNotices`
 * says is wrong with the manifest itself. Two of those are TABLES rather than
 * per-tree answers — `SWEEP_REASONS` and {@link BLOCKED_REASONS} — so both are
 * enumerated whole as well as produced by the fixture: which entry a tree trips
 * depends on what somebody happened to leave lying at a target.
 *
 * What it does NOT cover, and does not need to:
 *
 * - **Anything the client writes.** The seven chip words, the "Not shared with
 *   `<harness>`" heading, the not-enabled sentence and every page state live in
 *   `apps/client/src`, which `check-vocab-gate.ts` already scans. That is also
 *   why `plan.notEnabled` is not collected here: its `signal` is a PATH.
 * - **Anything the server writes.** The `pending-approval` copy and the status
 *   envelope's own strings are in `apps/server/src`, scanned by the same gate.
 *
 * ## Nothing zero-subject
 *
 * Three floors, all asserted before anything else is: the waves parsed, the
 * terms parsed, and the reasons the fixture produced. Without them a loader
 * pointed at a missing file, or a fixture that stopped building a plan, would
 * report a perfectly clean vocabulary over nothing at all. A fourth assertion
 * names each family the fixture has to reach, because a count can be met by one
 * family repeated.
 *
 * @module __tests__/reason-vocabulary
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LAYER_LABELS } from '@dorkos/marketplace';
import {
  loadBannedTerms,
  termMatcher,
  type BannedTerm,
} from '../../../../scripts/check-vocab-gate.js';
import { loadManifest, project } from '../engine.js';
import { checkPlan } from '../apply/apply.js';
import { manifestNotices } from '../manifest/notices.js';
import { SWEEP_REASONS } from '../apply/sweep-reasons.js';
import { GENERATE_DIRECTORY_REASON, GENERATE_SYMLINK_REASON } from '../apply/generate-occupants.js';
import { HAND_WRITTEN_HOOKS_REASON } from '../apply/generated-ownership.js';
import {
  SYMLINKS_OFF_REASON,
  SYMLINK_DIRECTORY_REASON,
  SYMLINK_FILE_REASON,
} from '../apply/symlink-occupants.js';

/** Where the term list lives, relative to this file. Its own constant so a seeded defect can move it. */
const BANNED_TERMS_PATH = join(
  import.meta.dirname,
  '../../../../scripts/vocab-gate/banned-terms.json'
);

/**
 * The nine layer names a package author may write, which are the only words the
 * carve-out below exempts.
 */
const PACKAGE_LAYER_NAMES = new Set(Object.keys(LAYER_LABELS));

/**
 * Every sentence `checkPlan().blocked` can carry, in one place, for the reason
 * {@link SWEEP_REASONS} is iterated whole: a blocked cell reads `conflict` on
 * the page and prints under `--check` in the terminal, and which of the six a
 * tree happens to trip is an accident of that tree. The engine writes these
 * one per module rather than in one table, so this is the table.
 */
const BLOCKED_REASONS = [
  SYMLINKS_OFF_REASON,
  SYMLINK_DIRECTORY_REASON,
  SYMLINK_FILE_REASON,
  GENERATE_DIRECTORY_REASON,
  GENERATE_SYMLINK_REASON,
  HAND_WRITTEN_HOOKS_REASON,
] as const;

/** Everything staged on disk, removed once the suite is done with it. */
const staged: string[] = [];
afterAll(() => {
  for (const dir of staged) rmSync(dir, { recursive: true, force: true });
});

/** Write a file, creating the directories above it. */
function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

/** Write one package manifest for an installed plugin at `root`. */
function stagePackage(root: string, name: string, layers: string[], skills: string[]): void {
  write(
    join(root, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      version: '1.0.0',
      type: 'plugin',
      description: `${name} test package`,
      layers,
    })
  );
  for (const skill of skills) write(join(root, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
}

/**
 * A repository shaped to make the engine say as many DIFFERENT things as one
 * tree can.
 *
 * Every element earns a family of reason, and the assertion below names which:
 * an authored skill and a harness-native one (per-harness placements and the
 * adoptable advice), a subagent, a rule and an `.mcp.json` (the kinds the
 * engine reports rather than projects), personal hooks, a dead `.claude/skills`
 * link (a sweep), somebody's own file where a skill link goes and a
 * hand-written `.codex/hooks.json` where the engine generates one (two of the
 * blocked sentences), a project package declaring every non-portable layer
 * there is (the layer drops, including the one this guard was written for), the
 * same package installed for all projects as well (the both-scopes notice), two
 * more global-only packages (both global-install forms), an unreadable package
 * hooks file (a warning), and a manifest carrying a retired key and two useless
 * hook policies (the notices).
 *
 * The two harnesses whose own files are here and which the manifest does not
 * enable stay for a different reason — they are not vocabulary, see
 * {@link collectReasons}.
 */
function stageFixture(): { repoRoot: string; dorkHome: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'harness-vocab-repo-'));
  const dorkHome = mkdtempSync(join(tmpdir(), 'harness-vocab-home-'));
  staged.push(repoRoot, dorkHome);

  write(
    join(repoRoot, '.agents', 'harness.manifest.json'),
    JSON.stringify({
      version: 1,
      harnesses: ['claude-code', 'codex', 'opencode', 'cursor'],
      // Two notices about hook policies: one names a harness this manifest does
      // not enable, one names something that is not a harness at all.
      hookPolicies: [
        { tool: 'gemini', projection: 'none' },
        { tool: 'not-an-agent', projection: 'none' },
      ],
      // A retired key: accepted, ignored, and named.
      skillBundles: {},
    })
  );

  // The canonical layer, and a skill kept where only Claude Code looks.
  write(join(repoRoot, '.agents', 'skills', 'ship-it', 'SKILL.md'), '# ship-it\n');
  write(join(repoRoot, '.claude', 'skills', 'claude-only', 'SKILL.md'), '# claude-only\n');

  // The kinds the engine reports rather than projects.
  write(join(repoRoot, '.claude', 'agents', 'reviewer.md'), '# reviewer\n');
  write(join(repoRoot, '.claude', 'rules', 'style.md'), '# style\n');
  write(join(repoRoot, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'x' } } }));
  write(
    join(repoRoot, '.claude', 'settings.local.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } })
  );

  // A dead link, so a sweep has something to explain.
  symlinkSync(
    join('..', '..', '.agents', 'skills', 'deleted-skill'),
    join(repoRoot, '.claude', 'skills', 'deleted-skill')
  );

  // Two things in the way, so the blocked family is PRODUCED and not only
  // enumerated: somebody's own file where the canonical skill's link goes, and
  // a hand-written hooks file at a path the engine generates from
  // `.claude/settings.json`. A plain file rather than a directory for the
  // first, deliberately — a directory holding a `SKILL.md` would be a skill in
  // both roots, which earns a different sentence.
  writeFileSync(join(repoRoot, '.claude', 'skills', 'ship-it'), 'somebody else wrote this\n');
  write(
    join(repoRoot, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } })
  );
  write(join(repoRoot, '.codex', 'hooks.json'), JSON.stringify({ description: 'mine', hooks: {} }));

  // A project package declaring every non-portable layer, with a hooks file
  // nothing can read.
  const projectPkg = join(repoRoot, '.dork', 'plugins', 'both-scopes');
  stagePackage(
    projectPkg,
    'both-scopes',
    ['skills', 'extensions', 'adapters', 'mcp-servers', 'lsp-servers', 'agents'],
    ['packaged']
  );
  write(join(projectPkg, 'hooks', 'hooks.json'), '{ not json');

  // The same package installed for all projects too, plus one global package
  // with skills and one with none.
  stagePackage(join(dorkHome, 'plugins', 'both-scopes'), 'both-scopes', ['skills'], ['packaged']);
  stagePackage(join(dorkHome, 'plugins', 'everywhere'), 'everywhere', ['skills'], ['broadcast']);
  stagePackage(join(dorkHome, 'plugins', 'nothing-here'), 'nothing-here', ['commands'], []);

  // Two harnesses whose own files are here and which the manifest leaves off.
  write(join(repoRoot, '.gemini', 'settings.json'), '{}');
  write(join(repoRoot, '.github', 'copilot-instructions.md'), '# copilot\n');

  return { repoRoot, dorkHome };
}

/** One reason string, with the part of the engine that produced it, for a readable failure. */
interface Reason {
  /** Which producer it came from. */
  family: string;
  /** The sentence a person reads. */
  text: string;
}

/** Every sentence this fixture can put in front of a person. */
function collectReasons(repoRoot: string, dorkHome: string): Reason[] {
  const plan = project(repoRoot, { dorkHome });
  const drift = checkPlan(repoRoot, plan);
  const found: Reason[] = [];
  const add = (family: string, text: string | undefined): void => {
    if (text !== undefined && text !== '') found.push({ family, text });
  };

  for (const action of plan.actions) add('action', action.reason);
  for (const drop of plan.drops) add('drop', drop.reason);
  for (const warning of plan.warnings) add('warning', warning.reason);
  for (const blocked of drift.blocked) add('blocked', blocked.reason);
  for (const removal of drift.removals) add('sweep', removal.reason);
  for (const notice of manifestNotices(loadManifest(repoRoot))) add('manifest-notice', notice);
  // Both tables in full, not only the causes this tree happens to trip. Six
  // sweep finders take files for five different reasons and each sentence
  // reaches the same removal disclosure (DOR-1895, DOR-1906); six blocked
  // reasons reach the `conflict` chip and the `--check` block, and which one a
  // tree trips depends on what somebody happened to leave at a target.
  for (const reason of Object.values(SWEEP_REASONS)) add('sweep', reason);
  for (const reason of BLOCKED_REASONS) add('blocked', reason);

  // `plan.notEnabled` is deliberately NOT collected. Its entries carry a
  // `signal` — `.gemini/`, `.github/copilot-instructions.md` — which is a PATH,
  // not a sentence: the words a person reads there are written by the client
  // (`NotEnabledNotice`, in `apps/client/src`, where `check-vocab-gate.ts`
  // already scans them). Counting a path as vocabulary coverage would be this
  // guard claiming a surface it does not check.

  return found;
}

/**
 * Blank out every quoted package-layer name, so the ADR's carve-out is exempt
 * and nothing else is.
 *
 * Replaced with spaces rather than removed, so a term can never be formed by
 * two halves closing up around the hole.
 */
function withoutQuotedLayerNames(text: string): string {
  return text.replace(/"([^"]*)"/g, (whole: string, inner: string) =>
    PACKAGE_LAYER_NAMES.has(inner) ? ' '.repeat(whole.length) : whole
  );
}

/** Blank the two temporary directories this fixture made, wherever a reason spells one out. */
function withoutFixturePaths(text: string): string {
  let redacted = text;
  for (const dir of staged) redacted = redacted.split(dir).join('<fixture>');
  return redacted;
}

/**
 * Every retired term a reason uses outside the carve-out.
 *
 * The fixture's own temporary directories are blanked first. Two reasons carry
 * an absolute repository path — the both-scopes notice spells out the uninstall
 * command — and that path is whatever `TMPDIR` happens to be on the machine
 * running this. It is not copy anybody wrote, so a `$TMPDIR` containing a
 * retired word would be a red about the runner rather than about the engine.
 */
function retiredTermsIn(text: string, terms: readonly BannedTerm[]): BannedTerm[] {
  const searchable = withoutQuotedLayerNames(withoutFixturePaths(text));
  return terms.filter((term) => termMatcher(term.term).test(searchable));
}

/**
 * The waves, read through the app's own loader — and answering an empty list
 * rather than throwing when the file is not where this expects it.
 *
 * Swallowing deliberately, and only here: the floor below is what this file
 * says about an empty list, and it says it with the path in the message. A
 * throw at module scope would take the floor with it and report the guard as a
 * broken suite rather than as the thing it is — a list that reached this
 * package with nothing in it.
 */
function bannedTerms(): BannedTerm[] {
  try {
    return loadBannedTerms(BANNED_TERMS_PATH);
  } catch {
    return [];
  }
}

const terms = bannedTerms();
const waves = new Set(terms.map((term) => term.wave));
const { repoRoot, dorkHome } = stageFixture();
const reasons = collectReasons(repoRoot, dorkHome);

describe('VC-02 — the sentences the engine shows a person', () => {
  it('VC-02: parsed the term list and built the plan, so nothing below can pass on nothing', () => {
    // Floors, not equalities: the point is that a wave ADDED to the term list
    // reaches this package, so growth must not red. What must red is shrinkage
    // — a loader pointed at a missing file, or a fixture that stopped
    // producing a plan, would otherwise report a spotless vocabulary over an
    // empty list. Measured 2026-09-09: 4 waves, 17 terms, 59 reasons.
    const readFrom = `Read ${terms.length} terms in ${waves.size} waves from ${BANNED_TERMS_PATH}.`;
    expect(waves.size, readFrom).toBeGreaterThanOrEqual(4);
    expect(terms.length, readFrom).toBeGreaterThanOrEqual(17);
    expect(
      reasons.length,
      'The fixture built a plan with almost nothing to say.'
    ).toBeGreaterThanOrEqual(59);
  });

  it('VC-02: the fixture reaches every family of sentence the ENGINE writes', () => {
    // A count alone can be met by one family repeated. Six families, and each
    // is a different producer with a different failure mode: the note on an
    // action, the reason on a drop, a warning, what is in the way of a write,
    // what a sweep removes, and what is wrong with the manifest itself.
    const families = new Set(reasons.map((reason) => reason.family));
    expect([...families].sort()).toEqual([
      'action',
      'blocked',
      'drop',
      'manifest-notice',
      'sweep',
      'warning',
    ]);

    // Two of the six tables are enumerated as well as produced, so a table that
    // grew is checked even when this tree does not trip the new entry. The
    // blocked one is also genuinely PRODUCED here, which is what says the
    // enumeration is describing something real.
    expect(reasons.filter((reason) => reason.family === 'blocked').length).toBeGreaterThan(
      BLOCKED_REASONS.length
    );

    // And the three producers a family name does not distinguish, each named by
    // a phrase only it writes.
    const all = reasons.map((reason) => reason.text);
    expect(all.some((text) => text.startsWith('plugin layer "adapters"'))).toBe(true);
    expect(all.some((text) => text.includes('installed for all your projects'))).toBe(true);
    expect(all.some((text) => text.includes('is installed twice'))).toBe(true);
  });

  it('VC-02: uses no retired user-facing word outside a quoted package-layer name', () => {
    const offenders = reasons
      .flatMap((reason) =>
        retiredTermsIn(reason.text, terms).map(
          (term) =>
            `${reason.family}: "${term.term}" (${term.wave}, ${term.issue}) — ${reason.text}`
        )
      )
      .sort();

    expect(
      offenders,
      'A reason the app draws verbatim uses a word this product retired. Rewrite the sentence in ' +
        'packages/harness — the CLI prints the same string, so the fix reaches both surfaces at once. ' +
        'The one legitimate use is a marketplace layer NAME in quotes (ADR 260804-021140).'
    ).toEqual([]);
  });
});
