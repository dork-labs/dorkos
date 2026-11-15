/**
 * A Codex turn is told to use the DorkOS browser tools, not a browser of its
 * own (DOR-4357).
 *
 * On macOS, Codex's own sandbox refuses the Mach lookup Chromium needs, so a
 * Codex agent that runs Playwright itself fails. The DorkOS browser tools are
 * served by DorkOS, outside that sandbox, and a Codex chat already receives
 * them. Before this, nothing in a Codex prompt said so: the guide to them rides
 * only Claude Code's `<ui_tools>` block, and a Codex agent reached for
 * `pnpm playwright` instead.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { buildCodexAgentContext } from '../agent-context.js';
import { CODEX_DORKOS_TOOL_PREFIX } from '../../shared/dorkos-tool-names.js';

describe('the browser a Codex turn is pointed at (DOR-4357)', () => {
  it('names the DorkOS browser tools, callable under Codex’s own prefix', async () => {
    const text = await buildCodexAgentContext('', true, undefined);

    expect(text).toContain(`${CODEX_DORKOS_TOOL_PREFIX}local_browser_observe`);
    expect(text).toContain(`${CODEX_DORKOS_TOOL_PREFIX}local_browser_act`);
    expect(text).toContain(`${CODEX_DORKOS_TOOL_PREFIX}browser_read_page`);
  });

  it('says plainly that Codex cannot start its own browser', async () => {
    const text = await buildCodexAgentContext('', true, undefined);

    expect(text).toContain('Codex can’t start its own browser on macOS.');
  });

  it('says nothing about them on a turn that carries no DorkOS tools', async () => {
    const text = await buildCodexAgentContext('neutral', false, undefined);

    expect(text).toBe('neutral');
  });
});
