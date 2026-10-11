/**
 * @vitest-environment jsdom
 */
/**
 * Chat, channel and DM links in markdown draw as a chip (DOR-2824).
 *
 * The integration cases render through the REAL `MarkdownContent`, so they
 * cover the whole path a reply takes: Streamdown, `MarkdownLink`, the slot the
 * app shell fills, and the tab identity behind the chip.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockSession, createMockTransport } from '@dorkos/test-utils';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import { LinkChipProvider, TransportProvider } from '@/layers/shared/model';
import { MarkdownContent } from '@/layers/shared/ui';
import { registerLinkNavigator, type LinkNavigation } from '@/layers/shared/lib';
import { setSessionRouteContext, useSessionListStore } from '@/layers/entities/session';

const agentByPath = vi.fn<(cwd: string | null) => AgentManifest | null>(() => null);
vi.mock('@/layers/entities/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/agent')>()),
  useCurrentAgent: (cwd: string | null) => ({ data: agentByPath(cwd) }),
}));

import { linkChipFace, linkChipKind } from '../lib/link-chip';
import { chatTabIdentity, roomTabIdentity } from '../lib/tab-identity';
import { parseTabHref } from '../lib/tab-target';
import { linkChipSlot } from '../ui/LinkChip';

const transport = createMockTransport();
const SCOUT = { id: 'scout', name: 'scout', displayName: 'Scout', icon: '🔍' } as AgentManifest;

function Providers({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <LinkChipProvider slot={linkChipSlot}>{children}</LinkChipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

function renderMarkdown(content: string) {
  return render(<MarkdownContent content={content} />, { wrapper: Providers });
}

/** A not-found error the way the transport throws one. */
function notFound(): Error {
  return Object.assign(new Error('Not found'), { status: 404 });
}

let navigated: LinkNavigation[];
let unregister: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  agentByPath.mockImplementation((cwd) => (cwd === '/Users/kai/api' ? SCOUT : null));
  useSessionListStore.setState({
    sessions: {},
    statuses: {},
    statusCwds: {},
    unseen: {},
    limits: {},
  });
  setSessionRouteContext('chat-1', { cwd: '/Users/kai/api', draft: false });
  vi.mocked(transport.getSession).mockResolvedValue(
    createMockSession({ id: 'chat-1', title: 'Fix the login bug', cwd: '/Users/kai/api' })
  );
  navigated = [];
  unregister = registerLinkNavigator((navigation) => navigated.push(navigation));
});

afterEach(() => {
  unregister();
  cleanup();
});

describe('linkChipKind', () => {
  it.each([
    ['/session?session=chat-1', 'chat'],
    ['/session?session=chat-1&message=m-2', 'chat'],
    ['/channels?id=room-1', 'room'],
    ['/channels?id=room-1&thread=e-1', 'room'],
    ['/session', null],
    ['/session?session=chat-1&draft=1', null],
    ['/channels', null],
    ['/channels?id=room-1&community=acme', null],
    ['/tasks', null],
    ['/team', null],
  ])('%s is %s', (href, kind) => {
    expect(linkChipKind(parseTabHref(href))).toBe(kind);
  });
});

describe('linkChipFace', () => {
  const chat = chatTabIdentity({
    agentName: 'Scout',
    visual: { emoji: '🔍' },
    chatTitle: 'Fix the login bug',
    agentKey: 'scout',
    signals: { working: true },
    detail: { activity: 'running tests' },
  });

  it('leads a chat with its title, and says the tab’s status', () => {
    expect(linkChipFace('chat', chat, 'ready')).toMatchObject({
      name: 'Fix the login bug',
      icon: { kind: 'emoji', emoji: '🔍' },
      status: 'working',
      sentence: 'Working: running tests',
      accessibleName: 'Fix the login bug, Scout, Working: running tests',
      missing: false,
    });
  });

  it('falls back to the agent when a chat has no title', () => {
    const untitled = chatTabIdentity({ agentName: 'Scout', visual: { emoji: '🔍' } });
    expect(linkChipFace('chat', untitled, 'ready').name).toBe('Scout');
  });

  it('keeps the link’s own words while it resolves', () => {
    expect(linkChipFace('chat', chat, 'resolving')).toEqual({ icon: chat.icon, missing: false });
  });

  it('says plainly when the chat or channel is gone, with no status', () => {
    const gone = linkChipFace('chat', chat, 'missing');
    expect(gone).toMatchObject({ name: 'Chat not found', missing: true });
    expect(gone.status).toBeUndefined();
    expect(gone.sentence).toBeUndefined();
    const room = roomTabIdentity({ kind: 'channel', title: '#general' });
    expect(linkChipFace('room', room, 'missing').name).toBe('Channel not found');
  });
});

