import { describe, it, expect } from 'vitest';
import { formatDropList, formatWarnings } from '../drop-list.js';
import type { ProjectionPlan } from '../../plan/types.js';

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
      expect(heading(formatWarnings({ ...withPlanWarning, warnings: [] }, ['a sentence']))).toBe(
        'Warnings (may not commit as a link):'
      );
    });

    it('VC-01: names both when a run carries both', () => {
      expect(heading(formatWarnings(withPlanWarning, ['a sentence']))).toBe(
        'Warnings (may not work in the target harness, could not be read, or may not commit as a link):'
      );
    });
  });
});
