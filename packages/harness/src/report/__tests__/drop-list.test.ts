import { describe, it, expect } from 'vitest';
import { formatDropList, formatWarnings } from '../drop-list.js';
import type { ProjectionPlan } from '../../plan/types.js';
import { JUNCTION_COMMIT_WARNING } from '../../apply/windows-links.js';
import { blockedRemovalWarning, sweepBlindWarning } from '../../apply/sweep-warnings.js';

describe('formatDropList', () => {
  it('VC-01, VC-02: groups drops by harness with their reasons', () => {
    // The drop list is the honesty surface — each drop shows its harness + reason.
    const plan: ProjectionPlan = {
      actions: [],
      drops: [
        {
          kind: 'drop',
          artifact: 'command',
          harness: 'codex',
          provenance: 'authored',
          name: 'commands',
          reason: 'no slash-command format',
        },
      ],
      warnings: [],
      notEnabled: [],
    };
    const out = formatDropList(plan);
    expect(out).toContain('codex:');
    expect(out).toContain('command');
    expect(out).toContain('no slash-command format');
  });

  it('VC-02: files a drop that is not about one harness under "plugin layers", not under its placeholder', () => {
    // A non-portable plugin layer has no home in ANY harness, and it must still
    // carry a `HarnessId` — so it used to be printed under `codex:` in projects
    // that do not run Codex (contract VC-02).
    const out = formatDropList({
      actions: [],
      drops: [
        {
          kind: 'drop',
          artifact: 'plugin',
          harness: 'codex',
          harnessAgnostic: true,
          provenance: 'installed',
          name: 'acme:extensions',
          reason: 'plugin layer "extensions" is not a portable harness asset',
        },
        {
          kind: 'drop',
          artifact: 'command',
          harness: 'codex',
          provenance: 'authored',
          name: 'commands',
          reason: 'no slash-command format',
        },
      ],
      warnings: [],
      notEnabled: [],
    });
    expect(out).toContain('plugin layers:');
    expect(out).toMatch(/plugin layers:\n {2}- plugin "acme:extensions"/);
    // The genuinely per-harness drop keeps its own heading beside it.
    expect(out).toMatch(/codex:\n {2}- command "commands"/);
  });

  it('reports a clean message when there are no drops', () => {
    // No drops is a valid, honest outcome.
    expect(formatDropList({ actions: [], drops: [], warnings: [], notEnabled: [] })).toMatch(
      /No drops/
    );
  });
});

