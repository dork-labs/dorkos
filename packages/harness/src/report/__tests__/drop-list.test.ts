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

  it('files a read-time loss under "plugin layers" rather than the harness it names', () => {
    // An unreadable hook declaration reaches no harness at all, so `claude-code`
    // on it is a placeholder the report must not repeat back (contract VC-02).
    const out = formatWarnings({
      actions: [],
      drops: [],
      warnings: [
        {
          artifact: 'hook',
          harness: 'claude-code',
          harnessAgnostic: true,
          name: 'acme:Stop',
          reason: '.dork/plugins/acme/hooks/hooks.json declares "Stop" in a shape …',
        },
      ],
      notEnabled: [],
    });
    expect(out).toContain('plugin layers:');
    expect(out).not.toContain('claude-code:');
  });

  it('returns an empty string when there are no warnings', () => {
    // Callers omit the block entirely when empty.
    expect(formatWarnings({ actions: [], drops: [], warnings: [], notEnabled: [] })).toBe('');
  });
});
