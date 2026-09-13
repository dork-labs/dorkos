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
   * By the sentence people actually write: `turn on **Some Title** in Settings
   * under Experiments`. A bold only counts when it is the THING BEING SWITCHED —
   * the object of a switch-on instruction (`turn on **X**`, `enable **X**`,
   * `switch **X** on`) or the subject of a switch noun (`the **X** switch`) — and
   * when it sits in the same sentence as the instruction.
   *
   * Nearness alone was the first rule and it was wrong (DOR-2017). `Agent
   * messaging is **off by default**, and you can switch it on in Settings under
   * Experiments.` is a correct sentence with a correct bold, and the old rule
   * read `off by default` as a label the registry had to carry. A state, a
   * warning and a product name can all sit within a few words of the instruction
   * without anybody claiming they are the name on a switch. Asking what the bold
   * IS, rather than how close it sits, tells those apart.
   *
   * The cost of the tighter rule is a page that names the label without ever
   * saying turn it on — `**X** — you will find it in Settings under Experiments`
   * goes unchecked. That is the right way to be wrong: this guard exists to stop
   * a page inventing a spelling in the sentence that tells somebody to flip the
   * switch, and every such sentence in this corpus names the verb.
   *
   * Prose that names the tab without bolding anything is not a claim about a
   * label and is left alone; a bolded phrase anywhere else (a button, a heading)
   * is not matched at all, which is why the rule names the Experiments tab rather
   * than Settings in general.
   */
  describe('every page that names an experiment switch uses the title on the switch', () => {
    /** The repo root, from this file. */
    const REPO_ROOT = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../../../..'
    );

    /**
     * Where a person reads about an experiment. The COMPILED changelog is
     * excluded on purpose: it is history, and an experiment renamed later must
     * not make a shipped release note false retroactively (`changelog/README.md`).
     */
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

    /**
     * A switch-on verb ending right where the bold begins: `turn on **X**`.
     *
     * The pronoun hop covers `turn it on **X**`, which reads oddly but appears.
     */
    const VERB_BEFORE =
      /(?:turn|switch|flip|toggle)(?:s|ed|ing)?\s+(?:it|this|them)?\s*on\s+$|(?:enable|enables|enabling)\s+$/i;

    /** The split form, `turn **X** on`: the verb before, the particle after. */
    const SPLIT_VERB_BEFORE = /(?:turn|switch|flip|toggle)(?:s|ed|ing)?\s+$/i;
    /** The particle that closes a split verb, or the noun in `the **X** switch`. */
    const SWITCH_AFTER = /^\s*(?:on\b|switch\b|toggle\b)/i;

    /**
     * Whether this bold is the thing being switched, rather than something else
     * the sentence happens to emphasise.
     *
     * Three shapes, all of them an author naming the control: the object of a
     * switch-on verb, that verb split around the label, and the label used as the
     * subject of the word "switch". Anything else — a state, a warning, a product
     * name — is emphasis, and emphasis is not a claim about a label.
     */
    function namesTheSwitch(text: string, bold: { startsAt: number; endsAt: number }): boolean {
      const before = text.slice(Math.max(0, bold.startsAt - 40), bold.startsAt);
      const after = text.slice(bold.endsAt, bold.endsAt + 20);
      if (VERB_BEFORE.test(before)) return true;
      if (SPLIT_VERB_BEFORE.test(before) && /^\s*on\b/i.test(after)) return true;
      return SWITCH_AFTER.test(after) && /\bthe\s+$/i.test(before);
    }

    /**
     * The sentence containing `at`, as offsets into `text`.
     *
     * A sentence ends at terminal punctuation FOLLOWED BY whitespace, or at a
     * newline. The whitespace matters: `experiment.** A Claude Code session` would
     * otherwise break inside the bold that ends the previous heading, and the
     * sentence boundary is what keeps a bold in one sentence from being read as
     * the label of an instruction in the next.
     */
    function sentenceAround(text: string, at: number): { start: number; end: number } {
      const boundaries = [...text.slice(0, at).matchAll(/[.!?]\s|\n/g)];
      const last = boundaries.at(-1);
      const start = last === undefined ? 0 : last.index + last[0].length;
      const closes = /[.!?](?:\s|$)|\n/.exec(text.slice(at));
      const end = closes === null ? text.length : at + closes.index + 1;
      return { start, end };
    }

    /**
     * Whether a bolded phrase is shaped like a switch label rather than like
     * emphasis inside a sentence.
     *
     * Three cheap rules, each for a real shape in this corpus: a label is short,
     * it is not a sentence, and it has no stray edge whitespace — which is what a
     * span mis-paired across two adjacent bolds always has.
     */
    function looksLikeALabel(named: string): boolean {
      return (
        named.trim() === named && named.length > 0 && named.length <= 60 && !named.includes('. ')
      );
    }

    /**
     * Every `turn on **Title** … in Settings under Experiments` in one document.
     *
     * Bolds are paired over the WHOLE text and then filtered by position, never
     * by slicing a window and re-scanning it: a slice that starts inside a bold
     * pairs that bold's closing `**` with the NEXT bold's opening one, and the
     * real label two words later is never seen. That mis-pairing hid the very
     * page this guard was written for.
     *
     * Of what is left, a bold counts only if {@link namesTheSwitch} says it is
     * the control being named AND it sits in the same sentence as the
     * instruction, before it and within {@link LABEL_WINDOW_CHARS}. The last such
     * bold is the name a reader is being handed. Prose that merely mentions the
     * tab — a note that a switch USED to live there, say — names no switch and is
     * not a claim about one.
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
              namesTheSwitch(text, bold)
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

    /** Every mention in one file of the live corpus. */
    function mentionsIn(file: string): Mention[] {
      return mentionsInText(readFileSync(path.join(REPO_ROOT, file), 'utf-8'), file);
    }

    const MENTIONS = FILES.flatMap(mentionsIn);

    it('found the pages that say it, so the check below is about something', () => {
      // Vacuously green against an empty corpus, which is the one way this could
      // stop working without saying so.
      expect(FILES.length).toBeGreaterThan(50);
      expect(MENTIONS.length).toBeGreaterThan(0);
    });

    /**
     * One line per wrong label: the file, the name it handed the reader, and the
     * sentence it was read out of.
     *
     * The sentence is the part that took a reviewer a debugging session to
     * recover the first time this fired on prose that was fine (DOR-2017). With
     * it in the message, "the scanner misread this" and "the page is wrong" are
     * one read apart.
     */
    function report(mention: Mention): string {
      const sentence =
        mention.sentence.length > 240 ? `${mention.sentence.slice(0, 240)}…` : mention.sentence;
      return `${mention.file}: "${mention.named}" — read from: ${sentence}`;
    }

    it('names only titles the registry really carries', () => {
      const titles = new Set(EXPERIMENTS.map((entry) => entry.title));
      const wrong = MENTIONS.filter((mention) => !titles.has(mention.named));
      expect(
        wrong.map(report),
        'these send a reader to Settings to look for a switch with that label. ' +
          `The labels that exist are: ${[...titles].map((title) => `"${title}"`).join(', ')}.`
      ).toEqual([]);
    });

    /**
     * What the scanner counts, held against strings rather than the live corpus.
     *
     * The corpus moves — a page is rewritten, a fragment is released — so the
     * shapes this is supposed to catch and the shapes it is supposed to leave
     * alone are pinned here as literals. The four wrong strings are the ones
     * DOR-2009's review actually found, re-seeded one at a time; the green ones
     * are the reviewer's false positive and two more shapes it stands for.
     */
    describe('what counts as naming a switch', () => {
      /** The name on the switch today, and the spelling DOR-2009 invented. */
      const WRONG = 'DorkOS tools for Codex and OpenCode';

      /** Just the names, for a terse assertion. */
      function namesIn(text: string): string[] {
        return mentionsInText(text, 'fixture.md').map((mention) => mention.named);
      }

      describe('reds on each string DOR-2009 shipped', () => {
        const seeds: Record<string, string> = {
          'the release note': `Turn on **${WRONG}** in Settings under Experiments, and their next turn has all of it.`,
          'the generative UI guide': `Putting one on the canvas is the same set of tools on all three, too — Claude Code always, Codex and OpenCode once you turn on **${WRONG}** in Settings under Experiments.`,
          'the runtimes guide': `For the other two, turn on **${WRONG}** in Settings under Experiments, and their next turn gets the same set.`,
          'the workbench guide': `Codex and OpenCode agents can too, once you turn on **${WRONG}** in Settings under Experiments — with one difference.`,
        };

        for (const [where, text] of Object.entries(seeds)) {
          it(where, () => {
            expect(namesIn(text)).toEqual([WRONG]);
            expect(EXPERIMENTS.map((entry) => entry.title)).not.toContain(WRONG);
          });
        }
      });

      it('reds on a wrong label seeded into any page that really names one', () => {
        // The same re-seed against the live corpus, so the guard is proven on the
        // files it actually reads and not only on fixtures.
        expect(MENTIONS.length).toBeGreaterThan(0);
        for (const mention of MENTIONS) {
          const text = readFileSync(path.join(REPO_ROOT, mention.file), 'utf-8').replaceAll(
            `**${mention.named}**`,
            `**${WRONG}**`
          );
          expect(
            mentionsInText(text, mention.file).map((found) => found.named),
            mention.file
          ).toContain(WRONG);
        }
      });

      describe('stays quiet on a bold that is not the switch', () => {
        it('a state the feature is in (the false positive that started this)', () => {
          expect(
            namesIn(
              'Agent messaging is **off by default**, and you can switch it on in Settings under Experiments.'
            )
          ).toEqual([]);
        });

        it('a warning bolded beside the instruction', () => {
          expect(
            namesIn(
              '**This one opens a door on your machine.** You will find it in Settings under Experiments.'
            )
          ).toEqual([]);
        });

        it('a product name that is not a switch', () => {
          expect(
            namesIn(
              'The **Browser tab** is where your agent works, and you can switch it on in Settings under Experiments.'
            )
          ).toEqual([]);
        });
      });

      describe('reads the other ways an author names the switch', () => {
        it('enable **X**', () => {
          expect(
            namesIn('Enable **Agents decide when to speak** in Settings under Experiments.')
          ).toEqual(['Agents decide when to speak']);
        });

        it('the **X** switch', () => {
          expect(
            namesIn(
              'Flip the **Agents decide when to speak** switch in Settings under Experiments.'
            )
          ).toEqual(['Agents decide when to speak']);
        });

        it('turn **X** on', () => {
          expect(
            namesIn('Turn **Agents decide when to speak** on in Settings under Experiments.')
          ).toEqual(['Agents decide when to speak']);
        });
      });

      it('names the sentence it read the label out of', () => {
        const [mention] = mentionsInText(
          `Turn on **${WRONG}** in Settings under Experiments, and you are done.`,
          'fixture.md'
        );
        expect(mention).toBeDefined();
        expect(report(mention!)).toContain('read from: Turn on');
        expect(report(mention!)).toContain('and you are done.');
      });
    });
  });
});
