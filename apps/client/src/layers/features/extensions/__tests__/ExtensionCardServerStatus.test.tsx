/**
 * The Settings card explains why the server half of an extension that runs
 * separately stopped or cannot start (DOR-2686): one sentence per
 * `serverError.code`, each with the tab's Reload beside it, and a line while a
 * restart is pending. Purpose: a person knows what happened and what to do.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { ExtensionCard } from '../ui/ExtensionCard';

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

function renderCard(extension: ExtensionRecordPublic, onReload = vi.fn()) {
  render(
    <ExtensionCard
      extension={extension}
      onToggle={vi.fn()}
      isToggling={false}
      onSetRunApproval={vi.fn()}
      isSettingApproval={false}
      onReload={onReload}
      isReloading={false}
    />
  );
  return onReload;
}

const CASES: Array<[string, string]> = [
  ['server_crashed', 'Mail stopped unexpectedly 3 times. Reload it to try again.'],
  ['server_out_of_memory', 'Mail ran out of memory and stopped. Reload it to try again.'],
  ['server_unresponsive', 'Mail stopped responding, so DorkOS stopped it.'],
  ['isolation_unavailable', 'Mail can’t run with its limits on this computer.'],
  ['isolation_not_ready', 'Mail needs a newer DorkOS to run its server part.'],
];

describe('ExtensionCard: a stopped server half (DOR-2686)', () => {
  // Purpose: with no message from the server, each code reads its shared
  // sentence, with Reload beside it, and never the rebuild sentence.
  it.each(CASES)('%s reads its line, with Reload', async (code, line) => {
    const onReload = renderCard(makeExtension({ serverError: { code, message: '' } }));
    const status = screen.getByTestId('extension-server-status-mail');
    expect(within(status).getByText(line)).toBeInTheDocument();
    expect(screen.queryByText(/rebuild its server part/)).not.toBeInTheDocument();
    await userEvent.click(within(status).getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  // Purpose: the server's own sentence wins when it sent one.
  it('shows the server’s own sentence when it sent one', () => {
    renderCard(
      makeExtension({
        serverError: { code: 'server_crashed', message: 'Mail stopped 3 times today.' },
      })
    );
    expect(screen.getByText('Mail stopped 3 times today.')).toBeInTheDocument();
  });

  // Purpose: a rebuild failure keeps its own wording and gets no Reload line.
  it('leaves a rebuild failure in its own words', () => {
    renderCard(
      makeExtension({ serverError: { code: 'compilation_failed', message: 'Syntax error' } })
    );
    expect(screen.queryByTestId('extension-server-status-mail')).not.toBeInTheDocument();
    expect(screen.getByText(/Couldn’t rebuild its server part/)).toBeInTheDocument();
  });

  // Purpose: a pending restart is announced; nothing is said when none is.
  it('says it is restarting only while a restart is pending', () => {
    renderCard(makeExtension({ restartingAt: '2026-10-04T12:00:00.000Z' }));
    expect(screen.getByRole('status')).toHaveTextContent('Restarting Mail…');
    cleanup();
    renderCard(makeExtension({ restartingAt: null }));
    expect(screen.queryByText(/Restarting/)).not.toBeInTheDocument();
  });
});
