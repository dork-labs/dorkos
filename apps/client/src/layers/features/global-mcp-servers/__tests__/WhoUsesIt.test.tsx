/**
 * The server sheet's "Who uses it without asking" and "What it can do" (DOR-4118). Made-up
 * servers, agents and tools.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  GlobalMcpStandingAllow,
  GlobalMcpToolsCheck,
} from '@dorkos/shared/global-mcp-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockGlobalMcpServer, createMockTransport } from '@dorkos/test-utils';
import { createQueryClientConfig } from '@/layers/shared/lib/query-client';
import { TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider } from '@/layers/shared/model';
import { McpServersTab } from '../ui/McpServersTab';

const QUILL_ALL: GlobalMcpStandingAllow = {
  agentId: 'agent-quill',
  agentName: 'Quill',
  rule: 'mcp__tracker',
  breadth: 'server',
  file: 'settings.local.json',
};

const ATLAS_ONE: GlobalMcpStandingAllow = {
  agentId: 'agent-atlas',
  agentName: 'Atlas',
  rule: 'mcp__tracker__create_issue',
  breadth: 'tool',
  tool: 'create_issue',
  file: 'settings.json',
};

const CHECKED: GlobalMcpToolsCheck = {
  status: 'ok',
  tools: [
    { name: 'create_issue', description: 'Opens an issue.', isNew: false },
    { name: 'export_all', description: '<b>Exports</b> every issue.', isNew: true },
  ],
  added: ['export_all'],
  omitted: 0,
};

function transportWith(over: Partial<Transport> = {}): Transport {
  return createMockTransport({
    listGlobalMcpServers: vi
      .fn()
      .mockResolvedValue({ servers: [createMockGlobalMcpServer({ name: 'tracker' })] }),
    listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
    checkGlobalMcpServerTools: vi.fn().mockResolvedValue(CHECKED),
    listGlobalMcpStandingAllows: vi.fn().mockResolvedValue({ allows: [QUILL_ALL, ATLAS_ONE] }),
    ...over,
  });
}

function renderTab(transport: Transport, props: Parameters<typeof McpServersTab>[0] = {}) {
  const client = new QueryClient({
    ...createQueryClientConfig(),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = (next: Parameters<typeof McpServersTab>[0]) => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <McpServersTab {...next} />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(tree(props));
  return (next: Parameters<typeof McpServersTab>[0]) => rerender(tree(next));
}

async function openSheet(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /tracker/ }));
  return within(await screen.findByRole('dialog'));
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as never;
});
afterEach(cleanup);

describe('who uses it without asking', () => {
  it('lists each standing yes, with Undo only where Undo can reach', async () => {
    const user = userEvent.setup();
    renderTab(transportWith());
    const sheet = await openSheet(user);
    expect(await sheet.findByText('Every tool, including new ones · in its project')).toBeVisible();
    expect(sheet.getByText('create_issue only · in its project')).toBeVisible();
    expect(
      sheet.getByRole('button', { name: 'Undo Every tool, including new ones for Quill' })
    ).toBeVisible();
    // Atlas's rule is in the shared settings.json, which Undo never writes.
    expect(sheet.queryByRole('button', { name: /for Atlas/ })).toBeNull();
    expect(
      sheet.getByText('Everyone else asks first. These may not apply to untrusted folders.')
    ).toBeVisible();
  });

  it('Undo sends the agent and the exact rule, and reads the list again', async () => {
    const user = userEvent.setup();
    const undo = vi.fn().mockResolvedValue(undefined);
    const allows = vi
      .fn()
      .mockResolvedValueOnce({ allows: [QUILL_ALL] })
      .mockResolvedValue({ allows: [] });
    renderTab(
      transportWith({ undoGlobalMcpStandingAllow: undo, listGlobalMcpStandingAllows: allows })
    );
    const sheet = await openSheet(user);
    await user.click(await sheet.findByRole('button', { name: /^Undo .* for Quill$/ }));
    expect(undo).toHaveBeenCalledWith('tracker', 'agent-quill', 'mcp__tracker');
    expect(await sheet.findByText('No one. Every agent asks first.')).toBeVisible();
  });
});

describe('what it can do', () => {
  it('shows the tools as plain text, marks a new one, and names who uses each', async () => {
    const user = userEvent.setup();
    const check = vi.fn().mockResolvedValue(CHECKED);
    renderTab(transportWith({ checkGlobalMcpServerTools: check }));
    const sheet = await openSheet(user);
    expect(await sheet.findByText('What it can do · 2 tools')).toBeVisible();
    expect(check).toHaveBeenCalledWith('tracker');
    // The server's markup is text, never markup.
    expect(sheet.getByText('<b>Exports</b> every issue.')).toBeVisible();
    expect(document.querySelector('[role="dialog"] b')).toBeNull();
    expect(sheet.getByText('New today')).toBeVisible();
    const createRow = sheet.getByText('create_issue', { selector: 'span' }).closest('li')!;
    expect(within(createRow).getByText('Quill, Atlas')).toBeVisible();
    const exportRow = sheet.getByText('export_all').closest('li')!;
    expect(within(exportRow).getByText('Quill')).toBeVisible();
  });

  it.each([
    [{ status: 'not-checked' }, 'Not checked yet. It’s checked once it’s on.'],
    [{ status: 'needs-sign-in' }, 'Sign in to this server to see its tools.'],
    [{ status: 'unreachable', error: 'timed out' }, 'Couldn’t reach the server.'],
  ] as const)('says why there is no list: %j', async (answer, line) => {
    const user = userEvent.setup();
    renderTab(transportWith({ checkGlobalMcpServerTools: vi.fn().mockResolvedValue(answer) }));
    const sheet = await openSheet(user);
    expect(await sheet.findByText(line)).toBeVisible();
  });

  it('counts the tools the server listed past the caps', async () => {
    const user = userEvent.setup();
    renderTab(
      transportWith({
        checkGlobalMcpServerTools: vi.fn().mockResolvedValue({ ...CHECKED, omitted: 5 }),
      })
    );
    const sheet = await openSheet(user);
    expect(await sheet.findByText('What it can do · 7 tools')).toBeVisible();
    expect(sheet.getByText('5 more not shown.')).toBeVisible();
  });

  it('checks nothing until a sheet opens', async () => {
    const check = vi.fn().mockResolvedValue(CHECKED);
    renderTab(transportWith({ checkGlobalMcpServerTools: check }));
    await screen.findByRole('button', { name: /tracker/ });
    expect(check).not.toHaveBeenCalled();
  });
});

describe('a link to one server', () => {
  it('opens that server’s sheet, then lets the address drop it', async () => {
    const opened = vi.fn();
    renderTab(transportWith(), { openServer: 'tracker', onServerOpened: opened });
    expect(await screen.findByRole('dialog')).toBeVisible();
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('opens the sheet for a link that arrives while the list is already showing', async () => {
    const rerender = renderTab(transportWith());
    await screen.findByRole('button', { name: /tracker/ });
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender({ openServer: 'tracker', onServerOpened: vi.fn() });
    expect(await screen.findByRole('dialog')).toBeVisible();
  });

  it('opens nothing for a server that is gone, and still drops it', async () => {
    const opened = vi.fn();
    renderTab(transportWith(), { openServer: 'weather', onServerOpened: opened });
    await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
