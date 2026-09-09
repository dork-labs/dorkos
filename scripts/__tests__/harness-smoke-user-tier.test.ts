/**
 * The user-tier scenario's FIXTURE and command line — DOR-1924's gate, staged.
 *
 * `scripts/harness-smoke/` had one fixture until this landed: a repository,
 * projected, asked what a harness finds inside a checkout. The user tier asks a
 * different question in a more dangerous place — an EMPTY project, and a
 * globally installed package reachable only through a link in a person's HOME.
 *
 * This half is what the scenario STAGES and how it is asked for: the flag, the
 * argv, the rounds each harness gets, the links and their text, and the report
 * file name. What the runner CONCLUDES from a binary's answer is the other half,
 * `harness-smoke-user-tier-oracle.test.ts` — the same split
 * `harness-smoke.test.ts` and `harness-smoke-oracles.test.ts` already have.
 *
 * The case that matters most here is that the two rounds are two STAGINGS. Both
 * ask which directory a harness opens, and one staging that wrote both could not
 * tell "this harness does not read `~/.agents/skills`" apart from "it stops
 * reading it once its own skills folder exists".
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
import { SMOKE_HARNESSES } from '../harness-smoke/harnesses.js';
import { reportFileName } from '../harness-smoke/report.js';
import { parseArgs } from '../harness-smoke/run.js';
import {
  SMOKE_SCENARIOS,
  stageSmokeFixture,
  userTierLinkText,
  userTierRoots,
  userTierSubjects,
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
    // Codex gets the shared directory AND `$CODEX_HOME/skills`, the writable
    // root the first free run printed five of its own bundled skills out of.
    expect(CODEX.userTierRounds).toEqual(['agents-user-root', 'codex-home-root']);
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
    for (const round of ['claude-user-root', 'agents-user-root', 'codex-home-root'] as const) {
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
        // The same string as `claudeSkillsDir`, and a second name for it on
        // purpose: this runner points `CLAUDE_CONFIG_DIR` and `CODEX_HOME` at
        // one sandbox, so the two collapse as a property of the isolation, never
        // of the vendors. Safe only because no round stages both.
        codexHomeSkillsDir: '/sandbox/skills',
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
