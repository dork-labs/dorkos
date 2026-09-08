import { describe, it, expect } from 'vitest';
import { HARNESS_IDS, type HarnessId } from '../../manifest/schema.js';
import {
  HARNESS_VENDOR_FACTS,
  VENDOR_FACTS_FETCHED_AT,
  hooksFactsFor,
  skillsFactsFor,
} from '../index.js';

/** The canonical directory the whole skills half of the engine is organised around. */
const CANONICAL_SKILLS_DIR = '.agents/skills';

describe('vendor-facts table', () => {
  it('has a skills row for every harness the engine targets, and no row for anything else', () => {
    // The table is the oracle for `HARNESS_IDS`; a harness added to the engine
    // without a row here would be measured against nothing, and a row left
    // behind after a harness is dropped is stale data nobody reads.
    expect(Object.keys(HARNESS_VENDOR_FACTS).sort()).toEqual([...HARNESS_IDS].sort());
    for (const harness of HARNESS_IDS) {
      expect(HARNESS_VENDOR_FACTS[harness].skills).toBeDefined();
    }
    expect(HARNESS_IDS).toHaveLength(6);
  });

  it.each(HARNESS_IDS)('%s: cites where its claims came from and when', (harness: HarnessId) => {
    const facts = skillsFactsFor(harness);

    expect(facts.readPaths.project.length).toBeGreaterThan(0);
    for (const path of facts.readPaths.project) {
      expect(path).not.toBe('');
      // Project read paths are repo-relative, never absolute and never `~`:
      // `harnessCoverage()` joins them onto a tree root.
      expect(path.startsWith('/')).toBe(false);
      expect(path.startsWith('~')).toBe(false);
    }
    expect(facts.readPaths.user.length).toBeGreaterThan(0);

    expect(facts.source.url).toMatch(/^https:\/\//);
    // A real ISO date, not "whatever the shared constant happens to be": a row
    // re-fetched on its own carries its own literal date, and that is the
    // signal the next reader wants. Asserting equality with the constant would
    // be `x === x` and would also forbid the per-row bump.
    expect(facts.source.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(facts.source.fetchedAt))).toBe(false);
    expect(facts.source.quote?.length ?? 0).toBeGreaterThan(0);
    expect(facts.liveReload).not.toBe('');
  });

  it('records the Codex hook trust gate the CLI quotes back, and records it for Codex alone', () => {
    // `dorkos harness sync --fix` tells a person that a regenerated
    // `.codex/hooks.json` is held for review until they trust it again
    // (contract HK-10). That is a claim about somebody else's software printed
    // in somebody's terminal, so it has to be traceable — and it must not
    // silently become a claim about a harness nobody read the page for.
    const codex = hooksFactsFor('codex');
    expect(codex).toBeDefined();
    expect(codex!.trust).toBe('per-hook-hash');
    expect(codex!.source.url).toMatch(/^https:\/\//);
    expect(codex!.source.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(codex!.source.quote).toContain("records trust against the hook's current hash");
    expect(codex!.readPaths.project).toContain('.codex/hooks.json');

    const withHooks = HARNESS_IDS.filter((h) => hooksFactsFor(h) !== undefined);
    expect(withHooks).toEqual(['codex']);
  });

  it('was compiled in one pass — at least one row still carries the table-wide fetch date', () => {
    // If every row has drifted to its own date, the shared constant has stopped
    // meaning anything and should be retired rather than left as decoration.
    expect(VENDOR_FACTS_FETCHED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const onTheSharedDate = HARNESS_IDS.filter(
      (h) => skillsFactsFor(h).source.fetchedAt === VENDOR_FACTS_FETCHED_AT
    );
    expect(onTheSharedDate.length).toBeGreaterThan(0);
  });

  it('is documentation-derived from end to end today — the first H-tier run against a real binary has to change this assertion', () => {
    // `verified: 'binary'` is a claim no cell can make yet: nothing in this repo
    // has ever started a `claude`, `codex`, `opencode`, `cursor-agent`, `gemini`
    // or `copilot` process and watched what it loaded. When the H tier lands,
    // the row it verifies flips to 'binary' and this assertion narrows to the
    // rows that are still on paper. Loosening it without a binary run is the
    // failure mode it exists to catch.
    const verified = HARNESS_IDS.map((h) => skillsFactsFor(h).verified);
    expect(verified).toEqual(HARNESS_IDS.map(() => 'docs'));
  });

  it('records that Claude Code is the only harness that does not read .agents/skills — the one fact the whole engine is built on', () => {
    // Every other harness reads the canonical directory natively, so the symlink
    // into `.claude/skills/` is the entire reason the skills half of the engine
    // exists. If this ever flips, the engine's central premise is gone, and this
    // test is where that has to be noticed.
    expect(skillsFactsFor('claude-code').readPaths.project).not.toContain(CANONICAL_SKILLS_DIR);

    const others = HARNESS_IDS.filter((h) => h !== 'claude-code');
    expect(others).toHaveLength(5);
    for (const harness of others) {
      expect(skillsFactsFor(harness).readPaths.project).toContain(CANONICAL_SKILLS_DIR);
    }
  });

  it('keeps every undocumented cell undocumented — filling one in is a deliberate edit with a citation, never a default', () => {
    // These are the cells the vendor pages did not answer. `harnessCoverage()`
    // turns each into a loud `uncertain` finding, which is the only thing
    // stopping the table from becoming a confident wrong guard. Changing a row
    // here means fetching the page (or running the binary) and bumping its
    // `fetchedAt`.
    const unknowns: ReadonlyArray<[HarnessId, string, unknown]> = [
      ['opencode', 'symlinks', skillsFactsFor('opencode').symlinks],
      ['cursor', 'symlinks', skillsFactsFor('cursor').symlinks],
      ['gemini', 'symlinks', skillsFactsFor('gemini').symlinks],
      ['copilot', 'symlinks', skillsFactsFor('copilot').symlinks],
      ['gemini', 'identity', skillsFactsFor('gemini').identity],
      ['copilot', 'identity', skillsFactsFor('copilot').identity],
      ['gemini', 'nameMustMatchDir', skillsFactsFor('gemini').nameMustMatchDir],
      ['copilot', 'nameMustMatchDir', skillsFactsFor('copilot').nameMustMatchDir],
      // SK-12 leaves "is one skill reachable twice loaded once or twice?" open
      // for all three harnesses that read both `.claude/skills` and
      // `.agents/skills`. OpenCode is not the exception: the 2026-07 source
      // check is a hypothesis in its notes, not a documented outcome.
      ['opencode', 'dedupe', skillsFactsFor('opencode').dedupe],
      ['cursor', 'dedupe', skillsFactsFor('cursor').dedupe],
      ['gemini', 'dedupe', skillsFactsFor('gemini').dedupe],
      ['copilot', 'dedupe', skillsFactsFor('copilot').dedupe],
    ];
    expect(unknowns.map(([harness, cell, value]) => `${harness}.${cell}=${String(value)}`)).toEqual(
      unknowns.map(([harness, cell]) => `${harness}.${cell}=unknown`)
    );

    // Live reload is prose, so it is pinned by prefix rather than by value.
    for (const harness of ['opencode', 'cursor', 'copilot'] as const) {
      expect(skillsFactsFor(harness).liveReload.startsWith('unknown')).toBe(true);
    }

    // Not one of the six documents what it does with a skill whose name breaks
    // its own rule, which is why `onInvalidName` has no 'skip' or 'warn-and-load'
    // row yet. Both values exist for the day a vendor states one.
    expect(HARNESS_IDS.map((h) => skillsFactsFor(h).onInvalidName)).toEqual(
      HARNESS_IDS.map(() => 'unknown')
    );
  });

  it('censuses every behaviour cell, so a value the coverage walk has no fixture for cannot appear unnoticed', () => {
    // The rule ladder and the walk branch on eight cells. Seven of them are
    // enumerable and are censused here; the eighth, `nameRegex`, is a pattern
    // rather than a value and is pinned by the name-rule test at the bottom
    // (which harnesses state one, and that each stated one rejects `pkg__name`).
    // This census is the contract between the table and the walk's fixtures:
    // change a cell and this reds, which is the prompt to bring a fixture with
    // the change. Three values in the vocabulary have no row today —
    // `dedupe: 'by-name'` (the OpenCode hypothesis, unconfirmed),
    // `onInvalidName: 'skip'` and `'warn-and-load'` — and the assertions below
    // are what keep that true.
    const census = HARNESS_IDS.map((harness) => {
      const f = skillsFactsFor(harness);
      return [
        harness,
        f.walk,
        f.identity,
        String(f.nameMustMatchDir),
        String(f.nameRequired),
        f.onInvalidName,
        f.dedupe,
        f.symlinks,
      ].join(' ');
    });

    expect(census).toEqual([
      'claude-code ascend-to-repo-root dir false false unknown by-realpath followed',
      'codex ascend-to-repo-root frontmatter false unknown unknown none followed',
      'cursor descend-recursive dir true unknown unknown unknown unknown',
      'gemini fixed unknown unknown unknown unknown unknown unknown',
      'copilot fixed unknown unknown true unknown unknown unknown',
      'opencode ascend-to-worktree frontmatter true unknown unknown unknown unknown',
    ]);

    // Copilot is the only harness whose page states the key is required, and it
    // is the reason the cell exists: a `SKILL.md` with no name was "loads" there,
    // for both the plan and the walk, until the ladder learned to ask.
    expect(HARNESS_IDS.filter((h) => skillsFactsFor(h).nameRequired === true)).toEqual(['copilot']);
    expect(HARNESS_IDS.map((h) => skillsFactsFor(h).dedupe)).not.toContain('by-name');
    expect(HARNESS_IDS.map((h) => skillsFactsFor(h).onInvalidName)).not.toContain('skip');
    expect(HARNESS_IDS.map((h) => skillsFactsFor(h).onInvalidName)).not.toContain('warn-and-load');
  });

  it('states a name rule only where a vendor states one, and each stated rule rejects the engine <pkg>__<name> shape', () => {
    // SK-09: `pkg__name` violates OpenCode's and Cursor's stated rules twice
    // over (charset and directory match) and Copilot's charset rule; Codex and
    // Claude Code state no charset rule at all, which is why the projection is
    // only confidently loadable there.
    const withRule = HARNESS_IDS.filter((h) => skillsFactsFor(h).nameRegex !== undefined);
    expect(withRule.sort()).toEqual(['copilot', 'cursor', 'opencode']);

    for (const harness of withRule) {
      const regex = skillsFactsFor(harness).nameRegex;
      expect(regex?.test('flow__capture')).toBe(false);
      expect(regex?.test('writing-for-humans')).toBe(true);
    }

    expect(skillsFactsFor('claude-code').nameRegex).toBeUndefined();
    expect(skillsFactsFor('codex').nameRegex).toBeUndefined();
  });
});
