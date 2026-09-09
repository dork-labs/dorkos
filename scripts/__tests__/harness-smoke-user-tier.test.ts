/**
 * The user-tier scenario — DOR-1924's gate, tested without a real harness.
 *
 * `scripts/harness-smoke/` had one fixture until this landed: a repository,
 * projected, asked what a harness finds inside a checkout. The user tier asks a
 * different question in a more dangerous place — an EMPTY project, and a
 * globally installed package reachable only through a link in a person's HOME —
 * so it has its own fixture, its own oracle (`harness-smoke/user-tier.ts`) and
 * its own file here.
 *
 * What every case below is really defending is that the three answers this
 * scenario produces can be trusted, because a design decision is gated on them:
 *
 * - the two rounds are two STAGINGS, so "this harness does not read
 *   `~/.agents/skills`" cannot be confused with "it stops reading it once its
 *   own skills folder exists";
 * - the duplicate question carries a control per ROUTE and refuses to answer
 *   without both, so "one entry" can never mean "one of the two routes was
 *   dead";
 * - an entry is attributed by PATH wherever a harness reports one, because none
 *   of the three names anybody predicted turned out to be the name a binary
 *   printed.
 *
 * Nothing here reaches a model or sets a real key.
 */
import { describe, it, expect } from 'vitest';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  SMOKE_HARNESSES,
  parseCodexPromptInput,
  type ListingObservation,
} from '../harness-smoke/harnesses.js';
import { overallStatus } from '../harness-smoke/oracles.js';
import { userTierMatches, userTierVerdicts } from '../harness-smoke/user-tier.js';
import { reportFileName } from '../harness-smoke/report.js';
import { parseArgs } from '../harness-smoke/run.js';
import {
  SMOKE_SCENARIOS,
  stageSmokeFixture,
  userTierLinkText,
  userTierRoots,
  userTierSubjects,
  type UserTierSubject,
} from '../harness-smoke/fixture.js';

const CLAUDE = SMOKE_HARNESSES.claude;
const CODEX = SMOKE_HARNESSES.codex;
const OPENCODE = SMOKE_HARNESSES.opencode;

describe('the --scenario flag', () => {
  it('defaults to the project fixture, so every existing run is the run it was', () => {
    const parsed = parseArgs(['claude'], '/reports');
    expect(parsed.ok && parsed.options.scenario).toBe('project');
  });

  it('takes the user-tier fixture', () => {
    const parsed = parseArgs(['claude', '--scenario', 'user-tier'], '/reports');
    expect(parsed.ok && parsed.options.scenario).toBe('user-tier');
  });

  it('refuses a word that names no fixture, and says which ones do', () => {
    for (const value of ['', 'user tier', 'usertier', 'global']) {
      const parsed = parseArgs(['claude', '--scenario', value], '/reports');
      expect(parsed.ok, `--scenario ${value} must be refused`).toBe(false);
      expect(parsed.ok === false && parsed.error).toContain('user-tier');
    }
    expect(parseArgs(['claude', '--scenario'], '/reports').ok).toBe(false);
  });

  it('names both fixtures in the usage line', () => {
    const parsed = parseArgs(['--help'], '/reports');
    for (const scenario of SMOKE_SCENARIOS) {
      expect(parsed.ok === false && parsed.error).toContain(scenario);
    }
  });
});