describe('formatWarnings', () => {
  it('VC-01: groups warnings by harness with their reasons', () => {
    const out = formatWarnings({
      actions: [],
      drops: [],
      warnings: [
        {
          artifact: 'hook',
          harness: 'codex',
          name: 'Stop',
          reason: 'hook command for "Stop" uses Claude-only "${CLAUDE_PLUGIN_ROOT}"; Codex …',
        },
      ],
      notEnabled: [],
    });
    expect(out).toContain('Warnings');
    expect(out).toContain('codex:');
    expect(out).toContain('Stop');
    expect(out).toContain('${CLAUDE_PLUGIN_ROOT}');
  });

  it('files a package’s read-time loss under "plugin layers" rather than the harness it names', () => {
    // An unreadable hook declaration reaches no harness at all, so `claude-code`
    // on it is a placeholder the report must not repeat back (contract VC-02).
    // The `source` is what says WHICH agnostic heading: it is a file inside the
    // package's own install directory. `planUnreadableHookWarnings` has carried
    // one since DOR-1845's review; this fixture predated that and omitted it.
    const out = formatWarnings({
      actions: [],
      drops: [],
      warnings: [
        {
          artifact: 'hook',
          harness: 'claude-code',
          harnessAgnostic: true,
          name: 'acme:Stop',
          source: '.dork/plugins/acme/hooks/hooks.json',
          reason: '.dork/plugins/acme/hooks/hooks.json declares "Stop" in a shape …',
        },
      ],
      notEnabled: [],
    });
    expect(out).toContain('plugin layers:');
    expect(out).not.toContain('claude-code:');
  });

  it('files the person’s own unreadable file under "this project"', () => {
    // The other agnostic bucket, and the reason there are two: a `.mcp.json` at
    // the repo root is not a plugin layer, and a project with nothing installed
    // was reading `plugin layers:` over a file it wrote itself.
    const out = formatWarnings({
      actions: [],
      drops: [],
      warnings: [
        {
          artifact: 'mcp',
          harness: 'claude-code',
          harnessAgnostic: true,
          name: '.mcp.json',
          source: '.mcp.json',
          reason: '.mcp.json is not valid JSON …',
        },
      ],
      notEnabled: [],
    });
    expect(out).toContain('this project:');
    expect(out).not.toContain('plugin layers:');
    expect(out).not.toContain('claude-code:');
  });

  it('files a global package’s broken manifest under "plugin layers", not "this project"', () => {
    // DOR-1933. Seeded defect: decide the heading by PATH first. A global
    // package's paths are absolute — there is no repository for them to be
    // relative to — so the `.dork/plugins/` prefix never matches, and a run with
    // no project at all printed `this project:` over a package in the person's
    // data directory.
    const out = formatWarnings({
      actions: [],
      drops: [],
      warnings: [
        {
          artifact: 'plugin',
          harness: 'claude-code',
          harnessAgnostic: true,
          name: 'badmanifest',
          source: '/home/someone/.dork/plugins/badmanifest/.dork/manifest.json',
          reason: 'This package has a file DorkOS could not read …',
        },
      ],
      notEnabled: [],
    });
    expect(out).toContain('plugin layers:');
    expect(out).not.toContain('this project:');
    expect(out).not.toContain('claude-code:');
  });

  it('files a global package’s unreadable skill folder under "plugin layers"', () => {
    // DOR-1935. The same heading question one artifact down: this is a `skill`,
    // so the kind does not answer it, and the path is absolute because a global
    // package has no repository to be relative to. Seeded defect: decide it by
    // the repo-relative prefix alone and a run with no project prints
    // `this project:` over a folder in the person's data directory.
    const out = formatWarnings({
      actions: [],
      drops: [],
      warnings: [
        {
          artifact: 'skill',
          harness: 'claude-code',
          harnessAgnostic: true,
          name: '/home/someone/.dork/plugins/globex/skills/greet',
          source: '/home/someone/.dork/plugins/globex/skills/greet',
          reason: 'DorkOS could not look inside this folder …',
        },
      ],
      notEnabled: [],
    });
    expect(out).toContain('plugin layers:');
    expect(out).not.toContain('this project:');
  });

  it('returns an empty string when there are no warnings', () => {
    // Callers omit the block entirely when empty.
    expect(formatWarnings({ actions: [], drops: [], warnings: [], notEnabled: [] })).toBe('');
  });

  describe('the heading names only what this run has to say', () => {
    /** A plan carrying one ordinary harness warning. */
    const withPlanWarning = {
      actions: [],
      drops: [],
      warnings: [
        { artifact: 'hook' as const, harness: 'codex' as const, name: 'Stop', reason: 'a reason' },
      ],
      notEnabled: [],
    };

    /** The heading, which is the first line of the block. */
    const heading = (out: string): string => out.split('\n')[0];

    it('VC-01: says nothing about committing when nothing in this run is about committing', () => {
      // The heading is read by everybody on every platform, and a run with no
      // run-level warning has no link that may fail to commit in it. Naming one
      // there tells a person on macOS about a Windows problem they do not have.
      expect(heading(formatWarnings(withPlanWarning))).toBe(
        'Warnings (may not work in the target harness, or could not be read):'
      );
    });

    it('VC-01: names the machine alone when that is all there is', () => {
      // The REAL sentence, not a placeholder. A run warning is one of three
      // families now, and which one a sentence belongs to is what decides the
      // words in the heading — so a test that handed the block "a sentence"
      // would be asserting whatever the fallback happens to be (DOR-1939,
      // DOR-1941 added the other two).
      expect(
        heading(formatWarnings({ ...withPlanWarning, warnings: [] }, [JUNCTION_COMMIT_WARNING]))
      ).toBe('Warnings (may not commit as a link):');
    });

    it('VC-01: names both when a run carries both', () => {
      expect(heading(formatWarnings(withPlanWarning, [JUNCTION_COMMIT_WARNING]))).toBe(
        'Warnings (may not work in the target harness, could not be read, or may not commit as a link):'
      );
    });

    it('VC-01: names each run family a run really carries, and no other', () => {
      // The families keep their declared order however the sentences arrive, so
      // one tree reads the same way twice.
      expect(
        heading(
          formatWarnings({ ...withPlanWarning, warnings: [] }, [
            sweepBlindWarning('.opencode/commands'),
            JUNCTION_COMMIT_WARNING,
          ])
        )
      ).toBe('Warnings (may not commit as a link, or could not be looked inside):');
    });

    it('VC-01: files everything about this repository under ONE heading', () => {
      // Seeded defect: one `SECTIONS` row per family, each pushing its own
      // heading. Two families share `this run:`, so the block printed the
      // heading twice with a blank line between — two sections that are one
      // subject, which reads as though the second list is about something else.
      const out = formatWarnings({ ...withPlanWarning, warnings: [] }, [
        sweepBlindWarning('.opencode/commands'),
        blockedRemovalWarning('.claude/skills/gone', '.claude/skills'),
        JUNCTION_COMMIT_WARNING,
      ]);

      expect(out.split('this run:').length).toBe(2);
      // Counted as whole LINES, not as substrings: the junction sentence itself
      // says "from this machine:", so splitting the block on that text finds it
      // twice for a reason that has nothing to do with headings.
      expect(out.split('\n').filter((line) => line === 'this machine:').length).toBe(1);
      expect(out.split('\n').filter((line) => line === 'this run:').length).toBe(1);
      // And the family order inside the section is the declared one, so one
      // tree reads the same way twice.
      expect(out.indexOf('.opencode/commands')).toBeLessThan(out.indexOf('.claude/skills/gone'));
    });

    it('VC-01: files the machine and the repository under different headings', () => {
      // Two subjects, two sections: a person cannot act on a junction from
      // inside this repository, and cannot act on a folder's mode from outside
      // it.
      const out = formatWarnings({ ...withPlanWarning, warnings: [] }, [
        sweepBlindWarning('.opencode/commands'),
        JUNCTION_COMMIT_WARNING,
      ]);

      expect(out).toContain('this machine:');
      expect(out).toContain('this run:');
      expect(out.indexOf('this machine:')).toBeLessThan(out.indexOf('this run:'));
      expect(out.indexOf(JUNCTION_COMMIT_WARNING)).toBeLessThan(out.indexOf('.opencode/commands'));
    });
  });
});

