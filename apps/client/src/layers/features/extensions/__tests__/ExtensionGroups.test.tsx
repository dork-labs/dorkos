/**
 * @vitest-environment jsdom
 *
 * A plugin's extensions as one row, and "Allow all" (DOR-3583). Purpose: the
 * group is the plugin that installed them and nothing else; its switch never
 * approves; the card says what the set may do in the designer's words; and a
 * partial answer says which were allowed, never a success toast.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import type {
  ApprovalSetMemberView,
  ExtensionApprovalSet,
} from '@dorkos/shared/extension-approval-schemas';

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: () => {} };
});

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

import { ExtensionsSettingsTab } from '../ui/ExtensionsSettingsTab';
import { approvalSetSummary } from '../ui/ApprovalSetCard';
import { groupExtensions } from '../lib/extension-groups';
import { pluginDisplayName } from '@/layers/entities/extension';
import { toast } from 'sonner';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function ext(id: string, overrides: Partial<ExtensionRecordPublic> = {}): ExtensionRecordPublic {
  return {
    id,
    manifest: {
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      version: '1.0.0',
      summary: `${id} things`,
    },
    status: 'active',
    scope: 'global',
    origin: 'user',
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
    approvedToRun: true,
    shadowedBy: null,
    sourcePlugin: 'marketing-suite',
    ...overrides,
  } as ExtensionRecordPublic;
}

function member(id: string, overrides: Partial<ApprovalSetMemberView> = {}): ApprovalSetMemberView {
  const name = id.charAt(0).toUpperCase() + id.slice(1);
  return {
    id,
    name,
    purpose: `${id} things`,
    version: '1.0.0',
    state: 'waiting',
    runsInServer: false,
    reachesInternet: false,
    permissions: { runtime: 'subprocess', net: [], run: [], agents: false, hasPage: true },
    echo: {
      id,
      version: '1.0.0',
      expectedDigest: `digest-${id}`,
      permissions: { runtime: 'subprocess', net: [], run: [], agents: false },
    },
    ...overrides,
  };
}

const calls: Array<{ url: string; body?: unknown }> = [];

function serve(
  extensions: ExtensionRecordPublic[],
  sets: ExtensionApprovalSet[],
  approveSet?: unknown
) {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (value: unknown) =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(value) });
      if (url.includes('/extensions/approval-sets')) return json({ sets });
      if (url.includes('/extensions/approve-set')) return json(approveSet);
      if (url.endsWith('/extensions')) return json(extensions);
      if (/\/extensions\/[^/]+\/(enable|disable)$/.test(url)) return json({});
      return json({ approvals: [], risks: [], sources: [] });
    })
  );
}

describe('groupExtensions', () => {
  it('groups only what one plugin installed, and leaves dev links and loose copies alone', () => {
    const { groups, loose } = groupExtensions([
      ext('writer'),
      ext('social'),
      ext('linked', { devLink: { path: '/src/linked' } }),
      ext('mine', { sourcePlugin: undefined }),
      ext('lonely', { sourcePlugin: 'solo' }),
    ]);

    expect(groups.map((group) => [group.name, group.members.map((m) => m.id)])).toEqual([
      ['Marketing suite', ['social', 'writer']],
    ]);
    expect(loose.map((e) => e.id)).toEqual(['linked', 'mine', 'lonely']);
    expect(pluginDisplayName('marketing_suite')).toBe('Marketing suite');
  });
});

describe('approvalSetSummary', () => {
  it('leaves out a zero clause', () => {
    expect(approvalSetSummary([member('a'), member('b')])).toBeNull();
    expect(approvalSetSummary([member('a', { runsInServer: true }), member('b')])).toBe(
      '1 run code here.'
    );
    expect(
      approvalSetSummary([
        member('writer', { runsInServer: true, reachesInternet: true }),
        member('social', { runsInServer: true, reachesInternet: true }),
      ])
    ).toBe('2 run code here · 2 can reach the internet: Writer, Social.');
  });
});

describe('a plugin group in Settings', () => {
  it('turns on or off only members already allowed, and never approves', async () => {
    serve([ext('writer'), ext('social', { approvedToRun: false })], []);
    render(<ExtensionsSettingsTab />, { wrapper });
    const row = await screen.findByTestId('extension-group-marketing-suite');

    // A waiting member makes the row ask for Review, never offer a switch.
    expect(within(row).getByText('2 extensions · 1 of 2 allowed')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Review Marketing suite' }));

    fireEvent.click(await within(row).findByRole('switch', { name: 'Writer: on' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/writer/disable'))).toBe(true));
    expect(calls.some((c) => /approve/.test(c.url))).toBe(false);
    expect(within(row).queryByRole('switch', { name: /Social/ })).not.toBeInTheDocument();
  });

  it('switches every allowed member off from the closed row', async () => {
    serve([ext('writer'), ext('social')], []);
    render(<ExtensionsSettingsTab />, { wrapper });
    const row = await screen.findByTestId('extension-group-marketing-suite');

    fireEvent.click(within(row).getByRole('switch', { name: 'Marketing suite: on' }));

    await waitFor(() =>
      expect(calls.filter((c) => /\/(writer|social)\/disable$/.test(c.url))).toHaveLength(2)
    );
  });
});

describe('the Allow all card', () => {
  const set: ExtensionApprovalSet = {
    plugin: 'marketing-suite',
    members: [
      member('cockpit', { state: 'allowed', echo: undefined }),
      member('social', { runsInServer: true }),
      member('writer', {
        runsInServer: true,
        reachesInternet: true,
        permissions: {
          runtime: 'subprocess',
          net: ['api.example.com'],
          run: [],
          agents: false,
          hasPage: true,
        },
      }),
    ],
    setHash: 'hash-1',
    tooMany: false,
  };
  const extensions = [
    ext('cockpit'),
    ext('social', { approvedToRun: false }),
    ext('writer', { approvedToRun: false }),
  ];

  it('says what the set may do, then lists each member with the allowed one dimmed', async () => {
    serve(extensions, [set]);
    render(<ExtensionsSettingsTab />, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: 'Review Marketing suite' }));
    const card = await screen.findByTestId('approval-set-marketing-suite');

    expect(
      within(card).getByText('Marketing suite wants to run 2 extensions on this computer.')
    ).toBeInTheDocument();
    expect(within(card).getByTestId('approval-set-summary-marketing-suite')).toHaveTextContent(
      '2 run code here · 1 can reach the internet: Writer.'
    );
    expect(within(card).getByTestId('approval-set-grant-marketing-suite')).toHaveTextContent(
      'Can reach api.example.com'
    );
    expect(within(card).getByTestId('approval-set-status-cockpit')).toHaveTextContent(
      'Already allowed'
    );
    expect(within(card).getByRole('button', { name: 'Allow all 2' })).toHaveFocus();

    // Each member's facts open from its own line.
    const writer = within(card).getByTestId('approval-set-member-writer');
    fireEvent.click(within(writer).getByRole('button'));
    expect(within(writer).getByText('Can reach api.example.com')).toBeInTheDocument();
  });

  it('echoes the set it showed, and on a partial answer says which were allowed', async () => {
    serve(extensions, [set], {
      allAllowed: false,
      results: [
        { id: 'social', name: 'Social', ok: true },
        { id: 'writer', name: 'Writer', ok: false, reason: 'Its files changed since you saw it.' },
      ],
    });
    render(<ExtensionsSettingsTab />, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: 'Review Marketing suite' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Allow all 2' }));

    const card = screen.getByTestId('approval-set-marketing-suite');
    await waitFor(() =>
      expect(within(card).getByTestId('approval-set-status-writer')).toHaveTextContent(
        'Not allowed: Its files changed since you saw it.'
      )
    );
    expect(within(card).getByTestId('approval-set-status-social')).toHaveTextContent('Allowed');
    expect(calls.find((c) => c.url.includes('/approve-set'))?.body).toEqual({
      plugin: 'marketing-suite',
      members: [set.members[1]!.echo, set.members[2]!.echo],
      setHash: 'hash-1',
    });
    expect(toast.success).not.toHaveBeenCalled();
  });
});
