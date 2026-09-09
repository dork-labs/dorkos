/**
 * The user-tier ORACLE — what the runner concludes from what a binary printed.
 *
 * The other half of `harness-smoke-user-tier.test.ts`, which is the fixture and
 * the command line; this is `scripts/harness-smoke/user-tier.ts`. A design
 * decision is gated on these verdicts, so what every case below really defends
 * is that they cannot be trusted by accident:
 *
 * - an entry is attributed by PATH wherever a harness reports one, because none
 *   of the names anybody predicted turned out to be the name a binary printed;
 * - the duplicate question carries a control per ROUTE and refuses to answer
 *   without both, so "one entry" can never mean "one of the two routes was
 *   dead";
 * - a NOT-LISTED verdict is gated on the staged link being live, so an absence
 *   the fixture caused can never be read as an absence the vendor caused;
 * - a read-path verdict takes its expectation from the compiled vendor facts, so
 *   a binary that disagrees is reported as the disagreement it is.
 *
 * Nothing here reaches a model or sets a real key.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  SMOKE_HARNESSES,
  parseCodexPromptInput,
  type ListingObservation,
  type SmokeHarness,
} from '../harness-smoke/harnesses.js';
import { HARNESS_VENDOR_FACTS } from '../../packages/harness/dist/vendor-facts/index.js';
import { overallStatus, type ListingAbsence, type Verdict } from '../harness-smoke/oracles.js';
import {
  userTierLinkFault,
  userTierMatches,
  userTierVerdicts,
} from '../harness-smoke/user-tier.js';
import {
  stageSmokeFixture,
  userTierRoots,
  userTierSubjects,
  type UserTierSubject,
} from '../harness-smoke/fixture.js';
const CLAUDE = SMOKE_HARNESSES.claude;
const CODEX = SMOKE_HARNESSES.codex;
const OPENCODE = SMOKE_HARNESSES.opencode;
/** The three subjects the Claude round stages, against a fixed dork home. */
function claudeRoundSubjects(): UserTierSubject[] {
  return userTierSubjects('claude-user-root', '/home', userTierRoots('/sandbox'));
}

/** The one subject the shared-directory round stages. */
function agentsRoundSubject(): UserTierSubject {
  return userTierSubjects(
    'agents-user-root',
    '/home',
    userTierRoots('/sandbox')
  )[0] as UserTierSubject;
}

/** A name-only listing (Claude Code's shape) carrying exactly these entries. */
function namesOnly(...names: string[]): ListingObservation {
  return { skills: names, commands: names, skillPaths: [] };
}

/** The verdict with this id, or a failure that says which ids there were. */
function verdictFor(
  verdicts: readonly { id: string }[],
  id: string
): { id: string } & Record<string, unknown> {
  const found = verdicts.find((verdict) => verdict.id === id);
  if (!found) throw new Error(`no \`${id}\` verdict; got ${verdicts.map((v) => v.id).join(', ')}`);
  return found as { id: string } & Record<string, unknown>;
}

describe('attributing a listing entry to a user-tier subject', () => {
  it('matches by PATH where the harness reports one, whatever it called the entry', () => {
    // THE CASE THAT MADE THIS PATH-FIRST. codex-cli 0.145.0 lists a linked
    // package's skill as `<pkg>:<name>`, not as the link's directory name and
    // not as the bare frontmatter name — so a name-keyed match would have
    // reported "not listed" about an entry sitting in front of it.
    const subject = agentsRoundSubject();
    const listing: ListingObservation = {
      skills: ['something-else', 'agentspkg:agentsskill'],
      commands: [],
      skillPaths: ['/home/plugins/other/skills/y/SKILL.md', `${subject.sourceDir}/SKILL.md`],
    };
    expect(userTierMatches(subject, listing)).toEqual([
      {
        entry: 'agentspkg:agentsskill',
        path: `${subject.sourceDir}/SKILL.md`,
        list: 'skills',
      },
    ]);
  });

  it('matches by NAME where it reports none, across every form the entry could take', () => {
    const [subject] = claudeRoundSubjects();
    if (!subject) throw new Error('no subject');
    for (const form of [
      `${subject.pkg}__${subject.skill}`,
      `${subject.pkg}:${subject.skill}`,
      subject.skill,
    ]) {
      const matched = userTierMatches(subject, namesOnly('unrelated', form));
      expect(
        matched.map((match) => match.entry),
        `\`${form}\` must be attributed`
      ).toEqual([form]);
    }
    expect(userTierMatches(subject, namesOnly('unrelated'))).toEqual([]);
  });

  it('counts within one array, so Claude Code’s two lists are not read as two loads', () => {
    // The init message carries a skill's name in `skills` AND in
    // `slash_commands`. Summing would report every subject as listed twice,
    // which is the exact number the duplicate question is looking for.
    const [subject] = claudeRoundSubjects();
    if (!subject) throw new Error('no subject');
    const name = `${subject.pkg}__${subject.skill}`;
    expect(userTierMatches(subject, namesOnly(name))).toHaveLength(1);
  });
});