describe('the injection flag', () => {
  it('adds NOTHING to the argv when nothing is injected — the byte-identical guarantee', () => {
    // The project scenario passes an empty list, and the two committed reports
    // in `meta/harness-smoke/` were regenerated against this to prove it: their
    // turn command lines are unchanged.
    const args = CLAUDE.turnProbe({
      repoRoot: '/repo',
      binaryPath: '/usr/local/bin/claude',
      prompt: 'hi',
      noncesDir: '/sandbox/nonces',
      model: 'm',
      maxUsd: 0.25,
      injectDirs: [],
    }).args;
    expect(args).not.toContain('--plugin-dir');
  });

  it('passes one --plugin-dir per package, the way the SDK does', () => {
    // `@anthropic-ai/claude-agent-sdk` 0.3.224 (`sdk.mjs`) turns each
    // `{ type: 'local', path }` from `plugin-activation.ts` into exactly this
    // flag, repeated. Anything else would be measuring a session DorkOS does not
    // drive.
    const args = CLAUDE.turnProbe({
      repoRoot: '/repo',
      binaryPath: '/usr/local/bin/claude',
      prompt: 'hi',
      noncesDir: '/sandbox/nonces',
      model: 'm',
      maxUsd: 0.25,
      injectDirs: ['/home/plugins/a', '/home/plugins/b'],
    }).args;
    expect(args.filter((arg) => arg === '--plugin-dir')).toHaveLength(2);
    expect(args[args.indexOf('--plugin-dir') + 1]).toBe('/home/plugins/a');
    expect(args[args.lastIndexOf('--plugin-dir') + 1]).toBe('/home/plugins/b');
    // The prompt stays last, so the flag can never eat it.
    expect(args[args.length - 1]).toBe('hi');
  });

  it('gives no other harness an injection route, because none of them has one', () => {
    // Codex and OpenCode are not driven through a plugin loader by anything in
    // DorkOS, so a flag here would be this runner inventing a route rather than
    // reproducing one.
    for (const harness of [CODEX, OPENCODE]) {
      const args = harness.turnProbe({
        repoRoot: '/repo',
        binaryPath: `/usr/local/bin/${harness.binary}`,
        prompt: 'hi',
        noncesDir: '/sandbox/nonces',
        model: 'm',
        maxUsd: 0.25,
        injectDirs: ['/home/plugins/a'],
      }).args;
      expect(args, `${harness.id} must not grow an injection flag`).not.toContain('--plugin-dir');
    }
  });
});

describe('which user-tier rounds each harness is asked', () => {
  it('asks Claude Code both, and everyone else the shared directory only', () => {
    // Per READ PATH, not per taste: only Claude Code has a personal skills
    // folder of its own, and only Claude Code has an injection route.
    expect(CLAUDE.userTierRounds).toEqual(['claude-user-root', 'agents-user-root']);
    expect(CODEX.userTierRounds).toEqual(['agents-user-root']);
    expect(OPENCODE.userTierRounds).toEqual(['agents-user-root']);
  });

  it('stages a subject for every round every harness names', () => {
    const roots = userTierRoots('/sandbox');
    for (const harness of Object.values(SMOKE_HARNESSES)) {
      for (const round of harness.userTierRounds) {
        const subjects = userTierSubjects(round, '/home', roots);
        expect(subjects.length, `${harness.id}/${round} must stage something`).toBeGreaterThan(0);
        for (const subject of subjects) {
          expect(
            subject.capabilities.length > 0 || subject.cites !== undefined,
            `${subject.id} must cite a contract row or a document`
          ).toBe(true);
        }
      }
    }
  });

  it('gives every subject a distinct skill name, because Claude Code lists no paths', () => {
    // A name-only listing is the whole reason this matters: two subjects sharing
    // a skill name would make the bare-name candidate ambiguous and every count
    // meaningless.
    const roots = userTierRoots('/sandbox');
    for (const round of ['claude-user-root', 'agents-user-root'] as const) {
      const subjects = userTierSubjects(round, '/home', roots);
      const names = subjects.map((subject) => subject.skill);
      expect(new Set(names).size, `${round} reuses a skill name`).toBe(names.length);
      expect(new Set(subjects.map((subject) => subject.pkg)).size).toBe(subjects.length);
    }
  });
});

