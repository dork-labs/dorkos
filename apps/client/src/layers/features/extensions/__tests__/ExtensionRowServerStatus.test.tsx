/**
 * The Settings row explains why the server half of an extension that runs
 * separately stopped or cannot start (DOR-2686): a "Not working" chip, and in
 * the open row one sentence per `serverError.code` with Try again, plus a line
 * while a restart is pending. Purpose: a person knows what happened and what
 * to do.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { ExtensionRow } from '../ui/ExtensionRow';

afterEach(() => {
  cleanup();
});

function makeExtension(overrides: Partial<ExtensionRecordPublic> = {}): ExtensionRecordPublic {
  return {
    id: 'mail',
    manifest: { id: 'mail', name: 'Mail', version: '1.0.0' },
    status: 'compiled',
    scope: 'global',
    origin: 'user',
    bundleReady: true,
    hasServerEntry: true,
    hasDataProxy: false,
    approvedToRun: true,
    shadowedBy: null,
    isolation: null,
    ...overrides,
  };
}

function renderRow(extension: ExtensionRecordPublic, { open = true, onReload = vi.fn() } = {}) {
  render(
    <ul>
      <ExtensionRow
        extension={extension}
        open={open}
        onOpenChange={vi.fn()}
        onToggle={vi.fn()}
        isToggling={false}
        onSetRunApproval={vi.fn()}
        isSettingApproval={false}
        onReload={onReload}
        isReloading={false}
      />
    </ul>
  );
  return onReload;
}

const CASES: Array<[string, string]> = [
  ['server_crashed', 'Mail stopped unexpectedly 3 times. Reload it to try again.'],
  ['server_out_of_memory', 'Mail ran out of memory and stopped. Reload it to try again.'],
  ['server_unresponsive', 'Mail stopped responding, so DorkOS stopped it.'],
  ['isolation_unavailable', 'Mail can’t run with its limits on this computer.'],
  ['server_start_failed', 'Mail couldn’t start. Reload it to try again.'],
  ['server_start_timeout', 'Mail took too long to start. Reload it to try again.'],
];

describe('ExtensionRow: a stopped server half (DOR-2686)', () => {
  // Purpose: with no message from the server, each code reads its shared
  // sentence, with Try again, and never the rebuild sentence.
  it.each(CASES)('%s reads its line, with Try again', async (code, line) => {
    const onReload = renderRow(makeExtension({ serverError: { code, message: '' } }));
    expect(screen.getByTestId('extension-health-mail')).toHaveTextContent('Not working');
    const panel = screen.getByTestId('extension-not-working-mail');
    expect(within(panel).getByText(line)).toBeInTheDocument();
    expect(screen.queryByText(/rebuild its server part/)).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Try again' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  // Purpose: the server's own sentence wins when it sent one.
  it('shows the server’s own sentence when it sent one', () => {
    renderRow(
      makeExtension({
        serverError: { code: 'server_crashed', message: 'Mail stopped 3 times today.' },
      })
    );
    expect(screen.getByText('Mail stopped 3 times today.')).toBeInTheDocument();
  });

  // Purpose: a rebuild failure keeps its own wording and is not "Not working".
  it('leaves a rebuild failure in its own words', () => {
    renderRow(
      makeExtension({ serverError: { code: 'compilation_failed', message: 'Syntax error' } })
    );
    expect(screen.queryByTestId('extension-health-mail')).not.toBeInTheDocument();
    expect(screen.getByTestId('extension-server-status-mail')).toHaveTextContent(
      'Couldn’t rebuild its server part: Syntax error. The last version still runs.'
    );
  });

  // Purpose: a pending restart is announced; nothing is said when none is.
  it('says it is restarting only while a restart is pending', () => {
    renderRow(makeExtension({ restartingAt: '2026-10-04T12:00:00.000Z' }));
    expect(screen.getByRole('status')).toHaveTextContent('Restarting Mail…');
    cleanup();
    renderRow(makeExtension({ restartingAt: '2026-10-04T12:00:00.000Z' }), { open: false });
    expect(screen.getByText('Restarting…')).toBeInTheDocument();
    cleanup();
    renderRow(makeExtension({ restartingAt: null }));
    expect(screen.queryByText(/Restarting/)).not.toBeInTheDocument();
  });
});
