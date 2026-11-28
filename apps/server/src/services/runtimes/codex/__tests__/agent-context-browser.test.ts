/**
 * A Codex turn is told to use the browser tools DorkOS gives it, not a browser of its
 * own (DOR-4357).
 *
 * On macOS, Codex's own sandbox refuses the Mach lookup Chromium needs, so a
 * Codex agent that runs Playwright itself fails. Those browser tools are
 * served by DorkOS, outside that sandbox, and a Codex chat already receives
 * them. Before this, nothing in a Codex prompt said so: the guide to them rides
 * only Claude Code's `<ui_tools>` block, and a Codex agent reached for
 * `pnpm playwright` instead.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { buildCodexAgentContext } from '../agent-context.js';
import { CODEX_DORKOS_TOOL_PREFIX } from '../../../core/tool-names/tool-names.js';

describe('the browser a Codex turn is pointed at (DOR-4357)', () => {
  it('names the browser tools DorkOS gives it, callable under Codex’s own prefix', async () => {
    const text = await buildCodexAgentContext('', true, undefined);

    expect(text).toContain(`${CODEX_DORKOS_TOOL_PREFIX}local_browser_observe`);
    expect(text).toContain(`${CODEX_DORKOS_TOOL_PREFIX}local_browser_act`);
    expect(text).toContain(`${CODEX_DORKOS_TOOL_PREFIX}browser_read_page`);
  });

  it('says plainly that Codex cannot start its own browser', async () => {
    const text = await buildCodexAgentContext('', true, undefined);

    expect(text).toContain('Codex can’t start its own browser on macOS.');
  });

  it('calls the shared page the Agent browser, never the DorkOS browser (DOR-3219)', async () => {
    const text = await buildCodexAgentContext('', true, undefined);

    expect(text).toContain('Agent browser');
    expect(text).not.toMatch(/DorkOS browser/i);
  });

  it('says nothing about them on a turn that carries no DorkOS tools', async () => {
    const text = await buildCodexAgentContext('neutral', false, undefined);

    expect(text.startsWith('neutral')).toBe(true);
    expect(text).not.toContain('<browser_tools>');
  });
});

describe('why gh can’t sign in on a Codex turn (DOR-4028)', () => {
  it.each([true, false])('says so on every turn, DorkOS tools or not (%s)', async (tools) => {
    const text = await buildCodexAgentContext('', tools, undefined);

    expect(text).toContain('The gh command can’t sign in to GitHub in this chat');
    expect(text).toContain('don’t set a GitHub token yourself (GH_TOKEN, GITHUB_TOKEN)');
  });

  it('rides with the stable half only, so a thread hears it once', async () => {
    const later = await buildCodexAgentContext({ text: '', carriesStable: false }, true, undefined);

    expect(later).not.toContain('<github_cli>');
  });

  it('names no file and no other way to sign in', async () => {
    const text = await buildCodexAgentContext('', true, undefined);
    const notice = text.slice(text.indexOf('<github_cli>'), text.indexOf('</github_cli>'));

    expect(notice).not.toMatch(/hosts\.yml|\.config|auth login|paste/i);
  });
});
