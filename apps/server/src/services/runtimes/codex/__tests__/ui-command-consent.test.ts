import { describe, it, expect } from 'vitest';
import { UI_COMMAND_REACH } from '@dorkos/shared/schemas';
import { isUiActionRefusedOnCodex, uiActionRefusalMessage } from '../ui-command-consent.js';

/**
 * The refusal predicate reads the shared reach table, so a new `control_ui`
 * action is covered by whatever verdict `UI_COMMAND_REACH` gives it — nothing
 * here needs editing when the union grows (DOR-639).
 *
 * OpenCode, checked in the same pass, needs no equivalent gate: it never receives
 * `control_ui` at all. Its only DorkOS tool surface is the external `/mcp` server,
 * which excludes the in-session-only tools — pinned by
 * `services/core/external-mcp/__tests__/surface-parity.test.ts` ("keeps the
 * in-session-only tools off the external server", which lists `control_ui`) — and
 * there is no scoped UI server or `ui_command` mapping anywhere under
 * `services/runtimes/opencode/`.
 */
describe('isUiActionRefusedOnCodex', () => {
  it('refuses exactly the actions UI_COMMAND_REACH says leave the browser', () => {
    for (const [action, reach] of Object.entries(UI_COMMAND_REACH)) {
      expect(isUiActionRefusedOnCodex(action), action).toBe(reach !== 'client-only');
    }
  });

  it('lets an unknown action through to the mapper, which rejects it as invalid', () => {
    // Fail-closed lives in the mapper: an action outside the union has no reach
    // verdict here, and `UiCommandSchema` there turns it into `ui_command_invalid`
    // rather than a `ui_command`. Prototype keys must not read as verdicts.
    expect(isUiActionRefusedOnCodex('not_a_real_action')).toBe(false);
    expect(isUiActionRefusedOnCodex('toString')).toBe(false);
    expect(isUiActionRefusedOnCodex('constructor')).toBe(false);
  });
});

describe('uiActionRefusalMessage', () => {
  it('names the action and where to go instead, and claims nothing about cron', () => {
    const message = uiActionRefusalMessage('apply_layout');

    expect(message).toContain('apply_layout');
    expect(message).toContain('DorkOS app');
    // The rationale this refusal rests on is that the action WRITES. An earlier
    // draft said it armed schedules carrying `bypassPermissions`, which is false
    // on this tree twice over (DOR-607 clamps the mode, DOR-1486 parks the
    // schedule pending approval). Pinned so the false claim cannot creep back in
    // through the one string a user or an agent actually reads.
    expect(message).not.toMatch(/bypass/i);
    expect(message).not.toMatch(/unattended/i);
  });
});