/**
 * `userTierVerdicts` with the liveness check stubbed out.
 *
 * Every case in this block drives a verdict BRANCH against hand-built paths that
 * were never staged on disk, so the real check would answer "not live" for all
 * of them and every branch would collapse into one UNKNOWN. The check ITSELF is
 * driven against a real staged fixture with a deliberately broken link, in "the
 * liveness control" below. The two halves together are the whole of it, and
 * neither is sufficient alone: stub only, and a dangling link passes silently;
 * real only, and the four branches are unreachable.
 */
function stubbedVerdicts(
  harness: SmokeHarness,
  subjects: readonly UserTierSubject[],
  observed: ListingObservation | undefined,
  absence: ListingAbsence = 'no-surface'
): Verdict[] {
  return userTierVerdicts(harness, subjects, observed, absence, { linkFault: () => undefined });
}
describe('the user-tier verdicts', () => {
  it('passes SRC-04 when the harness lists a skill it can only reach through the link', () => {
    const subjects = claudeRoundSubjects();
    const [linked] = subjects;
    if (!linked) throw new Error('no subject');
    const verdicts = stubbedVerdicts(
      CLAUDE,
      subjects,
      namesOnly(`${linked.pkg}__${linked.skill}`, 'injpkg:injskill')
    );
    const verdict = verdictFor(verdicts, 'user-tier-listed');
    expect(verdict.status).toBe('pass');
    expect(verdict.capabilities).toContain('SRC-04');
    // The raw entry, in the verdict itself. A verdict that said "listed 1×"
    // without it would be this runner asking to be believed.
    expect(verdict.detail).toContain(`${linked.pkg}__${linked.skill}`);
  });

  it('fails SRC-04 when the link reached nothing, and shows the whole listing', () => {
    const verdicts = stubbedVerdicts(CLAUDE, claudeRoundSubjects(), namesOnly('deep-research'));
    const verdict = verdictFor(verdicts, 'user-tier-listed');
    expect(verdict.status).toBe('fail');
    expect(verdict.detail).toContain('deep-research');
  });

  it('reads the `~/.agents/skills` answer against the vendor table, in BOTH directions', () => {
    const subject = agentsRoundSubject();
    const listed = namesOnly(`${subject.pkg}__${subject.skill}`);
    const empty = namesOnly('unrelated');

    // Codex documents the path. Listing it is agreement; not listing it is the
    // compiled facts contradicted by the binary they describe.
    expect(verdictFor(stubbedVerdicts(CODEX, [subject], listed), 'agents-user-root').status).toBe(
      'pass'
    );
    expect(verdictFor(stubbedVerdicts(CODEX, [subject], empty), 'agents-user-root').status).toBe(
      'fail'
    );

    // Claude Code does not. NOT listing it is the table and the binary agreeing;
    // listing it is the finding that shrinks slice A3.
    expect(verdictFor(stubbedVerdicts(CLAUDE, [subject], empty), 'agents-user-root').status).toBe(
      'pass'
    );
    const surprise = verdictFor(stubbedVerdicts(CLAUDE, [subject], listed), 'agents-user-root');
    expect(surprise.status).toBe('finding');
    // And the finding says what it costs the design: a harness that reads the
    // shared directory needs no second link of its own.
    expect(surprise.detail).toContain('needs no second link of its own');
  });

  it('passes the duplicate question at ONE entry, and says the fallback is not needed', () => {
    const subjects = claudeRoundSubjects();
    const verdicts = stubbedVerdicts(
      CLAUDE,
      subjects,
      namesOnly('userpkg__userskill', 'bothpkg__bothskill', 'injpkg:injskill')
    );
    const verdict = verdictFor(verdicts, 'injection-duplicate');
    expect(verdict.status).toBe('pass');
    expect(verdict.detail).toContain('sdkInjected');
    expect(verdict.cites).toContain('§2.9');
  });

  it('reports TWO entries as the FINDING that flips the design, never as a failure', () => {
    // §2.9's own words: two entries flip one condition. That is a design
    // decision the run hands back, not a red.
    const subjects = claudeRoundSubjects();
    const verdicts = stubbedVerdicts(CLAUDE, subjects, {
      skills: ['userpkg__userskill', 'bothpkg__bothskill', 'bothpkg:bothskill', 'injpkg:injskill'],
      commands: [],
      skillPaths: [],
    });
    const verdict = verdictFor(verdicts, 'injection-duplicate');
    expect(verdict.status).toBe('finding');
    expect(verdict.detail).toContain('bothpkg__bothskill');
    expect(verdict.detail).toContain('bothpkg:bothskill');
    expect(overallStatus(verdicts as never)).toBe('passed');
  });

  it('will not read ONE entry as dedupe when only one of the two routes worked', () => {
    // BOTH controls, and each one on its own is not enough. With the injection
    // route dead, "one entry" is one route working; with the link route dead it
    // is the other. Calling either "the two collapse to one" would be this
    // runner's most expensive possible lie — it is the sentence slice A3's
    // design is gated on.
    const subjects = claudeRoundSubjects();

    const noInjection = stubbedVerdicts(
      CLAUDE,
      subjects,
      namesOnly('userpkg__userskill', 'bothpkg__bothskill')
    );
    expect(verdictFor(noInjection, 'injection-control').status).toBe('fail');
    expect(verdictFor(noInjection, 'injection-duplicate').status).toBe('unknown');

    const noLink = stubbedVerdicts(
      CLAUDE,
      subjects,
      namesOnly('bothpkg:bothskill', 'injpkg:injskill')
    );
    expect(verdictFor(noLink, 'user-tier-listed').status).toBe('fail');
    expect(verdictFor(noLink, 'injection-duplicate').status).toBe('unknown');
    expect(verdictFor(noLink, 'injection-duplicate').detail).toContain('user-tier-listed');
  });

  it('fails the duplicate outright when both routes work and NEITHER produced an entry', () => {
    const subjects = claudeRoundSubjects();
    const verdicts = stubbedVerdicts(
      CLAUDE,
      subjects,
      namesOnly('userpkg__userskill', 'injpkg:injskill')
    );
    expect(verdictFor(verdicts, 'injection-duplicate').status).toBe('fail');
  });

  it('reports UNKNOWN — never a pass — for a harness that enumerated nothing', () => {
    const verdicts = stubbedVerdicts(OPENCODE, [agentsRoundSubject()], undefined);
    expect(verdicts.map((verdict) => verdict.status)).toEqual(['unknown']);
    expect(verdicts[0]?.detail).toContain(OPENCODE.listing.note.slice(0, 30));
  });

  it('tells "no listing surface" apart from "the probe never answered"', () => {
    const broken = stubbedVerdicts(CLAUDE, [agentsRoundSubject()], undefined, 'no-startup-record');
    expect(broken[0]?.detail).toContain('DID NOT RUN');
  });

  it('carries the citation the subject declared onto every verdict', () => {
    const verdicts = stubbedVerdicts(CLAUDE, claudeRoundSubjects(), namesOnly());
    for (const verdict of verdicts) {
      expect(
        verdict.capabilities.length > 0 || verdict.cites !== undefined,
        `${verdict.id} cites nothing`
      ).toBe(true);
    }
  });
});

