/**
 * The Settings card says what an extension gives agents (DOR-2685): one line,
 * "Gives agents 3 tools and 1 skill", that opens to each tool with what its
 * tier means and each skill, with the reason for anything DorkOS left out.
 * Purpose: a person can see, after approving, exactly what agents got.
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
    id: 'mail-app',
    manifest: { id: 'mail-app', name: 'Mail', version: '1.0.0' },
    status: 'active',
    scope: 'global',
    origin: 'user',
    bundleReady: true,
    hasServerEntry: true,
    hasDataProxy: false,
    approvedToRun: true,
    shadowedBy: null,
    ...overrides,
  };
}

function renderCard(extension: ExtensionRecordPublic) {
  return render(
    <ExtensionCard
      extension={extension}
      onToggle={vi.fn()}
      isToggling={false}
      onSetRunApproval={vi.fn()}
      isSettingApproval={false}
    />
  );
}

describe('ExtensionCard: what it gives agents', () => {
  it('says nothing for an extension that declares no tools or skills', () => {
    renderCard(makeExtension());

    expect(screen.queryByText(/Gives agents/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('extension-agent-gifts-mail-app')).not.toBeInTheDocument();
  });

  it('counts one tool in the singular', () => {
    renderCard(
      makeExtension({
        tools: [
          { name: 'list_inbox', title: 'List your inbox', tier: 'observe', status: 'active' },
        ],
      })
    );

    expect(screen.getByRole('button', { name: 'Gives agents 1 tool' })).toBeInTheDocument();
  });

  it('counts many, and opens to each tool with its tier label and each skill', async () => {
    renderCard(
      makeExtension({
        tools: [
          { name: 'list_inbox', title: 'List your inbox', tier: 'observe', status: 'active' },
          { name: 'send_message', title: 'Send an email', tier: 'act', status: 'inactive' },
          {
            name: 'delete_message',
            title: 'Delete an email',
            tier: 'destructive',
            status: 'active',
          },
        ],
        skills: [{ name: 'triage-inbox', status: 'ok' }],
      })
    );

    const toggle = screen.getByRole('button', { name: 'Gives agents 3 tools and 1 skill' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Send an email')).not.toBeInTheDocument();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const rows = within(screen.getByTestId('extension-agent-gifts-mail-app')).getAllByRole(
      'listitem'
    );
    expect(rows.map((row) => row.textContent)).toEqual([
      'List your inboxReads',
      'Send an emailActs',
      'Delete an emailAsks you first',
      'triage-inboxSkill',
    ]);
  });

  it('lists a refused tool and a dropped skill with their reasons, and never counts them', async () => {
    renderCard(
      makeExtension({
        tools: [
          { name: 'send_message', title: 'Send an email', tier: 'act', status: 'active' },
          {
            name: 'open_ended',
            title: 'Take "anything"',
            tier: 'observe',
            status: 'refused',
            reason: 'Its input must list every field.',
          },
        ],
        skills: [
          { name: 'gone', status: 'dropped', reason: 'Its folder is missing from skills/.' },
        ],
      })
    );

    await userEvent.click(screen.getByRole('button', { name: 'Gives agents 1 tool' }));

    expect(screen.getByText('Left out: Its input must list every field.')).toBeInTheDocument();
    expect(screen.getByText('Left out: Its folder is missing from skills/.')).toBeInTheDocument();
    // The refused tool is named by its checked name, never its unchecked title.
    expect(screen.getByText('open_ended')).toBeInTheDocument();
    expect(screen.queryByText('Take "anything"')).not.toBeInTheDocument();
  });

  it('says what it would give, not what it gives, while the extension does not run', () => {
    // Off, or waiting for approval: agents have none of it right now.
    renderCard(
      makeExtension({
        status: 'disabled',
        tools: [
          { name: 'list_inbox', title: 'List your inbox', tier: 'observe', status: 'inactive' },
        ],
      })
    );
    expect(screen.getByRole('button', { name: 'Would give agents 1 tool' })).toBeInTheDocument();
    cleanup();

    renderCard(
      makeExtension({
        approvedToRun: false,
        skills: [{ name: 'triage-inbox', status: 'ok' }],
      })
    );
    expect(screen.getByRole('button', { name: 'Would give agents 1 skill' })).toBeInTheDocument();
  });

  it('says no tools or skills reach agents when every one was left out', () => {
    renderCard(
      makeExtension({
        skills: [{ name: 'gone', status: 'dropped', reason: 'Its SKILL.md file is missing.' }],
      })
    );

    expect(
      screen.getByRole('button', { name: 'Gives agents no tools or skills' })
    ).toBeInTheDocument();
  });
});
