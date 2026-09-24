/**
 * The one line that says what a mode which stops asking does NOT cover, and the
 * guard that keeps all three places saying it (spec `agent-approval-settings`
 * §3.7; widened with the consent door by DOR-816).
 *
 * @vitest-environment jsdom
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PermissionModeScopeNote } from '../permission-mode-scope-note';

/** `apps/client/src`, resolved from this file rather than from the cwd. */
const CLIENT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Every place a person actually picks a permission mode or a trust stop.
 *
 * The promise is that they cannot drift into saying different things about the
 * same setting. Sharing one component is what makes that true; this list is what
 * notices when a new picker appears with no note, or when one of these loses it.
 *
 * **This list proves a MENTION, not a rendering.** It greps source text, so it
 * stays green against a site that renders the component with a descriptor that
 * can never match — which is exactly what the DOR-2102 review demonstrated by
 * blanking the descriptor on the two runtime-neutral dials and watching 1299
 * tests pass. Each of the last three sites therefore carries its own RTL
 * assertion (note present at autonomy, absent at a stop that still asks) beside
 * its own component: `ControlCenterDial.test.tsx`, `GlobalTrustRow.test.tsx`,
 * `TrustRow.test.tsx`. This guard is what notices a NEW picker; those are what
 * notice a broken one.
 *
 * The spec named the first three (a session, a binding, a schedule). DOR-2102
 * added the next three, all of which set where sessions START rather than what
 * one session is doing. Those three were the quietest hole in the promise: the
 * consent dialog carries the note, but a person with a standing
 * acknowledgement never opens the dialog again, so Settings and the Control
 * Center could move somebody to Full autonomy having said nothing at all about
 * DorkOS's own cards.
 *
 * DOR-2100 added the last, and it is a different shape from all six: the
 * SCHEDULE approval card, where approving a schedule an agent proposed can
 * also grant it the operator's own trust stop. It is the only site where the
 * thing being picked is somebody ELSE's proposal rather than the reader's own
 * setting.
 */
const MODE_PICKERS = [
  'layers/features/status/ui/PermissionModeItem.tsx',
  'layers/entities/binding/ui/BindingAdvancedSection.tsx',
  'layers/features/tasks/ui/TaskFormInner.tsx',
  'layers/features/settings/ui/runtimes/rows/TrustRow.tsx',
  'layers/features/settings/ui/runtimes/GlobalTrustRow.tsx',
  'layers/widgets/control-center/ui/ControlCenterDial.tsx',
  'layers/features/schedule-approval/ui/ScheduleApprovalCard.tsx',
];

afterEach(cleanup);