describe('the user-tier fixture', () => {
  it('stages an EMPTY project, so a listing entry has exactly one possible route', () => {
    const fixture = stageSmokeFixture(CLAUDE, {
      scenario: 'user-tier',
      round: 'claude-user-root',
    });
    try {
      expect(readdirSync(fixture.repoRoot)).toEqual([]);
      expect(fixture.plan).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });

  it('writes the link slice A3 writes, with the link text the shipped apply computes', () => {
    // `globalLinkText` in `packages/harness/src/apply/global-apply.ts` is
    // `relative(dirname(target), source)`, and it is relative on purpose: a dork
    // home under a symlinked parent keeps working, and every macOS temp
    // directory is one. A measurement of an absolute link would be a
    // measurement of a shape A3 never writes.
    const fixture = stageSmokeFixture(CLAUDE, {
      scenario: 'user-tier',
      round: 'claude-user-root',
    });
    try {
      for (const subject of fixture.subjects) {
        if (!subject.link) continue;
        expect(lstatSync(subject.link.target).isSymbolicLink()).toBe(true);
        const text = readlinkSync(subject.link.target);
        expect(text).toBe(relative(dirname(subject.link.target), subject.sourceDir));
        expect(text.startsWith('/')).toBe(false);
        // And it resolves: a link that does not is a fixture that measures nothing.
        expect(realpathSync(subject.link.target)).toBe(realpathSync(subject.sourceDir));
        expect(existsSync(join(subject.link.target, 'SKILL.md'))).toBe(true);
      }
      expect(userTierLinkText('/a/b/c/link', '/a/x/y')).toBe('../../x/y');
    } finally {
      fixture.cleanup();
    }
  });

  it('gives every package the Claude Code plugin manifest a real install carries', () => {
    // `--plugin-dir` is a plugin loader and a directory with no plugin manifest
    // is not a plugin, so without this the injection round would measure a
    // refusal it caused itself.
    const fixture = stageSmokeFixture(CLAUDE, {
      scenario: 'user-tier',
      round: 'claude-user-root',
    });
    try {
      for (const subject of fixture.subjects) {
        const manifest = join(
          fixture.dorkHome,
          'plugins',
          subject.pkg,
          '.claude-plugin',
          'plugin.json'
        );
        expect(JSON.parse(readFileSync(manifest, 'utf8'))).toMatchObject({ name: subject.pkg });
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('injects exactly the packages that are meant to be injected', () => {
    const fixture = stageSmokeFixture(CLAUDE, {
      scenario: 'user-tier',
      round: 'claude-user-root',
    });
    try {
      const injected = fixture.subjects.filter((subject) => subject.injected);
      expect(injected.map((subject) => subject.id).sort()).toEqual([
        'injection-control',
        'injection-duplicate',
      ]);
      expect(fixture.injectDirs).toHaveLength(injected.length);
      for (const subject of injected) {
        expect(fixture.injectDirs).toContain(join(fixture.dorkHome, 'plugins', subject.pkg));
      }
      // The control is reachable ONLY by injection. If it had a link, a listing
      // entry for it would prove nothing about the injection route.
      const control = fixture.subjects.find((subject) => subject.id === 'injection-control');
      expect(control?.link).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps each round to ONE root, which is the only reason there are two rounds', () => {
    // THE CASE THE SPLIT EXISTS FOR. If a round wrote both directories, "this
    // harness does not read `~/.agents/skills`" could not be told apart from "it
    // stops reading it once its own skills folder exists".
    const first = stageSmokeFixture(CLAUDE, { scenario: 'user-tier', round: 'claude-user-root' });
    try {
      const roots = userTierRoots(first.configHome);
      expect(first.userTierRoots).toEqual([roots.claudeSkillsDir]);
      expect(existsSync(roots.agentsSkillsDir)).toBe(false);
    } finally {
      first.cleanup();
    }
    const second = stageSmokeFixture(CLAUDE, { scenario: 'user-tier', round: 'agents-user-root' });
    try {
      const roots = userTierRoots(second.configHome);
      expect(second.userTierRoots).toEqual([roots.agentsSkillsDir]);
      expect(existsSync(roots.claudeSkillsDir)).toBe(false);
      expect(second.injectDirs).toEqual([]);
    } finally {
      second.cleanup();
    }
  });

  it('puts both user roots inside the run’s own sandbox, never a person’s home', () => {
    const fixture = stageSmokeFixture(CODEX, { scenario: 'user-tier', round: 'agents-user-root' });
    try {
      for (const root of fixture.userTierRoots) {
        expect(root.startsWith(fixture.configHome)).toBe(true);
      }
      expect(userTierRoots('/sandbox')).toEqual({
        claudeSkillsDir: '/sandbox/skills',
        agentsSkillsDir: '/sandbox/.agents/skills',
      });
    } finally {
      fixture.cleanup();
    }
  });

  it('still stages the original fixture when nothing asks for the other one', () => {
    const fixture = stageSmokeFixture(CLAUDE);
    try {
      expect(fixture.scenario).toBe('project');
      expect(fixture.subjects).toEqual([]);
      expect(fixture.injectDirs).toEqual([]);
      expect(fixture.userTierRoots).toEqual([]);
      expect(fixture.plan).toBeDefined();
    } finally {
      fixture.cleanup();
    }
  });
});

describe('the report file name', () => {
  it('is unchanged for the fixture that had no name for itself', () => {
    expect(reportFileName('2026-09-09T07:36:03.751Z', 'claude')).toBe(
      '20260909-073603.751-claude.md'
    );
    expect(reportFileName('2026-09-09T07:36:03.751Z', 'claude', 'project')).toBe(
      '20260909-073603.751-claude.md'
    );
  });

  it('names the scenario when there is one, so two answers cannot overwrite each other', () => {
    expect(reportFileName('2026-09-09T07:36:03.751Z', 'claude', 'user-tier')).toBe(
      '20260909-073603.751-claude-user-tier.md'
    );
  });
});

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

describe('the user-tier verdicts', () => {
  it('passes SRC-04 when the harness lists a skill it can only reach through the link', () => {
    const subjects = claudeRoundSubjects();
    const [linked] = subjects;
    if (!linked) throw new Error('no subject');
    const verdicts = userTierVerdicts(
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
    const verdicts = userTierVerdicts(CLAUDE, claudeRoundSubjects(), namesOnly('deep-research'));
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
    expect(verdictFor(userTierVerdicts(CODEX, [subject], listed), 'agents-user-root').status).toBe(
      'pass'
    );
    expect(verdictFor(userTierVerdicts(CODEX, [subject], empty), 'agents-user-root').status).toBe(
      'fail'
    );

    // Claude Code does not. NOT listing it is the table and the binary agreeing;
    // listing it is the finding that shrinks slice A3.
    expect(verdictFor(userTierVerdicts(CLAUDE, [subject], empty), 'agents-user-root').status).toBe(
      'pass'
    );
    const surprise = verdictFor(userTierVerdicts(CLAUDE, [subject], listed), 'agents-user-root');
    expect(surprise.status).toBe('finding');
    expect(surprise.detail).toContain('redundant');
  });

  it('passes the duplicate question at ONE entry, and says the fallback is not needed', () => {
    const subjects = claudeRoundSubjects();
    const verdicts = userTierVerdicts(
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
    const verdicts = userTierVerdicts(CLAUDE, subjects, {
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

    const noInjection = userTierVerdicts(
      CLAUDE,
      subjects,
      namesOnly('userpkg__userskill', 'bothpkg__bothskill')
    );
    expect(verdictFor(noInjection, 'injection-control').status).toBe('fail');
    expect(verdictFor(noInjection, 'injection-duplicate').status).toBe('unknown');

    const noLink = userTierVerdicts(
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
    const verdicts = userTierVerdicts(
      CLAUDE,
      subjects,
      namesOnly('userpkg__userskill', 'injpkg:injskill')
    );
    expect(verdictFor(verdicts, 'injection-duplicate').status).toBe('fail');
  });

  it('reports UNKNOWN — never a pass — for a harness that enumerated nothing', () => {
    const verdicts = userTierVerdicts(OPENCODE, [agentsRoundSubject()], undefined);
    expect(verdicts.map((verdict) => verdict.status)).toEqual(['unknown']);
    expect(verdicts[0]?.detail).toContain(OPENCODE.listing.note.slice(0, 30));
  });

  it('tells "no listing surface" apart from "the probe never answered"', () => {
    const broken = userTierVerdicts(CLAUDE, [agentsRoundSubject()], undefined, 'no-startup-record');
    expect(broken[0]?.detail).toContain('DID NOT RUN');
  });

  it('carries the citation the subject declared onto every verdict', () => {
    const verdicts = userTierVerdicts(CLAUDE, claudeRoundSubjects(), namesOnly());
    for (const verdict of verdicts) {
      expect(
        verdict.capabilities.length > 0 || verdict.cites !== undefined,
        `${verdict.id} cites nothing`
      ).toBe(true);
    }
  });
});

describe('reading a listing the user tier produced', () => {
  it('keeps a NAMESPACED Codex name whole, rather than reading half of it as a name', () => {
    // MEASURED, and it is why the line pattern changed. codex-cli 0.145.0 lists
    // a skill whose resolved directory sits inside a package carrying a
    // `.claude-plugin/plugin.json` as `<pkg>:<name>` — which is exactly what a
    // marketplace-installed package linked into `~/.agents/skills` is. The old
    // "anything but a colon" pattern read `agentspkg:agentsskill` as the name
    // `agentspkg` and folded the rest into the description, which would have put
    // a name Codex never printed into a report whose whole job is to say what
    // the binary printed.
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
  });
});
