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
  it('lists each standing yes, with Make it ask only where it can reach', async () => {
    const user = userEvent.setup();
    renderTab(transportWith());
    const sheet = await openSheet(user);
    expect(await sheet.findByText('Every tool, including new ones · in its project')).toBeVisible();
    expect(sheet.getByText('create_issue only · in its project')).toBeVisible();
    expect(
      sheet.getByRole('button', { name: 'Make Quill ask first: Every tool, including new ones' })
    ).toHaveTextContent('Make it ask');
    // Atlas's rule is in the shared settings.json, which Make it ask never writes, and says so.
    expect(sheet.queryByRole('button', { name: /Atlas/ })).toBeNull();
    const atlasRow = sheet.getByText('Atlas').closest('li')!;
    expect(within(atlasRow).getByText('Set in settings.json')).toBeVisible();
    expect(sheet.getByText('These may not apply to untrusted folders.')).toBeVisible();
    expect(sheet.queryByText(/Everyone else asks first/)).toBeNull();
  });

  it('says only "No one" when nobody has a standing yes', async () => {
    const user = userEvent.setup();
    renderTab(
      transportWith({ listGlobalMcpStandingAllows: vi.fn().mockResolvedValue({ allows: [] }) })
    );
    const sheet = await openSheet(user);
    expect(await sheet.findByText('No one. Every agent asks first.')).toBeVisible();
    expect(sheet.queryByText(/untrusted folders/)).toBeNull();
    expect(sheet.queryByText(/Everyone else asks first/)).toBeNull();
  });

  it('truncates nothing: the title, names and rules all wrap', async () => {
    const user = userEvent.setup();
    renderTab(transportWith());
    const sheet = await openSheet(user);
    await sheet.findByText('What it can do · 2 tools');
    expect(document.querySelector('[role="dialog"] .truncate')).toBeNull();
  });
});

describe('make it ask', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends one removal, says so in place for 4 seconds, then the line goes', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const undo = vi.fn().mockResolvedValue(undefined);
    const allows = vi
      .fn()
      .mockResolvedValueOnce({ allows: [QUILL_ALL] })
      .mockResolvedValue({ allows: [] });
    const check = vi.fn().mockResolvedValue(CHECKED);
    const transport = transportWith({
      undoGlobalMcpStandingAllow: undo,
      listGlobalMcpStandingAllows: allows,
      checkGlobalMcpServerTools: check,
    });
    renderTab(transport);
    const sheet = await openSheet(user);
    await sheet.findByText('What it can do · 2 tools');
    const checks = check.mock.calls.length;
    await user.click(await sheet.findByRole('button', { name: /^Make Quill ask first/ }));

    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledWith('tracker', 'agent-quill', 'mcp__tracker');
    const madeToAsk = () => document.querySelector('[data-slot="made-to-ask"]');
    await waitFor(() => expect(madeToAsk()).toHaveTextContent('Quill now asks first.'));
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
      'Quill now asks first.'
    );
    // The tools Quill used without asking no longer say so.
    expect(sheet.queryByText(/Used without asking by Quill/)).toBeNull();

    await vi.advanceTimersByTimeAsync(3900);
    expect(madeToAsk()).toHaveTextContent('Quill now asks first.');
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => expect(madeToAsk()).toBeNull());
    expect(await sheet.findByText('No one. Every agent asks first.')).toBeVisible();

    // A removal only: one DELETE, nothing added back, nothing retried or re-checked.
    expect(undo).toHaveBeenCalledTimes(1);
    expect(transport.addGlobalMcpServer).not.toHaveBeenCalled();
    expect(transport.patchGlobalMcpServer).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(checks);
  });

  it('names the agent under its own row when refused, from the server’s record', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // The server's words name nobody; the row's own record names Quill.
    const refused = Object.assign(
      new Error(
        "This agent's settings file isn't a plain file in its folder, so it was left alone."
      ),
      { code: 'not-a-real-file' }
    );
    const undo = vi.fn().mockRejectedValue(refused);
    renderTab(transportWith({ undoGlobalMcpStandingAllow: undo }));
    const sheet = await openSheet(user);
    await user.click(await sheet.findByRole('button', { name: /^Make Quill ask first/ }));

    const alert = await sheet.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Quill’s settings file isn’t a plain file in its folder, so it was left alone.'
    );
    const quillRow = sheet.getByText('Quill').closest('li')!;
    expect(within(quillRow).getByRole('alert')).toBe(alert);
    expect(undo).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(undo).toHaveBeenCalledTimes(1);
  });
});

describe('what it can do', () => {
  it('stacks each tool: name and New today, its description as plain text, then who uses it', async () => {
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
    expect(within(createRow).getByText('Used without asking by Quill, Atlas')).toBeVisible();
    const exportRow = sheet.getByText('export_all').closest('li')!;
    expect(within(exportRow).getByText('Used without asking by Quill')).toBeVisible();
    expect(sheet.queryByText('Asks first')).toBeNull();
  });

  it('a tool nobody uses without asking has no third line', async () => {
    const user = userEvent.setup();
    renderTab(
      transportWith({ listGlobalMcpStandingAllows: vi.fn().mockResolvedValue({ allows: [] }) })
    );
    const sheet = await openSheet(user);
    const createRow = (await sheet.findByText('create_issue', { selector: 'span' })).closest('li')!;
    expect(within(createRow).queryByText(/Used without asking/)).toBeNull();
    expect(within(createRow).queryByText('Asks first')).toBeNull();
  });

  it('says nothing about reading the server while it is not checked', async () => {
    const user = userEvent.setup();
    renderTab(
      transportWith({
        checkGlobalMcpServerTools: vi.fn().mockResolvedValue({ status: 'not-checked' }),
      })
    );
    const sheet = await openSheet(user);
    expect(await sheet.findByText('Not checked yet. It’s checked once it’s on.')).toBeVisible();
    expect(sheet.queryByText(/Read from the server when this opens/)).toBeNull();
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