describe('the $CODEX_HOME/skills round', () => {
  it('asks Codex about a directory its own row does not carry, and calls it a FINDING', () => {
    // THE ONE THE FIRST RUN MISSED. Its own raw listing carried five bundled
    // skills out of `<CODEX_HOME>/skills/.system/`, and it reported "0 finding"
    // — because nothing asked. A writable directory a harness reads and the
    // compiled facts omit is exactly what this tier is for.
    const roots = userTierRoots('/sandbox');
    const [subject] = userTierSubjects('codex-home-root', '/home', roots);
    if (!subject) throw new Error('no subject');
    expect(subject.link?.root).toBe(roots.codexHomeSkillsDir);
    expect(subject.documentedAs).toBe('$CODEX_HOME/skills');
    // What makes it a FINDING rather than a pass: the row does not carry the
    // path. If a vendor-facts refresh ever adds it — with the page this note
    // says it needs — this expectation reds, and it should: the verdict becomes
    // an ordinary agreement check on the same day.
    expect(HARNESS_VENDOR_FACTS.codex.skills.readPaths.user).not.toContain('$CODEX_HOME/skills');

    const listed = namesOnly(`${subject.pkg}:${subject.skill}`);
    const finding = verdictFor(stubbedVerdicts(CODEX, [subject], listed), 'codex-home-root');
    expect(finding.status).toBe('finding');
    expect(finding.capabilities).toContain('SRC-04');
    // It shows the entry, and it says what may NOT be done about it: adding the
    // read path without a vendor page to cite is the one edit that module's own
    // docstring calls the most damaging.
    expect(finding.detail).toContain(`${subject.pkg}:${subject.skill}`);
    expect(finding.detail).toContain('may NOT be added without a vendor page');
  });

  it('passes when the binary does not read it, so the finding can be answered either way', () => {
    const [subject] = userTierSubjects('codex-home-root', '/home', userTierRoots('/sandbox'));
    if (!subject) throw new Error('no subject');
    const verdict = verdictFor(
      stubbedVerdicts(CODEX, [subject], namesOnly('unrelated')),
      'codex-home-root'
    );
    expect(verdict.status).toBe('pass');
  });

  it('stages the link in `$CODEX_HOME/skills` and nothing in the other two roots', () => {
    const fixture = stageSmokeFixture(CODEX, { scenario: 'user-tier', round: 'codex-home-root' });
    try {
      const roots = userTierRoots(fixture.configHome);
      expect(fixture.userTierRoots).toEqual([roots.codexHomeSkillsDir]);
      expect(existsSync(roots.agentsSkillsDir)).toBe(false);
      expect(fixture.injectDirs).toEqual([]);
      const [subject] = fixture.subjects;
      if (!subject?.link) throw new Error('no link');
      expect(realpathSync(subject.link.target)).toBe(realpathSync(subject.sourceDir));
    } finally {
      fixture.cleanup();
    }
  });
});