describe('PermissionModeScopeNote', () => {
  it('says what the mode covers, what it does not, and the one door to the rest', () => {
    render(<PermissionModeScopeNote mode="bypassPermissions" />);

    // All three facts, pinned literally (DOR-2102). The sentence used to carry
    // only the middle one, which is how "Full autonomy" came to read as a
    // promise the product does not keep.
    expect(
      screen.getByText(
        'This covers what an agent does in a session: editing files, running commands, and working ' +
          'outside this project. DorkOS’s own risky actions still stop for you, like deleting a ' +
          'schedule or removing an agent. To stop being asked about one, choose Always allow on ' +
          'its card, or change it in Settings under Permissions.'
      )
    ).toBeInTheDocument();
  });

  it('names two destructive actions that really are cards, not a made-up example', () => {
    // `tasks_delete` ("Delete a scheduled task") and `mesh_unregister` ("Remove
    // an agent…") are the shipped destructive MCP tools in
    // `services/core/mcp-tool-tiers.ts`. The old copy said "removing packages",
    // which is real but the rarest of the class — so the example taught the
    // wrong picture of what actually interrupts somebody.
    render(<PermissionModeScopeNote mode="bypassPermissions" />);
    expect(screen.getByText(/deleting a schedule or removing an agent/)).toBeInTheDocument();
  });

  it('names both places that stop the asking, and not a tab that is gone', () => {
    // Standing permissions were retired for per-agent, per-action Always allow
    // (spec `agent-permissions` D7): the card answers it, and Settings under
    // Permissions changes it. DOR-1758 merged Security into Access, so "under
    // Security" named a tab the dialog no longer has.
    render(<PermissionModeScopeNote mode="bypassPermissions" />);
    expect(screen.getByText(/choose Always allow on its card/)).toBeInTheDocument();
    expect(screen.getByText(/in Settings under Permissions/)).toBeInTheDocument();
    expect(screen.queryByText(/under Security/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Standing permissions/)).not.toBeInTheDocument();
  });

  it('appears for the other spelling of the same thing', () => {
    // `always-allow` is the test-mode runtime's name for "run everything". A note
    // that only knew one spelling would be silent on a session that bypasses.
    render(<PermissionModeScopeNote mode="always-allow" />);
    expect(screen.getByText(/This covers what an agent does in a session/)).toBeInTheDocument();
  });

  it('says nothing for a mode that still asks', () => {
    for (const mode of ['default', 'plan', 'acceptEdits', 'dontAsk', 'auto', null, undefined]) {
      const { unmount } = render(<PermissionModeScopeNote mode={mode} />);
      expect(
        screen.queryByText(/This covers what an agent does in a session/)
      ).not.toBeInTheDocument();
      unmount();
    }
  });

  it('follows what the runtime says the mode does, when the runtime has said', () => {
    // Codex's 'Full access' is the same promise under a name this component has
    // never heard of. Given the descriptor, the note does not need to have.
    render(
      <PermissionModeScopeNote
        mode="bypassPermissions"
        descriptor={{
          id: 'bypassPermissions',
          label: 'Full access',
          stop: 'autonomy',
          asks: 'never',
          reach: 'everything',
          promise: 'Runs everything without asking, network included.',
          native: 'danger-full-access',
        }}
      />
    );
    expect(screen.getByText(/This covers what an agent does in a session/)).toBeInTheDocument();
  });

  it('appears for a mode that never asks but cannot leave the workspace (DOR-816)', () => {
    // Codex's workspace-write. This case was deliberately QUIET until the
    // consent door widened, on the reasoning that the note is about "run
    // everything". Both halves of that turned out to be wrong. The sentence is
    // true of any session mode — a session's permission mode never governs
    // DorkOS's own approvals, whatever its reach — so the old condition was not
    // protecting accuracy, it was rationing a correction. And the dialog this
    // mode now opens carries the strongest promise on any screen ("whatever it
    // decides to do, it does"), which is exactly the one that must arrive with
    // its correction attached.
    render(
      <PermissionModeScopeNote
        mode="acceptEdits"
        descriptor={{
          id: 'acceptEdits',
          label: 'Workspace write',
          stop: 'act',
          asks: 'never',
          reach: 'workspace',
          promise: 'Edits files and runs commands inside the workspace — Codex can’t pause to ask.',
          native: 'workspace-write',
        }}
      />
    );
    expect(screen.getByText(/This covers what an agent does in a session/)).toBeInTheDocument();
  });

  it('stays quiet for a read-only mode, though it never asks either', () => {
    // Codex's default. It never asks because it has nothing to ask about, and a
    // clarification about what a mode does not cover is noise on a mode that
    // covers nothing. The note follows the consent door, and the door skips
    // this one too.
    render(
      <PermissionModeScopeNote
        mode="default"
        descriptor={{
          id: 'default',
          label: 'Read only',
          stop: 'ask',
          asks: 'never',
          reach: 'read',
          promise: 'Reads files and answers questions. Nothing on your machine changes.',
          native: 'read-only',
        }}
      />
    );
    expect(
      screen.queryByText(/This covers what an agent does in a session/)
    ).not.toBeInTheDocument();
  });

  it('stays quiet for a mode that still stops to ask, however far it reaches', () => {
    render(
      <PermissionModeScopeNote
        mode="acceptEdits"
        descriptor={{
          id: 'acceptEdits',
          label: 'Accept edits',
          stop: 'act',
          asks: 'when-risky',
          reach: 'everything',
          promise: 'Edits files on its own. Asks before it runs a command.',
        }}
      />
    );
    expect(
      screen.queryByText(/This covers what an agent does in a session/)
    ).not.toBeInTheDocument();
  });
});

describe('every place a permission mode or a trust stop is chosen carries the note', () => {
  for (const file of MODE_PICKERS) {
    it(`${file} renders PermissionModeScopeNote`, async () => {
      const source = await readFile(path.join(CLIENT_SRC, file), 'utf-8');
      expect(
        source.includes('<PermissionModeScopeNote'),
        `${file} lets a person choose a permission mode or a trust stop and does not ` +
          `render PermissionModeScopeNote. Somebody turning one on there would not be told ` +
          `that DorkOS's own risky actions still stop for them, nor where to change that — ` +
          `which is the surprise the note exists to prevent.`
      ).toBe(true);
    });
  }
});