describe('a chat link in markdown', () => {
  it('draws as a chip with the agent’s icon and the chat’s title', async () => {
    renderMarkdown('See [the fix](/session?session=chat-1)');

    const link = await screen.findByRole('link', { name: /^Fix the login bug, Scout/ });
    expect(link).toHaveAttribute('data-chip', 'ready');
    expect(link).toHaveAttribute('href', '/session?session=chat-1');
    expect(link).toHaveTextContent('🔍');
  });

  it('shows the link’s own words until the chat resolves', () => {
    vi.mocked(transport.getSession).mockReturnValue(new Promise(() => {}));
    renderMarkdown('See [the fix](/session?session=chat-1)');

    expect(screen.getByRole('link', { name: /the fix/ })).toHaveAttribute('data-chip', 'resolving');
  });

  it('wears the live status dot and says it in its name', async () => {
    useSessionListStore.setState({
      statuses: { 'chat-1': { lifecycle: 'streaming', limit: null } as SessionStatus },
    });
    renderMarkdown('See [the fix](/session?session=chat-1)');

    const link = await screen.findByRole('link', { name: /Fix the login bug, Scout, Working/ });
    expect(link.querySelector('[data-status="working"]')).not.toBeNull();
  });

  it('says "Chat not found" for a chat that is gone', async () => {
    vi.mocked(transport.getSession).mockRejectedValue(notFound());
    renderMarkdown('See [the old chat](/session?session=chat-1)');

    const link = await screen.findByRole('link', { name: 'Chat not found' });
    expect(link).toHaveAttribute('data-chip', 'missing');
  });

  it('keeps the link’s words when the chat cannot be read for another reason', async () => {
    vi.mocked(transport.getSession).mockRejectedValue(new Error('offline'));
    renderMarkdown('See [the fix](/session?session=chat-1)');

    await waitFor(() => expect(transport.getSession).toHaveBeenCalled());
    expect(screen.getByRole('link', { name: /the fix/ })).toHaveAttribute('data-chip', 'resolving');
  });

  it('opens the chat in place on one click, as before', async () => {
    renderMarkdown('See [the fix](/session?session=chat-1)');

    fireEvent.click(await screen.findByRole('link', { name: /^Fix the login bug/ }));

    expect(navigated).toEqual([{ href: '/session?session=chat-1', replace: undefined }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a chip wearing a status in place too, through its tooltip', async () => {
    useSessionListStore.setState({
      statuses: { 'chat-1': { lifecycle: 'streaming', limit: null } as SessionStatus },
    });
    renderMarkdown('See [the fix](/session?session=chat-1)');

    fireEvent.click(await screen.findByRole('link', { name: /Working/ }));

    expect(navigated).toEqual([{ href: '/session?session=chat-1', replace: undefined }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a new tab on cmd-click, with no confirm', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderMarkdown('See [the fix](/session?session=chat-1)');

    fireEvent.click(await screen.findByRole('link', { name: /^Fix the login bug/ }), {
      metaKey: true,
    });

    expect(navigated).toEqual([]);
    expect(openSpy).toHaveBeenCalledWith(
      `${window.location.origin}/session?session=chat-1`,
      '_blank'
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    openSpy.mockRestore();
  });

  it('keeps the same link, and its focus, when the chat starts working', async () => {
    renderMarkdown('See [the fix](/session?session=chat-1)');
    const link = await screen.findByRole('link', { name: /^Fix the login bug, Scout$/ });
    link.focus();

    act(() => {
      useSessionListStore.setState({
        statuses: { 'chat-1': { lifecycle: 'streaming', limit: null } as SessionStatus },
      });
    });

    expect(await screen.findByRole('link', { name: /Working/ })).toBe(link);
    expect(document.activeElement).toBe(link);
  });

  it.each([
    ['not yours to see', 403],
    ['an id that names nothing', 400],
  ])('says "Chat not found" for a chat that is %s', async (_why, status) => {
    vi.mocked(transport.getSession).mockRejectedValue(
      Object.assign(new Error('refused'), { status })
    );
    renderMarkdown('See [the old chat](/session?session=chat-1)');

    expect(await screen.findByRole('link', { name: 'Chat not found' })).toBeInTheDocument();
  });

  it('asks the server once for a chip, however many readers it has', async () => {
    renderMarkdown('See [the fix](/session?session=chat-1) and [again](/session?session=chat-1)');

    await screen.findAllByRole('link', { name: /^Fix the login bug/ });
    expect(transport.getSession).toHaveBeenCalledTimes(1);
  });

  it('does not call a chat still being drafted here "not found"', async () => {
    setSessionRouteContext('draft-1', { cwd: '/Users/kai/api', draft: true });
    renderMarkdown('See [the new chat](/session?session=draft-1)');

    const link = await screen.findByRole('link', { name: /^Scout/ });
    expect(link).toHaveAttribute('data-chip', 'ready');
    expect(transport.getSession).not.toHaveBeenCalled();
  });

  it('leaves a launch link plain, and it still asks first', () => {
    renderMarkdown('Try [this](/session?session=chat-1&prompt=hi&send=1)');

    const link = screen.getByRole('link', { name: 'this' });
    expect(link).not.toHaveAttribute('data-chip');
    fireEvent.click(link);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(navigated).toEqual([]);
  });

  it('leaves a link outside DorkOS plain', () => {
    renderMarkdown('Read [the docs](https://dorkos.ai/docs)');
    expect(screen.getByRole('link', { name: 'the docs' })).not.toHaveAttribute('data-chip');
  });
});

describe('a channel link in markdown', () => {
  it('draws as a chip named after the channel', async () => {
    vi.mocked(transport.getRoom).mockResolvedValue({
      id: 'room-1',
      kind: 'channel',
      slug: 'general',
      title: 'General',
    } as never);
    renderMarkdown('Posted in [the channel](/channels?id=room-1)');

    const link = await screen.findByRole('link', { name: /^#general/ });
    expect(link).toHaveAttribute('data-chip', 'ready');
  });

  it('says "Channel not found" for a room that is gone', async () => {
    vi.mocked(transport.getRoom).mockRejectedValue(notFound());
    renderMarkdown('Posted in [the channel](/channels?id=room-1)');

    expect(await screen.findByRole('link', { name: 'Channel not found' })).toHaveAttribute(
      'data-chip',
      'missing'
    );
  });
});