describe('the liveness control on a not-listed verdict', () => {
  it('answers UNKNOWN, naming the link, when the fixture’s own link is broken', () => {
    // THE SILENT PASS THIS CLOSES. "Not listed" is evidence about a harness only
    // if the fixture really put something there for it to miss. Point the link
    // one level wrong and it resolves to nothing — the harness correctly lists
    // nothing — and without this check the verdict read `PASS: the table and the
    // binary agree` off a fixture that staged nothing at all.
    const fixture = stageSmokeFixture(CLAUDE, { scenario: 'user-tier', round: 'agents-user-root' });
    try {
      const [subject] = fixture.subjects;
      if (!subject?.link) throw new Error('no link');
      // Live to begin with, which is what makes the break meaningful.
      expect(userTierLinkFault(subject)).toBeUndefined();
      const healthy = verdictFor(
        userTierVerdicts(CLAUDE, fixture.subjects, namesOnly('unrelated')),
        'agents-user-root'
      );
      expect(healthy.status).toBe('pass');

      // One level wrong: still a symlink, still in the right directory, and it
      // resolves to nothing.
      rmSync(subject.link.target);
      symlinkSync(join('..', subject.link.text), subject.link.target);

      const fault = userTierLinkFault(subject);
      expect(fault).toBeDefined();
      const verdict = verdictFor(
        userTierVerdicts(CLAUDE, fixture.subjects, namesOnly('unrelated')),
        'agents-user-root'
      );
      expect(verdict.status).toBe('unknown');
      expect(verdict.status).not.toBe('pass');
      expect(verdict.detail).toContain(subject.link.target);
      expect(verdict.detail).toContain('the FIXTURE');
    } finally {
      fixture.cleanup();
    }
  });

  it('names the three ways a link can be wrong, and stays quiet when it is right', () => {
    const fixture = stageSmokeFixture(CODEX, { scenario: 'user-tier', round: 'agents-user-root' });
    try {
      const [subject] = fixture.subjects;
      if (!subject?.link) throw new Error('no link');
      expect(userTierLinkFault(subject)).toBeUndefined();

      // (a) it resolves somewhere real that is not the package.
      const elsewhere = join(fixture.configHome, 'elsewhere');
      mkdirSync(elsewhere, { recursive: true });
      rmSync(subject.link.target);
      symlinkSync(elsewhere, subject.link.target);
      expect(userTierLinkFault(subject)).toContain('resolves to');

      expect(userTierLinkFault(subject)).not.toContain('does not resolve');

      // (b) it points at the right directory, and that directory holds no
      // SKILL.md — a link a harness is RIGHT to ignore, so a not-listed verdict
      // off one would blame a vendor for the fixture's own mistake.
      rmSync(subject.link.target);
      symlinkSync(subject.sourceDir, subject.link.target);
      rmSync(join(subject.sourceDir, 'SKILL.md'));
      expect(userTierLinkFault(subject)).toContain('no `SKILL.md`');

      // (c) it dangles.
      rmSync(subject.link.target);
      symlinkSync(join(fixture.configHome, 'nowhere-at-all'), subject.link.target);
      expect(userTierLinkFault(subject)).toContain('does not resolve');
    } finally {
      fixture.cleanup();
    }
  });

  it('never gates a LISTED verdict on the link, because the entry already proves it', () => {
    const [subject] = userTierSubjects('agents-user-root', '/home', userTierRoots('/sandbox'));
    if (!subject) throw new Error('no subject');
    // No stub: the real check runs, and `/sandbox/...` does not exist. The
    // verdict is still a PASS, because the harness listed the entry.
    const verdict = verdictFor(
      userTierVerdicts(CODEX, [subject], namesOnly(`${subject.pkg}:${subject.skill}`)),
      'agents-user-root'
    );
    expect(verdict.status).toBe('pass');
  });
});

