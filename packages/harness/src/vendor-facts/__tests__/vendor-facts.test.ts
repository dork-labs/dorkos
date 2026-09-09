import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HARNESS_IDS, type HarnessId } from '../../manifest/schema.js';
import {
  HARNESS_VENDOR_FACTS,
  PROJECT_SKILL_ROOT_READERS,
  VENDOR_FACTS_FETCHED_AT,
  harnessesReadingProjectSkillRoot,
  hooksFactsFor,
  skillsFactsFor,
} from '../index.js';
import { HARNESS_NATIVE_SKILL_ROOTS } from '../../inventory/types.js';
import { CLAUDE_SKILLS_DIR } from '../../plan/installed-projector.js';

/** The canonical directory the whole skills half of the engine is organised around. */
const CANONICAL_SKILLS_DIR = '.agents/skills';

/** The repository root, five levels above this file. */
const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

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

  it('is documentation-derived on every row the H tier has not run against', () => {
    // This assertion has now narrowed exactly as its previous version said it
    // would: `codex.skills` was observed against a real `codex-cli 0.145.0` on
    // 2026-09-09 (DOR-1856, the free listing probe). Every other row is still on
    // paper, and loosening this without a binary run is the failure mode it
    // exists to catch.
    const onPaper = HARNESS_IDS.filter((h) => h !== 'codex');
    expect(onPaper.map((h) => skillsFactsFor(h).verified)).toEqual(onPaper.map(() => 'docs'));
    expect(skillsFactsFor('codex').verified).toBe('binary');
  });

  it('makes a `binary` row say WHICH cells were observed, and against what', () => {
    // The dangerous shape this closes: `verified` is row-level and an H-tier run
    // answers CELLS. Flipping a row on evidence about six of its ten fields
    // would silently promote the four nobody looked at — and a reader has no way
    // to tell which is which from `verified` alone.
    for (const harness of HARNESS_IDS) {
      const facts = skillsFactsFor(harness);
      if (facts.verified === 'docs') {
        expect(
          facts.observed,
          `${harness} is on paper and must claim no observation`
        ).toBeUndefined();
        continue;
      }
      const observed = facts.observed;
      expect(observed, `${harness} claims 'binary' and must say what was watched`).toBeDefined();
      if (!observed) continue;
      expect(observed.binary).toMatch(/\d/);
      expect(observed.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(observed.report).toMatch(/^meta\/harness-smoke\/.+\.md$/);
      // The citation has to point at a file that is still there. A report is
      // regenerated under a new timestamped name every time it is re-run, so a
      // stale path here is the ordinary outcome of doing the right thing, and
      // a `verified: 'binary'` row whose evidence has been deleted is worse
      // than one that never claimed it.
      expect(
        existsSync(resolve(REPO_ROOT, observed.report)),
        `${harness}'s observed.report points at a file that does not exist: ${observed.report}`
      ).toBe(true);
      expect(observed.cells.length).toBeGreaterThan(0);
      // Every named cell has to BE a cell, or the claim points at nothing.
      for (const cell of observed.cells) expect(facts).toHaveProperty(cell);
      // …and the row must not claim every cell was measured when it was not.
      const behaviourCells = Object.keys(facts).filter(
        (key) => !['source', 'verified', 'observed', 'notes'].includes(key)
      );
      expect(observed.cells.length).toBeLessThanOrEqual(behaviourCells.length);
    }
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

  it('XA-06: the harness-native skill roots are exactly the project read paths the table documents', () => {
    // Both directions, because both are ways to be wrong. A root invented in
    // `inventory/types.ts` without a cell here would be a directory DorkOS walks
    // and no vendor page documents — a claim about somebody else's software with
    // nothing behind it. A cell added here without a root there would be a folder
    // an agent tool reads that the inventory is silent about, which is DOR-1902's
    // whole subject.
    const documented = [...PROJECT_SKILL_ROOT_READERS.keys()]
      .filter((root) => root !== CANONICAL_SKILLS_DIR && root !== CLAUDE_SKILLS_DIR)
      .sort();

    expect(documented).toEqual([...HARNESS_NATIVE_SKILL_ROOTS].sort());
    // Counted, so a table that stopped producing roots would not pass this on an
    // empty pair of lists.
    expect(documented.length).toBeGreaterThanOrEqual(5);
  });

  it('XA-06: names the harnesses that read each root, and answers nothing for a root nobody documents', () => {
    // The sentence a person reads about `.codex/skills` says CURSOR looks there,
    // which is surprising and correct: Cursor lists it as a compatibility path
    // and Codex's own row does not list it at all.
    expect(harnessesReadingProjectSkillRoot('.codex/skills')).toEqual(['cursor']);
    expect(harnessesReadingProjectSkillRoot('.opencode/skills')).toEqual(['opencode']);
    // In `HARNESS_IDS` order, not the table's declaration order, so two readers
    // of one root are always listed the same way round.
    expect(harnessesReadingProjectSkillRoot(CANONICAL_SKILLS_DIR)).toEqual([
      'codex',
      'cursor',
      'gemini',
      'copilot',
      'opencode',
    ]);
    // Not a guess and not a throw: a root no page names has no readers, which is
    // what makes "we scan no folder a vendor does not document" checkable.
    expect(harnessesReadingProjectSkillRoot('.zed/skills')).toEqual([]);
  });
});
