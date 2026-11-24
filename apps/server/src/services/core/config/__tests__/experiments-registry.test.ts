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

  it('lists no path twice', () => {
    const paths = EXPERIMENTS.map((e) => e.path);
    expect(paths).toEqual([...new Set(paths)]);
  });

  it('every entry writes a real boolean leaf that ships OFF and names a graduation issue', () => {
    const problems = EXPERIMENTS.flatMap((entry) => auditEntry(entry, leaves));
    expect(problems).toEqual([]);
  });

  // The guard discriminates: a check that cannot fail is worse than no check.
  describe('rejects an entry that has drifted', () => {
    const base = { title: 't', description: 'd', graduationIssue: 'DOR-1' } as const;

    it('a path that is not in the schema at all', () => {
      const problems = auditEntry({ ...base, path: 'runtimes.claudeCode.notAThing' }, leaves);
      expect(problems).toEqual(['runtimes.claudeCode.notAThing: not a leaf of UserConfigSchema']);
    });

    it('a leaf that ships ON', () => {
      // `relay.enabled` really does default true (ADR-0171 graduated it).
      const problems = auditEntry({ ...base, path: 'relay.enabled' }, leaves);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('ships ON');
    });
  });

  /**
   * The name a page tells somebody to look for is the name on the switch.
   *
   * `ExperimentsTab.tsx` renders `entry.title` verbatim, so the title IS the
   * label. DOR-2009's docs said "DorkOS tools for Codex and OpenCode" while the
   * switch said "DorkOS tools in every runtime". A bold counts only when it is the
   * thing being switched (`turn on **X**`, `enable **X**`, `the **X** switch`,
   * `- **X**: turn it on`) in the same sentence as `in Settings under
   * Experiments`; nearness alone misread `**off by default**` (DOR-2017).
   */
  describe('every page that names an experiment switch uses the title on the switch', () => {
    /** The repo root, from this file. */
    const REPO_ROOT = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../../../..'
    );

    /** Where a person reads about an experiment; the compiled changelog is history. */
    const PROSE_ROOTS = [
      'docs/guides',
      'docs/concepts',
      'docs/getting-started',
      'docs/integrations',
      'docs/marketplace',
      'changelog/unreleased',
      'contributing',
    ];

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
      /** The sentence the label was read out of, so a false positive reads in one go. */
      sentence: string;
    }

    /** How close a bolded label has to sit to the instruction to BE the label. */
    const LABEL_WINDOW_CHARS = 120;
    /** The instruction this whole guard hangs off. */
    const INSTRUCTION = /in Settings,? under Experiments/g;
    /** A switch-on verb ending right where the bold begins: `turn on **X**`. */
    const VERB_BEFORE =
      /(?:turn|switch|flip|toggle)(?:s|ed|ing)?\s+(?:it|this|them)?\s*on\s+$|(?:enable|enables|enabling)\s+$/i;
    /** The split form, `turn **X** on`: the verb before, the particle after. */
    const SPLIT_VERB_BEFORE = /(?:turn|switch|flip|toggle)(?:s|ed|ing)?\s+$/i;
    /** The noun in `the **X** switch`; never `on`, or `the **Browser tab** on the right` matched. */
    const SWITCH_NOUN_AFTER = /^\s*(?:switch|toggle)\b/i;
    /** The label-then-colon form: `- **X**: turn it on in Settings under Experiments.` */
    const COLON_AFTER = /^\s*[:—-]/;
    /** The switch-on phrase that follows the colon, its object already named. */
    const VERB_AFTER_COLON =
      /\b(?:turn|switch|flip|toggle)(?:s|ed|ing)?\s+(?:it|this|them)\s+on\b|\benabl(?:e|es|ing)\s+(?:it|this|them)\b/i;

    /** Whether this bold is the thing being switched, rather than emphasis. */
    function namesTheSwitch(
      text: string,
      bold: { startsAt: number; endsAt: number },
      instructionAt: number
    ): boolean {
      const before = text.slice(Math.max(0, bold.startsAt - 40), bold.startsAt);
      const after = text.slice(bold.endsAt, bold.endsAt + 20);
      if (VERB_BEFORE.test(before)) return true;
      if (SPLIT_VERB_BEFORE.test(before) && /^\s*on\b/i.test(after)) return true;
      if (SWITCH_NOUN_AFTER.test(after) && /\bthe\s+$/i.test(before)) return true;
      return (
        COLON_AFTER.test(after) && VERB_AFTER_COLON.test(text.slice(bold.endsAt, instructionAt))
      );
    }

    /**
     * Where one sentence ends: terminal punctuation, an optional closing `**`
     * (so a bold that closes a sentence closes it), then whitespace, or a newline.
     * The lookbehinds keep `e.g.` and friends from ending a sentence.
     */
    const SENTENCE_BREAK = /(?<!\be\.g)(?<!\bi\.e)(?<!\betc)(?<!\bvs)[.!?](?:\*\*)?\s|\n/;

    /** The sentence containing `at`, as offsets into `text`. */
    function sentenceAround(text: string, at: number): { start: number; end: number } {
      const backwards = new RegExp(SENTENCE_BREAK.source, 'g');
      const last = [...text.slice(0, at).matchAll(backwards)].at(-1);
      const start = last === undefined ? 0 : last.index + last[0].length;
      const closes = SENTENCE_BREAK.exec(text.slice(at));
      const end = closes === null ? text.length : at + closes.index + 1;
      return { start, end };
    }

    /** Whether a bolded phrase is shaped like a switch label (short, not a sentence, trimmed). */
    function looksLikeALabel(named: string): boolean {
      return (
        named.trim() === named && named.length > 0 && named.length <= 60 && !named.includes('. ')
      );
    }

    /**
     * Every `turn on **Title** … in Settings under Experiments` in one document.
     * Bolds are paired over the WHOLE text and then filtered by position: slicing
     * a window first mis-pairs a bold's closing `**` with the next one's opening.
     */
    function mentionsInText(text: string, file: string): Mention[] {
      const bolds = [...text.matchAll(/\*\*([^*\n]+)\*\*/g)]
        .map((bold) => ({
          named: bold[1],
          startsAt: bold.index,
          endsAt: bold.index + bold[0].length,
        }))
        .filter((bold) => looksLikeALabel(bold.named));
      const found: Mention[] = [];
      for (const match of text.matchAll(INSTRUCTION)) {
        const sentence = sentenceAround(text, match.index);
        const last = bolds
          .filter(
            (bold) =>
              bold.startsAt >= sentence.start &&
              bold.endsAt <= match.index &&
              match.index - bold.endsAt <= LABEL_WINDOW_CHARS &&
              namesTheSwitch(text, bold, match.index)
          )
          .at(-1);
        if (last !== undefined) {
          found.push({
            file,
            named: last.named,
            sentence: text.slice(sentence.start, sentence.end).replace(/\s+/g, ' ').trim(),
          });
        }
      }
      return found;
    }

    const MENTIONS = FILES.flatMap((file) =>
      mentionsInText(readFileSync(path.join(REPO_ROOT, file), 'utf-8'), file)
    );

    it('names only titles the registry really carries, over a real corpus', () => {
      // A scanner pointed at nothing is the one way this could stop working silently.
      expect(FILES.length).toBeGreaterThan(50);
      const titles = new Set(EXPERIMENTS.map((entry) => entry.title));
      const wrong = MENTIONS.filter((mention) => !titles.has(mention.named));
      expect(
        wrong.map((m) => `${m.file}: "${m.named}" — read from: ${m.sentence.slice(0, 240)}`),
        'these send a reader to Settings to look for a switch with that label. ' +
          `The labels that exist are: ${[...titles].map((title) => `"${title}"`).join(', ')}.`
      ).toEqual([]);
    });

    describe('what counts as naming a switch', () => {
      /** The spelling DOR-2009 invented. */
      const WRONG = 'DorkOS tools for Codex and OpenCode';

      /** Just the names, for a terse assertion. */
      function namesIn(text: string): string[] {
        return mentionsInText(text, 'fixture.md').map((mention) => mention.named);
      }

      it.each([
        `Turn on **${WRONG}** in Settings under Experiments, and their next turn has all of it.`,
        `Flip the **${WRONG}** switch in Settings under Experiments.`,
        `- **${WRONG}**: turn it on in Settings under Experiments.`,
        `Turn on **${WRONG}** (e.g. for Codex) in Settings under Experiments.`,
      ])('reds on a wrong label: %s', (text) => {
        expect(namesIn(text)).toEqual([WRONG]);
        expect(EXPERIMENTS.map((entry) => entry.title)).not.toContain(WRONG);
      });

      it.each([
        // DOR-2017: a state the feature is in.
        'Agent messaging is **off by default**, and you can switch it on in Settings under Experiments.',
        'Look at the **Browser tab** on the right, then switch it on in Settings under Experiments.',
        'You must first enable **Developer mode.** Agent messaging lives in Settings under Experiments.',
        `Turn on **${WRONG}** — ${'and the rest of this clause runs on for a good long while, '.repeat(3)}which is in Settings under Experiments.`,
      ])('stays quiet on a bold that is not the switch: %s', (text) => {
        expect(namesIn(text)).toEqual([]);
      });
    });
  });
});