describe('reading a listing the user tier produced', () => {
  it('keeps a NAMESPACED Codex name whole, rather than reading half of it as a name', () => {
    // MEASURED, and it is why the line pattern changed. codex-cli 0.145.0 lists
    // a skill whose resolved directory sits inside a package carrying a
    // `.claude-plugin/plugin.json` as `<pkg>:<name>` — which is exactly what a
    // package under `<dorkHome>/plugins/` linked into `~/.agents/skills` is, and
    // every package under that root has the file (`requiresClaudePlugin` is
    // false only for `agent`, which installs elsewhere).
    //
    // The old "anything but a colon" pattern did not MIS-NAME that line, it
    // failed to match it at all: `[^:]+` stops at the inner colon and no shorter
    // prefix ends in one either, so the parser dropped the entry and the verdict
    // reading it would have reported a skill Codex had listed perfectly as NOT
    // LISTED. `agents-user-root` would have been a FAIL about the runner wearing
    // a vendor's name.
    const line = (text: string): string =>
      JSON.stringify([
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] },
      ]);
    const listing = parseCodexPromptInput(
      line(
        '<skills_instructions>\n' +
          '- agentspkg:agentsskill: The agentsskill skill (file: /home/plugins/agentspkg/skills/agentsskill/SKILL.md)\n'
      )
    );
    expect(listing.skills).toEqual(['agentspkg:agentsskill']);
    expect(listing.skillPaths).toEqual(['/home/plugins/agentspkg/skills/agentsskill/SKILL.md']);

    // And a description that carries a colon of its own is still a description:
    // the name can never cross a space, so nothing was traded away for this.
    const colonful = parseCodexPromptInput(
      line(
        '<skills_instructions>\n- x: Use when: you must (file: /repo/.agents/skills/x/SKILL.md)\n'
      )
    );
    expect(colonful.skills).toEqual(['x']);
    expect(colonful.skillPaths).toEqual(['/repo/.agents/skills/x/SKILL.md']);

    // The one direction `\S+` is STRICTER in, pinned so it is a known trade and
    // not a surprise: a name with a space in it is dropped. Codex documents no
    // charset rule for a skill name — its vendor-facts row carries no
    // `nameRegex` and `onInvalidName: 'unknown'` — so nobody knows whether such
    // a name is even legal. If a refresh ever finds out that it is, this case is
    // the one that changes.
    const spaced = parseCodexPromptInput(
      line(
        '<skills_instructions>\n- two words: a spaced name (file: /repo/.agents/skills/tw/SKILL.md)\n'
      )
    );
    expect(spaced.skills).toEqual([]);
  });
});