describe('formatWarnings — the run’s own', () => {
  /** A plan with nothing to say about any harness. */
  const emptyPlan: ProjectionPlan = { actions: [], drops: [], warnings: [], notEnabled: [] };

  it('VC-02: files a run warning under its own heading, after the harness ones', () => {
    // Seeded defect: drop the second argument. The block then says nothing at
    // all about a folder the sync could not look inside (DOR-1939), which is
    // the silence that ticket is about, reproduced one layer up.
    const out = formatWarnings(
      {
        ...emptyPlan,
        warnings: [
          { artifact: 'hook', harness: 'codex', name: 'Stop', reason: 'a Claude-only token' },
        ],
      },
      ['DorkOS could not look inside `.opencode/commands`.']
    );

    expect(out).toContain('codex:');
    expect(out).toContain('this run:');
    expect(out).toContain('DorkOS could not look inside `.opencode/commands`.');
    expect(out.indexOf('codex:')).toBeLessThan(out.indexOf('this run:'));
  });

  it('VC-02: prints the block for a run warning alone', () => {
    expect(
      formatWarnings(emptyPlan, ['DorkOS could not look inside `.opencode/commands`.'])
    ).toContain('this run:');
  });

  it('VC-02: stays empty when neither half has anything to say', () => {
    expect(formatWarnings(emptyPlan, [])).toBe('');
  });
});
