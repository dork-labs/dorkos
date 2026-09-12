/**
 * The drift guard for `experiments-registry.ts`.
 *
 * An experiment is only an experiment while four things hold: the path it writes
 * exists, it is a boolean, it ships OFF, and something is tracking whether it
 * graduates. Each one has failed somewhere in this repo's history — a leaf
 * renamed out from under a table, a default flipped without its consumers moving,
 * a flag with nobody's name on it — so each is asserted here rather than trusted.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserConfigSchema, USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { EXPERIMENTS, type ExperimentEntry } from '../experiments-registry.js';
import { configSchemaLeaves } from '../../operator/config-disclosure.js';

/** Read a dot-path out of an object, or `undefined` if any hop is missing. */
function readAt(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/**
 * The default a leaf gets when its section is PRESENT but the leaf is absent.
 *
 * The section-level `.default(() => ({...}))` literal and the per-field
 * `.default(...)` are two live sources that can disagree, and it is the per-field
 * one every existing install observes on read (conf's Ajv fills it in). Both are
 * checked, for the reason `safe-defaults/__tests__/default-verdicts.test.ts`
 * spells out at length.
 */
function fieldLevelDefault(path: string): unknown {
  const [section, ...rest] = path.split('.');
  if (section === undefined || rest.length === 0) return readAt(USER_CONFIG_DEFAULTS, path);
  const parsed = UserConfigSchema.safeParse({ version: 1, [section]: {} });
  if (!parsed.success) return readAt(USER_CONFIG_DEFAULTS, path);
  return readAt(parsed.data, path);
}

/**
 * The assertions, factored out so the negative cases below can run them against a
 * fabricated registry and prove the guard actually discriminates.
 */
function auditEntry(entry: ExperimentEntry, leaves: Map<string, string>): string[] {
  const problems: string[] = [];
  const shape = leaves.get(entry.path);

  if (shape === undefined) {
    problems.push(`${entry.path}: not a leaf of UserConfigSchema`);
  } else if (shape !== 'scalar') {
    problems.push(`${entry.path}: resolves to ${shape}, not a scalar`);
  }

  if (shape !== undefined) {
    const objectLevel = readAt(USER_CONFIG_DEFAULTS, entry.path);
    const fieldLevel = fieldLevelDefault(entry.path);
    if (typeof objectLevel !== 'boolean') {
      problems.push(`${entry.path}: default is ${typeof objectLevel}, not a boolean`);
    }
    if (objectLevel !== false || fieldLevel !== false) {
      problems.push(
        `${entry.path}: ships ON (section default ${String(objectLevel)}, field default ${String(fieldLevel)}) — graduate it and delete the entry instead of offering a switch to turn it off`
      );
    }
  }

  if (entry.graduationIssue.trim() === '') {
    problems.push(`${entry.path}: no graduationIssue`);
  }

  return problems;
}

/** Leaf path -> shape, from the schema itself. */
function schemaLeaves(): Map<string, string> {
  return new Map(configSchemaLeaves().map((leaf) => [leaf.path, leaf.shape]));
}

describe('EXPERIMENTS', () => {
  const leaves = schemaLeaves();

  it('is a registry every entry of which is expected to be deleted, so empty is legal', () => {
    // Not a vacuous assertion: it pins the fact that this guard must keep passing
    // once the last experiment graduates. A guard that required at least one
    // entry would make the success state red.
    expect(Array.isArray(EXPERIMENTS)).toBe(true);
  });

  it('lists no path twice', () => {
    const paths = EXPERIMENTS.map((e) => e.path);
    expect(paths).toEqual([...new Set(paths)]);
  });

  it('every entry writes a real boolean leaf that ships OFF and names a graduation issue', () => {
    const problems = EXPERIMENTS.flatMap((entry) => auditEntry(entry, leaves));
    expect(problems).toEqual([]);
  });

  it('every entry carries prose a person can read', () => {
    for (const entry of EXPERIMENTS) {
      expect(entry.title.trim(), entry.path).not.toBe('');
      expect(entry.description.trim(), entry.path).not.toBe('');
      if (entry.costNote !== undefined) {
        expect(entry.costNote.trim(), entry.path).not.toBe('');
      }
    }
  });

  // ## The guard discriminates
  //
  // Three fabricated entries, one per failure the real registry could drift into.
  // Without these the assertions above would pass just as happily against a table
  // that had rotted, and a check that cannot fail is worse than no check.
  describe('rejects an entry that has drifted', () => {
    const base = { title: 't', description: 'd', graduationIssue: 'DOR-1' } as const;

    it('a path that is not in the schema at all', () => {
      const problems = auditEntry({ ...base, path: 'runtimes.claudeCode.notAThing' }, leaves);
      expect(problems).toEqual(['runtimes.claudeCode.notAThing: not a leaf of UserConfigSchema']);
    });

    it('a leaf that ships ON', () => {
      // `relay.enabled` really does default true (ADR-0171 graduated it), which
      // makes it the honest stand-in for an experiment whose default has flipped.
      const problems = auditEntry({ ...base, path: 'relay.enabled' }, leaves);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('ships ON');
    });

    it('a leaf that is not a boolean', () => {
      const problems = auditEntry({ ...base, path: 'server.port' }, leaves);
      expect(problems).toContain('server.port: default is number, not a boolean');
    });

    it('an entry with no graduation issue', () => {
      const problems = auditEntry({ ...base, path: 'a2a.enabled', graduationIssue: '  ' }, leaves);
      expect(problems).toEqual(['a2a.enabled: no graduationIssue']);
    });
  });

  /**
   * The name a page tells somebody to look for is the name on the switch.
   *
   * `ExperimentsTab.tsx` renders `entry.title` verbatim, so the title IS the
   * label. A page that invents its own spelling sends a reader to Settings to
   * hunt for a control that is not there — and the page they are reading is, by
   * construction, the one paragraph explaining how to turn the feature on.
   *
   * Caught nothing for a year and then caught four strings at once: DOR-2009's
   * docs and its release note all said "DorkOS tools for Codex and OpenCode"
   * while the switch said "DorkOS tools in every runtime", and four OTHER pages
   * in the same tree already used the real name. Nothing compared them.
   *
   * ## How a mention is recognised
   *
   * By the sentence people actually write: `**Some Title** … in Settings under
   * Experiments`. The bolded phrase NEAREST before that instruction is the name
   * being handed to the reader, so that is the string this compares. Prose that
   * names the tab without bolding anything is not a claim about a label and is
   * left alone; a bolded phrase anywhere else (a button, a heading) is not
   * matched at all, which is why the rule names the Experiments tab rather than
   * Settings in general.
   */
  describe('every page that names an experiment switch uses the title on the switch', () => {
    /** The repo root, from this file. */
    const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../../..');

    /**
     * Where a person reads about an experiment. The COMPILED changelog is
     * excluded on purpose: it is history, and an experiment renamed later must
     * not make a shipped release note false retroactively (`changelog/README.md`).
     */
    const PROSE_ROOTS = ['docs/guides', 'docs/concepts', 'docs/getting-started', 'docs/integrations', 'docs/marketplace', 'changelog/unreleased', 'contributing'];

    /** Every markdown file under one root, recursively. */
    function markdownUnder(root: string): string[] {
      const absolute = path.join(REPO_ROOT, root);
      let entries: string[];
      try {
        entries = readdirSync(absolute);
      } catch {
        return [];
      }
      return entries.flatMap((name) => {
        const full = path.join(absolute, name);
        if (statSync(full).isDirectory()) return markdownUnder(path.join(root, name));
        return name.endsWith('.md') || name.endsWith('.mdx') ? [path.join(root, name)] : [];
      });
    }

    const FILES = PROSE_ROOTS.flatMap(markdownUnder);

    /** The phrase a page hands a reader to look for, and where it said it. */
    interface Mention {
      file: string;
      named: string;
    }

    /** How close a bolded label has to sit to the instruction to BE the label. */
    const LABEL_WINDOW_CHARS = 120;

    /**
     * Whether a bolded phrase is shaped like a switch label rather than like
     * emphasis inside a sentence.
     *
     * Three cheap rules, each for a real shape in this corpus: a label is short,
     * it is not a sentence, and it has no stray edge whitespace — which is what a
     * span mis-paired across two adjacent bolds always has.
     */
    function looksLikeALabel(named: string): boolean {
      return named.trim() === named && named.length > 0 && named.length <= 60 && !named.includes('. ');
    }

    /**
     * Every `**Title** … in Settings under Experiments` in one file.
     *
     * Bolds are paired over the WHOLE file and then filtered by position, never
     * by slicing a window and re-scanning it: a slice that starts inside a bold
     * pairs that bold's closing `**` with the NEXT bold's opening one, and the
     * real label two words later is never seen. That mis-pairing hid the very
     * page this guard was written for.
     *
     * Of what is left, the last label-shaped bold within
     * {@link LABEL_WINDOW_CHARS} of the instruction is the name a reader is being
     * handed. Prose that merely mentions the tab — a note that a switch USED to
     * live there, say — has no label beside it and is not a claim about one.
     */
    function mentionsIn(file: string): Mention[] {
      const text = readFileSync(path.join(REPO_ROOT, file), 'utf-8');
      const bolds = [...text.matchAll(/\*\*([^*\n]+)\*\*/g)]
        .map((bold) => ({ named: bold[1], endsAt: bold.index + bold[0].length }))
        .filter((bold) => looksLikeALabel(bold.named));
      const found: Mention[] = [];
      for (const match of text.matchAll(/in Settings,? under Experiments/g)) {
        const last = bolds.filter(
          (bold) => bold.endsAt <= match.index && match.index - bold.endsAt <= LABEL_WINDOW_CHARS
        ).at(-1);
        if (last !== undefined) found.push({ file, named: last.named });
      }
      return found;
    }

    const MENTIONS = FILES.flatMap(mentionsIn);

    it('found the pages that say it, so the check below is about something', () => {
      // Vacuously green against an empty corpus, which is the one way this could
      // stop working without saying so.
      expect(FILES.length).toBeGreaterThan(50);
      expect(MENTIONS.length).toBeGreaterThan(0);
    });

    it('names only titles the registry really carries', () => {
      const titles = new Set(EXPERIMENTS.map((entry) => entry.title));
      const wrong = MENTIONS.filter((mention) => !titles.has(mention.named));
      expect(
        wrong.map((mention) => `${mention.file}: "${mention.named}"`),
        'these send a reader to Settings to look for a switch with that label. ' +
          `The labels that exist are: ${[...titles].map((title) => `"${title}"`).join(', ')}.`
      ).toEqual([]);
    });
  });
});
