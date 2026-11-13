/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { GlobalMcpServerView } from '@dorkos/shared/global-mcp-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockGlobalMcpServer, createMockTransport } from '@dorkos/test-utils';
import { createQueryClientConfig } from '@/layers/shared/lib/query-client';
import { TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider } from '@/layers/shared/model';
import { McpServersTab } from '../ui/McpServersTab';

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

const AGENTS = [
  { id: 'a', name: 'atlas', displayName: 'Atlas' },
  { id: 'b', name: 'scout', displayName: 'Scout' },
];

const refusal = (code: string, message = 'Refused.') => Object.assign(new Error(message), { code });

function transportWith(servers: GlobalMcpServerView[], over: Partial<Transport> = {}): Transport {
  return createMockTransport({
    listGlobalMcpServers: vi.fn().mockResolvedValue({ servers }),
    listMeshAgents: vi.fn().mockResolvedValue({ agents: AGENTS }),
    ...over,
  });
}

function renderTab(transport: Transport) {
  // The app's real caches, so what a refusal does and what the cache keeps are the app's own.
  const client = new QueryClient({
    ...createQueryClientConfig(),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <McpServersTab />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return client;
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as never;
});
afterEach(cleanup);

/** Fill the fields a command server needs. */
async function fillServer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add server' }));
  await user.type(screen.getByLabelText('Name'), 'made-up');
  await user.type(screen.getByLabelText('Command'), 'npx');
  await user.type(screen.getByLabelText('Arguments'), '-y made-up-mcp@1.2.3');
}

describe('the list', () => {
  it('says what to do when there are no servers', async () => {
    renderTab(transportWith([]));
    expect(
      await screen.findByText('No servers yet. Add one and every agent can use its tools.')
    ).toBeInTheDocument();
  });

  it('shows who gets each server and that it’s off', async () => {
    renderTab(
      transportWith([
        createMockGlobalMcpServer({ name: 'one' }),
        createMockGlobalMcpServer({ name: 'two', excludedAgents: ['a'] }),
        createMockGlobalMcpServer({ name: 'three', enabled: false }),
      ])
    );
    const row = async (name: string) => within(await screen.findByTestId(`mcp-server-row-${name}`));
    expect((await row('one')).getByText('All agents')).toBeInTheDocument();
    await waitFor(async () =>
      expect((await row('two')).getByText('All agents except Atlas')).toBeInTheDocument()
    );
    expect((await row('three')).getByText(/Off/)).toBeInTheDocument();
  });

  it('puts warnings in warning ink, the first reason plus how many more', async () => {
    renderTab(
      transportWith([
        createMockGlobalMcpServer({
          warnings: [
            { name: 'made-up-server', note: 'Not started. Made-up reason.' },
            { name: 'LD_PRELOAD', note: 'One.' },
            { name: 'NODE_OPTIONS', note: 'Two.' },
          ],
        }),
      ])
    );
    const line = await screen.findByText(/Not started\. Made-up reason\. \+2 more/);
    expect(line).toHaveClass('text-status-warning-fg');
  });

  it('names what an SSE server can’t reach, and never a tool count or a version', async () => {
    renderTab(transportWith([createMockGlobalMcpServer({ skippedOn: ['codex', 'opencode'] })]));
    expect(await screen.findByText('Not available to Codex or OpenCode agents')).toHaveClass(
      'text-status-warning-fg'
    );
    expect(screen.queryByText(/tools?\b/)).toBeNull();
    expect(screen.queryByText(/1\.2\.3/)).toBeNull();
  });

  it('a switch that was cancelled stays where it was and says nothing changed', async () => {
    const user = userEvent.setup();
    renderTab(
      transportWith([createMockGlobalMcpServer({ enabled: false })], {
        patchGlobalMcpServer: vi.fn().mockRejectedValue(refusal('step_up_required')),
      })
    );
    const toggle = await screen.findByRole('switch');
    await user.click(toggle);
    expect(await screen.findByText(/Not confirmed\. Nothing changed\./)).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
  });

  it('an off server dims its name and "Off", never its warning', async () => {
    renderTab(
      transportWith([
        createMockGlobalMcpServer({
          enabled: false,
          warnings: [{ name: 'NODE_OPTIONS', note: 'Made-up warning.' }],
        }),
      ])
    );
    const row = within(await screen.findByTestId('mcp-server-row-made-up-server'));
    expect(row.getByText('made-up-server')).toHaveClass('opacity-55');
    expect(row.getByText(/^Off/)).toHaveClass('opacity-55');
    const warning = row.getByText(/Made-up warning/);
    expect(warning).toHaveClass('text-status-warning-fg');
    for (let el: HTMLElement | null = warning; el; el = el.parentElement) {
      expect(el.className).not.toMatch(/(^|\s)opacity-/);
    }
  });

  it('only a line with nothing to warn about may cut off', async () => {
    renderTab(
      transportWith([
        createMockGlobalMcpServer({ name: 'plain' }),
        createMockGlobalMcpServer({
          name: 'warned',
          warnings: [{ name: 'NODE_OPTIONS', note: 'Made-up warning.' }],
        }),
        createMockGlobalMcpServer({ name: 'skipped', skippedOn: ['codex'] }),
      ])
    );
    const line = (name: string, words: RegExp) =>
      within(screen.getByTestId(`mcp-server-row-${name}`)).getByText(words);
    await screen.findByTestId('mcp-server-row-plain');
    expect(line('plain', /^All agents$/)).toHaveClass('line-clamp-2');
    expect(line('warned', /Made-up warning/).parentElement).not.toHaveClass('line-clamp-2');
    expect(line('skipped', /Not available/).parentElement).not.toHaveClass('line-clamp-2');
  });

  it('a cancel lifts the cut-off, and clearing the notice puts it back', async () => {
    const user = userEvent.setup();
    renderTab(
      transportWith([createMockGlobalMcpServer({ enabled: false })], {
        patchGlobalMcpServer: vi.fn().mockRejectedValue(refusal('step_up_required')),
      })
    );
    const row = await screen.findByTestId('mcp-server-row-made-up-server');
    await user.click(within(row).getByRole('switch'));
    const notice = await within(row).findByText(/Not confirmed\. Nothing changed\./);
    expect(notice.parentElement).not.toHaveClass('line-clamp-2');
    await user.click(within(row).getByRole('button', { name: /made-up-server/ }));
    await waitFor(() => expect(within(row).getByText(/All agents/)).toHaveClass('line-clamp-2'));
  });

  it('a cancel goes in front of the row’s line, and opening the sheet clears it', async () => {
    const user = userEvent.setup();
    renderTab(
      transportWith(
        [
          createMockGlobalMcpServer({
            enabled: false,
            warnings: [{ name: 'NODE_OPTIONS', note: 'Made-up warning.' }],
          }),
        ],
        { patchGlobalMcpServer: vi.fn().mockRejectedValue(refusal('step_up_required')) }
      )
    );
    const row = await screen.findByTestId('mcp-server-row-made-up-server');
    await user.click(within(row).getByRole('switch'));
    await within(row).findByText(/Not confirmed\. Nothing changed\./);
    expect(row).toHaveTextContent(
      'Not confirmed. Nothing changed. · Off · Made-up warning. · All agents'
    );
    await user.click(within(row).getByRole('button', { name: /made-up-server/ }));
    await waitFor(() => expect(row).not.toHaveTextContent('Not confirmed'));
  });

  it('a server’s refusal is said in its own words', async () => {
    const user = userEvent.setup();
    renderTab(
      transportWith([createMockGlobalMcpServer()], {
        patchGlobalMcpServer: vi.fn().mockRejectedValue(refusal('changed', 'It changed.')),
      })
    );
    await user.click(await screen.findByRole('switch'));
    expect(await screen.findByRole('alert')).toHaveTextContent('It changed.');
  });
});

describe('adding a server', () => {
  it('sends it on, secrets and all, and closes once it’s added', async () => {
    const user = userEvent.setup();
    const addGlobalMcpServer = vi.fn().mockResolvedValue(createMockGlobalMcpServer());
    renderTab(transportWith([], { addGlobalMcpServer }));
    await fillServer(user);
    await user.click(screen.getByRole('button', { name: 'Add a variable' }));
    await user.type(screen.getByLabelText('Name of variable 1'), 'MADE_UP_TOKEN');
    await user.type(screen.getByLabelText('Value of MADE_UP_TOKEN'), 'typed-value');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByText('Add a server')).toBeNull());
    expect(addGlobalMcpServer).toHaveBeenCalledWith({
      name: 'made-up',
      enabled: true,
      excludedAgents: [],
      secretNames: [],
      connection: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'made-up-mcp@1.2.3'],
        env: { MADE_UP_TOKEN: 'typed-value' },
      },
    });
  });

  it('says on leaving Name that one of DorkOS’s own names is taken, and Add sends nothing (DOR-3600)', async () => {
    const user = userEvent.setup();
    const addGlobalMcpServer = vi.fn();
    renderTab(transportWith([], { addGlobalMcpServer }));
    await user.click(await screen.findByRole('button', { name: 'Add server' }));
    const name = screen.getByLabelText('Name');
    await user.type(name, 'DorkOS');
    await user.tab();
    const said = "DorkOS is one of DorkOS's own names. Pick another.";
    expect(screen.getByRole('alert')).toHaveTextContent(said);
    expect(name).toHaveAttribute('aria-invalid', 'true');

    await user.type(screen.getByLabelText('Command'), 'npx');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent(said);
    expect(addGlobalMcpServer).not.toHaveBeenCalled();

    // A fixed name clears the line as soon as the field is left.
    await user.clear(name);
    await user.type(name, 'made-up');
    await user.tab();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a cancel adds nothing, stays open and keeps what was typed', async () => {
    const user = userEvent.setup();
    renderTab(
      transportWith([], {
        addGlobalMcpServer: vi.fn().mockRejectedValue(refusal('step_up_required')),
      })
    );
    await fillServer(user);
    await user.click(screen.getByRole('button', { name: 'Add a variable' }));
    await user.type(screen.getByLabelText('Name of variable 1'), 'MADE_UP_TOKEN');
    await user.type(screen.getByLabelText('Value of MADE_UP_TOKEN'), 'typed-value');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Not confirmed. Nothing changed.')).toBeInTheDocument();
    expect(screen.getByLabelText('Value of MADE_UP_TOKEN')).toHaveValue('typed-value');
    expect(screen.getByLabelText('Name')).toHaveValue('made-up');
  });

  it('asks for what’s missing and sends nothing', async () => {
    const user = userEvent.setup();
    const addGlobalMcpServer = vi.fn();
    renderTab(transportWith([], { addGlobalMcpServer }));
    await user.click(await screen.findByRole('button', { name: 'Add server' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Name it with letters');
    expect(addGlobalMcpServer).not.toHaveBeenCalled();
  });

  it('URL is the whole choice: no way to pick another transport', async () => {
    const user = userEvent.setup();
    const addGlobalMcpServer = vi.fn().mockResolvedValue(createMockGlobalMcpServer());
    renderTab(transportWith([], { addGlobalMcpServer }));
    await user.click(await screen.findByRole('button', { name: 'Add server' }));
    await user.type(screen.getByLabelText('Name'), 'remote');
    await user.click(screen.getByRole('radio', { name: 'URL' }));
    expect(screen.queryByRole('radio', { name: /sse/i })).toBeNull();
    await user.type(screen.getByLabelText('URL'), 'https://mcp.example.test/v1');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(addGlobalMcpServer).toHaveBeenCalled());
    expect(addGlobalMcpServer.mock.calls[0]![0].connection).toEqual({
      transport: 'http',
      url: 'https://mcp.example.test/v1',
      headers: {},
    });
  });

  it('the agents it skips go with it', async () => {
    const user = userEvent.setup();
    const addGlobalMcpServer = vi.fn().mockResolvedValue(createMockGlobalMcpServer());
    renderTab(transportWith([], { addGlobalMcpServer }));
    await fillServer(user);
    await user.click(screen.getByRole('radio', { name: 'All except…' }));
    await user.click(await screen.findByRole('switch', { name: 'Atlas' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(addGlobalMcpServer).toHaveBeenCalled());
    expect(addGlobalMcpServer.mock.calls[0]![0].excludedAgents).toEqual(['a']);
  });
});

describe('the warning on Arguments', () => {
  const WORDS = 'This looks like a secret. Use a hidden field if the server allows.';

  it('asks the server on leaving the field, warns in warning ink, and Add stays on', async () => {
    const user = userEvent.setup();
    const checkGlobalMcpArgs = vi.fn().mockResolvedValue({ looksSecret: true });
    renderTab(transportWith([], { checkGlobalMcpArgs }));
    await user.click(await screen.findByRole('button', { name: 'Add server' }));
    const args = screen.getByLabelText('Arguments');
    await user.type(args, '--flag "a b"');
    expect(checkGlobalMcpArgs).not.toHaveBeenCalled();
    await user.tab();
    expect(checkGlobalMcpArgs).toHaveBeenCalledWith(['--flag', 'a b']);
    const line = await screen.findByText(WORDS);
    expect(line).toHaveClass('text-status-warning-fg');
    expect(args).toHaveAccessibleDescription(WORDS);
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('goes away when the next check says it’s fine, or the field is empty', async () => {
    const user = userEvent.setup();
    const checkGlobalMcpArgs = vi
      .fn()
      .mockResolvedValueOnce({ looksSecret: true })
      .mockResolvedValueOnce({ looksSecret: false })
      .mockResolvedValueOnce({ looksSecret: true });
    renderTab(transportWith([], { checkGlobalMcpArgs }));
    await user.click(await screen.findByRole('button', { name: 'Add server' }));
    const args = screen.getByLabelText('Arguments');
    await user.type(args, 'first');
    await user.tab();
    await screen.findByText(WORDS);
    await user.type(args, 'second');
    await user.tab();
    await waitFor(() => expect(screen.queryByText(WORDS)).toBeNull());
    await user.type(args, 'third');
    await user.tab();
    await screen.findByText(WORDS);
    await user.clear(args);
    await user.tab();
    await waitFor(() => expect(screen.queryByText(WORDS)).toBeNull());
    expect(checkGlobalMcpArgs).toHaveBeenCalledTimes(3);
  });

  it('a failed check says nothing, and doesn’t get in the way', async () => {
    const user = userEvent.setup();
    const checkGlobalMcpArgs = vi.fn().mockRejectedValue(new Error('made-up failure'));
    renderTab(transportWith([], { checkGlobalMcpArgs }));
    await user.click(await screen.findByRole('button', { name: 'Add server' }));
    await user.type(screen.getByLabelText('Arguments'), 'first');
    await user.tab();
    await waitFor(() => expect(checkGlobalMcpArgs).toHaveBeenCalled());
    expect(screen.queryByText(WORDS)).toBeNull();
    expect(screen.queryByText('made-up failure')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('the cache keeps none of what was checked', async () => {
    const user = userEvent.setup();
    const client = renderTab(
      transportWith([], { checkGlobalMcpArgs: vi.fn().mockResolvedValue({ looksSecret: true }) })
    );
    await user.click(await screen.findByRole('button', { name: 'Add server' }));
    await user.type(screen.getByLabelText('Arguments'), '--token=made-up-canary');
    await user.tab();
    await screen.findByText(WORDS);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Add a server')).toBeNull());
    await waitFor(() =>
      expect(
        JSON.stringify(
          client
            .getMutationCache()
            .getAll()
            .map((m) => m.state)
        )
      ).not.toContain('made-up-canary')
    );
  });
});

describe('what a typed secret leaves behind', () => {
  /** Everything the mutation cache holds, as text. */
  const cached = (client: QueryClient) =>
    JSON.stringify(
      client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.variables)
    );

  /** Fill the form with one secret, ready for Add. */
  async function fillSecret(user: ReturnType<typeof userEvent.setup>) {
    await fillServer(user);
    await user.click(screen.getByRole('button', { name: 'Add a variable' }));
    await user.type(screen.getByLabelText('Name of variable 1'), 'MADE_UP_TOKEN');
    await user.type(screen.getByLabelText('Value of MADE_UP_TOKEN'), 'canary-typed');
  }

  afterEach(() => onlineManager.setOnline(true));

  it('a browser that says offline still sends, so nothing waits in the cache to be saved', async () => {
    const user = userEvent.setup();
    const addGlobalMcpServer = vi.fn().mockResolvedValue(createMockGlobalMcpServer());
    const client = renderTab(transportWith([], { addGlobalMcpServer }));
    await fillSecret(user);
    onlineManager.setOnline(false);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(addGlobalMcpServer).toHaveBeenCalled());
    expect(
      client
        .getMutationCache()
        .getAll()
        .some((m) => m.state.isPaused)
    ).toBe(false);
  });

  it('every press and the cache let go of it once the form closes', async () => {
    const user = userEvent.setup();
    const client = renderTab(
      transportWith([], {
        addGlobalMcpServer: vi.fn().mockRejectedValue(refusal('step_up_required')),
      })
    );
    await fillSecret(user);
    const add = screen.getByRole('button', { name: 'Add' });
    await user.click(add);
    await screen.findByText('Not confirmed. Nothing changed.');
    await user.click(add);
    await waitFor(() => expect(add).toBeEnabled());
    // Only the press still showing its outcome, never one copy per press. A check of the arguments
    // is its own mutation, and goes when the form does.
    const presses = () =>
      client
        .getMutationCache()
        .getAll()
        .filter((mutation) => !Array.isArray(mutation.state.variables));
    await waitFor(() => expect(presses().length).toBeLessThanOrEqual(1));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Add a server')).toBeNull());
    await waitFor(() => expect(cached(client)).not.toContain('canary-typed'));
    expect(client.getMutationCache().getAll()).toEqual([]);
  });

  it('asks the browser not to save it as a password', async () => {
    const user = userEvent.setup();
    renderTab(transportWith([]));
    await fillSecret(user);
    expect(screen.getByLabelText('Value of MADE_UP_TOKEN')).toHaveAttribute(
      'autocomplete',
      'new-password'
    );
  });

  it('a refusal shows in the form, with no toast carrying its words', async () => {
    const user = userEvent.setup();
    const error = vi.spyOn(toast, 'error');
    renderTab(
      transportWith([], {
        addGlobalMcpServer: vi.fn().mockRejectedValue(refusal('unsafe_command', 'Not allowed.')),
      })
    );
    await fillSecret(user);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not allowed.');
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('the Hide this value lock', () => {
  /** Open the form with one row named `name`. */
  async function oneRow(user: ReturnType<typeof userEvent.setup>, name: string) {
    await fillServer(user);
    await user.click(screen.getByRole('button', { name: 'Add a variable' }));
    await user.type(screen.getByLabelText('Name of variable 1'), name);
    return screen.getByRole('button', { name: 'Hide this value' });
  }

  it('a name matching the secret rule is on and can’t be turned off', async () => {
    const user = userEvent.setup();
    const addGlobalMcpServer = vi.fn().mockResolvedValue(createMockGlobalMcpServer());
    renderTab(transportWith([], { addGlobalMcpServer }));
    const lock = await oneRow(user, 'MADE_UP_TOKEN');
    expect(lock).toHaveAttribute('aria-pressed', 'true');
    expect(lock).toHaveAttribute('aria-disabled', 'true');
    await user.click(lock);
    expect(lock).toHaveAttribute('aria-pressed', 'true');
    const field = screen.getByLabelText('Value of MADE_UP_TOKEN');
    expect(field).toHaveAttribute('type', 'password');
    await user.type(field, 'typed-value');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(addGlobalMcpServer).toHaveBeenCalled());
    expect(addGlobalMcpServer.mock.calls[0]![0].secretNames).toEqual([]);
  });

  it('any other name starts open, and locking it hides the value and marks it', async () => {
    const user = userEvent.setup();
    const addGlobalMcpServer = vi.fn().mockResolvedValue(createMockGlobalMcpServer());
    renderTab(transportWith([], { addGlobalMcpServer }));
    const lock = await oneRow(user, 'MADE_UP_SETTING');
    expect(lock).toHaveAttribute('aria-pressed', 'false');
    expect(lock).not.toHaveAttribute('aria-disabled');
    expect(screen.getByLabelText('Value of MADE_UP_SETTING')).not.toHaveAttribute(
      'type',
      'password'
    );
    await user.click(lock);
    expect(lock).toHaveAttribute('aria-pressed', 'true');
    const field = screen.getByLabelText('Value of MADE_UP_SETTING');
    expect(field).toHaveAttribute('type', 'password');
    await user.type(field, 'typed-value');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(addGlobalMcpServer).toHaveBeenCalled());
    expect(addGlobalMcpServer.mock.calls[0]![0].secretNames).toEqual(['MADE_UP_SETTING']);
  });
});

describe('the server sheet', () => {
  /** Open the sheet for the only server. */
  async function openSheet(user: ReturnType<typeof userEvent.setup>, name = 'made-up-server') {
    await user.click(await screen.findByRole('button', { name: new RegExp(name) }));
    return within(await screen.findByRole('dialog'));
  }

  it('shows what runs with secrets masked, and offers no Edit', async () => {
    const user = userEvent.setup();
    renderTab(
      transportWith([
        createMockGlobalMcpServer({
          env: [
            { name: 'MADE_UP_KEY', secret: true },
            { name: 'REGION', secret: false },
          ],
        }),
      ])
    );
    const sheet = await openSheet(user);
    expect(sheet.getByText('npx')).toBeInTheDocument();
    expect(sheet.getByText('-y made-up-mcp@1.2.3')).toBeInTheDocument();
    expect(sheet.getByText('MADE_UP_KEY=••••••••')).toBeInTheDocument();
    // Dots only mean a held-back secret, and only a secret wears the lock.
    const region = sheet.getByText('REGION');
    expect(region.parentElement!.querySelector('svg')).toBeNull();
    const key = sheet.getByText('MADE_UP_KEY=••••••••');
    expect(key.parentElement!.querySelector('svg')).not.toBeNull();
    expect(sheet.queryByRole('button', { name: /edit/i })).toBeNull();
  });

  it('keeps the not-pinned line, only for a package that isn’t pinned', async () => {
    const user = userEvent.setup();
    renderTab(transportWith([createMockGlobalMcpServer({ args: ['-y', 'made-up-mcp'] })]));
    const sheet = await openSheet(user);
    expect(
      sheet.getByText('Not pinned to a version. What runs can change later.')
    ).toBeInTheDocument();
  });

  it('flags a secret header on a plain address, and shows another transport', async () => {
    const user = userEvent.setup();
    renderTab(
      transportWith([
        createMockGlobalMcpServer({
          transport: 'sse',
          command: undefined,
          args: undefined,
          url: 'http://mcp.example.test/sse',
          headers: [{ name: 'Authorization', secret: true }],
        }),
      ])
    );
    const sheet = await openSheet(user);
    expect(sheet.getByText('SSE')).toBeInTheDocument();
    expect(sheet.getByText(/This address isn’t encrypted, so/)).toHaveTextContent(
      'This address isn’t encrypted, so Authorization travels in the clear.'
    );
  });

  it('a switch applies as it’s pressed, sending the whole list, and Done sends nothing', async () => {
    const user = userEvent.setup();
    const patchGlobalMcpServer = vi.fn().mockResolvedValue(createMockGlobalMcpServer());
    renderTab(
      transportWith([createMockGlobalMcpServer({ excludedAgents: ['a', 'gone-id'] })], {
        patchGlobalMcpServer,
      })
    );
    const sheet = await openSheet(user);
    await user.click(await sheet.findByRole('switch', { name: 'Scout' }));
    await waitFor(() =>
      expect(patchGlobalMcpServer).toHaveBeenCalledWith('made-up-server', {
        excludedAgents: ['a', 'gone-id', 'b'],
      })
    );
    patchGlobalMcpServer.mockClear();
    await user.click(sheet.getByRole('button', { name: 'Done' }));
    expect(patchGlobalMcpServer).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('All agents keeps All except… showing until the server says so', async () => {
    const user = userEvent.setup();
    const patchGlobalMcpServer = vi.fn().mockRejectedValue(refusal('step_up_required'));
    renderTab(
      transportWith([createMockGlobalMcpServer({ excludedAgents: ['a'] })], {
        patchGlobalMcpServer,
      })
    );
    const sheet = await openSheet(user);
    await user.click(sheet.getByRole('radio', { name: 'All agents' }));
    await waitFor(() =>
      expect(patchGlobalMcpServer).toHaveBeenCalledWith('made-up-server', { excludedAgents: [] })
    );
    expect(await sheet.findByText('Not confirmed. Nothing changed.')).toBeInTheDocument();
    expect(sheet.getByRole('radio', { name: 'All except…' })).toBeChecked();
    expect(sheet.getByRole('switch', { name: 'Atlas' })).not.toBeChecked();
  });
});

describe('what a person is told about a saved value', () => {
  const HINT = 'It won’t show here again. Agents that get this server can use it.';
  const SHEET_HINT =
    'Hidden values won’t show here again. Agents that get this server can use them.';

  it('the server sheet says it for a server with a hidden value, and not otherwise', async () => {
    const user = userEvent.setup();
    renderTab(
      transportWith([createMockGlobalMcpServer({ env: [{ name: 'A_KEY', secret: true }] })])
    );
    await user.click(await screen.findByRole('button', { name: /made-up-server/ }));
    expect(await screen.findByText(SHEET_HINT)).toBeInTheDocument();
    cleanup();
    renderTab(transportWith([createMockGlobalMcpServer()]));
    await user.click(await screen.findByRole('button', { name: /made-up-server/ }));
    await screen.findByRole('dialog');
    expect(screen.queryByText(SHEET_HINT)).toBeNull();
  });

  it('Add says it once a row is hidden', async () => {
    const user = userEvent.setup();
    renderTab(transportWith([]));
    await user.click(await screen.findByRole('button', { name: 'Add server' }));
    expect(screen.queryByText(HINT)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add a variable' }));
    await user.type(screen.getByLabelText('Name of variable 1'), 'MADE_UP_TOKEN');
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it('the page says a change reaches new chats, whatever is listed', async () => {
    renderTab(transportWith([]));
    expect(
      await screen.findByText('Changes reach every chat on its next message.')
    ).toBeInTheDocument();
  });
});

describe('removing a server', () => {
  /** Get to the Remove question. */
  async function askToRemove(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: /made-up-server/ }));
    await user.click(await screen.findByRole('button', { name: 'Remove server' }));
    return within(await screen.findByRole('alertdialog'));
  }

  it('starts on Cancel, and a server with no secret says only the first line', async () => {
    const user = userEvent.setup();
    renderTab(transportWith([createMockGlobalMcpServer()]));
    const ask = await askToRemove(user);
    expect(ask.getByRole('heading')).toHaveTextContent('Remove made-up-server?');
    expect(ask.getByText('Changes reach every chat on its next message.')).toBeInTheDocument();
    expect(ask.queryByText(/Its key/)).toBeNull();
    expect(ask.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('says what happens to one saved key, and to several', async () => {
    const user = userEvent.setup();
    renderTab(
      transportWith([createMockGlobalMcpServer({ env: [{ name: 'A_KEY', secret: true }] })])
    );
    const one = await askToRemove(user);
    expect(
      one.getByText('Its key is deleted here. If it may have leaked, revoke it at the service.')
    ).toBeInTheDocument();
    cleanup();
    renderTab(
      transportWith([
        createMockGlobalMcpServer({
          env: [
            { name: 'A_KEY', secret: true },
            { name: 'B_KEY', secret: true },
          ],
        }),
      ])
    );
    const several = await askToRemove(user);
    expect(
      several.getByText(
        'Its keys are deleted here. If they may have leaked, revoke them at the service.'
      )
    ).toBeInTheDocument();
  });

  it('removes on press and closes', async () => {
    const user = userEvent.setup();
    const removeGlobalMcpServer = vi.fn().mockResolvedValue(undefined);
    renderTab(transportWith([createMockGlobalMcpServer()], { removeGlobalMcpServer }));
    const ask = await askToRemove(user);
    await user.click(ask.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(removeGlobalMcpServer).toHaveBeenCalledWith('made-up-server'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('a key that stayed is said plainly, with no Try again, until dismissed', async () => {
    const user = userEvent.setup();
    renderTab(
      transportWith([createMockGlobalMcpServer({ env: [{ name: 'A_KEY', secret: true }] })], {
        removeGlobalMcpServer: vi.fn().mockRejectedValue(refusal('secret_left')),
      })
    );
    const ask = await askToRemove(user);
    await user.click(ask.getByRole('button', { name: 'Remove' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('made-up-server is removed');
    expect(alert).toHaveTextContent(
      'Its key wasn’t deleted from this computer. If in doubt, revoke it at the service.'
    );
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('any other refusal stays on the question, in the server’s words', async () => {
    const user = userEvent.setup();
    renderTab(
      transportWith([createMockGlobalMcpServer()], {
        removeGlobalMcpServer: vi.fn().mockRejectedValue(refusal('unreadable', 'Nothing changed.')),
      })
    );
    const ask = await askToRemove(user);
    await user.click(ask.getByRole('button', { name: 'Remove' }));
    expect(await ask.findByRole('alert')).toHaveTextContent('Nothing changed.');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});

describe('a server whose name is reserved (DOR-4262)', () => {
  const RESERVED = createMockGlobalMcpServer({
    name: 'DorkOS_Connections',
    args: ['-y', 'made-up-mcp@1.2.3', '--workspace', 'Design team'],
    env: [
      { name: 'MADE_UP_KEY', secret: true },
      { name: 'REGION', secret: false },
    ],
    excludedAgents: ['b'],
    reservedName: true,
  });

  /** The transport for one reserved server, its check and its standing yeses. */
  function reservedTransport(over: Partial<Transport> = {}) {
    return transportWith([RESERVED], {
      checkGlobalMcpServerTools: vi.fn().mockResolvedValue({
        status: 'reserved-name',
        tools: [{ name: 'search_pages', description: 'Find pages.', isNew: false }],
        added: [],
        omitted: 0,
      }),
      listGlobalMcpStandingAllows: vi.fn().mockResolvedValue({ allows: [] }),
      ...over,
    });
  }

  async function openSheet(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: /DorkOS_Connections/ }));
    return within(await screen.findByRole('dialog'));
  }

  it('the row says agents can’t use it, in warning ink, and only for that server', async () => {
    renderTab(transportWith([RESERVED, createMockGlobalMcpServer({ name: 'notion-demo' })]));
    const line = await screen.findByText(/Agents can’t use it · its name is reserved/);
    expect(line).toHaveClass('text-status-warning-fg');
    const other = within(await screen.findByTestId('mcp-server-row-notion-demo'));
    expect(other.queryByText(/its name is reserved/)).toBeNull();
  });

  it('the row’s name wraps and it says no “All agents”, which would contradict it', async () => {
    renderTab(transportWith([RESERVED, createMockGlobalMcpServer({ name: 'notion-demo' })]));
    const row = await screen.findByTestId('mcp-server-row-DorkOS_Connections');
    const name = within(row).getByText(
      (_, element) => element?.textContent === 'DorkOS_Connections' && element.tagName === 'SPAN'
    );
    expect(name).not.toHaveClass('truncate');
    // It may break after the underscore, not mid-word.
    expect(name.innerHTML).toBe('DorkOS_<wbr>Connections');
    expect(row).not.toHaveTextContent(/All agents/);
    expect(row).not.toHaveTextContent(/reserved ·/);
    // An ordinary row still cuts its name and says who gets it.
    const other = await screen.findByTestId('mcp-server-row-notion-demo');
    expect(within(other).getByText('notion-demo')).toHaveClass('truncate');
    expect(other).toHaveTextContent('All agents');
  });

  it('the sheet says why first, above the command, and the check is never ok', async () => {
    const user = userEvent.setup();
    renderTab(reservedTransport());
    const sheet = await openSheet(user);
    const first = sheet.getByText('Agents can’t use this server.');
    expect(first).toHaveClass('font-semibold');
    const notice = first.parentElement!;
    expect(notice).toHaveAttribute('data-slot', 'reserved-name-notice');
    expect(
      within(notice).getByText(
        '“DorkOS_Connections” is reserved for DorkOS’s own tools, so agents don’t get its tools.'
      )
    ).toBeInTheDocument();
    expect(within(notice).getByText('Rename it to give them back.')).toBeInTheDocument();
    // First in the sheet: above the Command block, so a phone shows it without scrolling.
    const command = sheet.getByText('Command');
    expect(notice.compareDocumentPosition(command) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      await sheet.findByText('It works, but agents can’t use it until it’s renamed.')
    ).toBeInTheDocument();
    expect(sheet.getByText('search_pages')).toBeInTheDocument();
    expect(sheet.getByText('What it can do · 1 tools')).toBeInTheDocument();
  });

  it('a server not reserved shows no notice (Security: nothing offers a way past the block)', async () => {
    const user = userEvent.setup();
    renderTab(transportWith([createMockGlobalMcpServer()]));
    await user.click(await screen.findByRole('button', { name: /made-up-server/ }));
    const sheet = within(await screen.findByRole('dialog'));
    expect(sheet.queryByText('Agents can’t use this server.')).toBeNull();
    expect(sheet.queryByRole('button', { name: 'Remove and add again…' })).toBeNull();
  });

  it('a reserved row’s name breaks after _ and -, and stays plain text (Security)', async () => {
    const hostile = 'a_b-<img src=x onerror=alert(1)>_[link](https://x.test)';
    renderTab(transportWith([createMockGlobalMcpServer({ name: hostile, reservedName: true })]));
    const row = await screen.findByTestId(`mcp-server-row-${hostile}`);
    const name = within(row).getByText(
      (_, element) => element?.textContent === hostile && element.tagName === 'SPAN'
    );
    expect([...name.children].map((child) => child.tagName)).toEqual(['WBR', 'WBR', 'WBR']);
    expect(name.textContent).toBe(hostile);
    expect(row.querySelector('img, a')).toBeNull();
  });

  it('a name is plain text in the notice, whatever it holds (Security)', async () => {
    const user = userEvent.setup();
    const hostile = '**bold**<img src=x onerror=alert(1)>[link](https://x.test)';
    renderTab(
      transportWith([createMockGlobalMcpServer({ name: hostile, reservedName: true })], {
        checkGlobalMcpServerTools: vi.fn().mockResolvedValue({ status: 'not-checked' }),
        listGlobalMcpStandingAllows: vi.fn().mockResolvedValue({ allows: [] }),
      })
    );
    await user.click(await screen.findByRole('button', { name: /bold/ }));
    const sheet = within(await screen.findByRole('dialog'));
    const line = sheet.getByText(`“${hostile}” is reserved for DorkOS’s own tools`, {
      exact: false,
    });
    expect(line.children).toHaveLength(0);
    const notice = '[data-slot="reserved-name-notice"]';
    expect(
      document.querySelector(`${notice} img, ${notice} a, ${notice} strong, ${notice} b`)
    ).toBeNull();
  });

  it('Remove and add again… opens the same Add with its command, then asks to remove the old one', async () => {
    const user = userEvent.setup();
    const addGlobalMcpServer = vi.fn().mockResolvedValue(createMockGlobalMcpServer());
    const removeGlobalMcpServer = vi.fn().mockResolvedValue(undefined);
    renderTab(reservedTransport({ addGlobalMcpServer, removeGlobalMcpServer }));
    const sheet = await openSheet(user);
    await user.click(sheet.getByRole('button', { name: 'Remove and add again…' }));

    expect(await screen.findByText('Add it again under a new name')).toBeInTheDocument();
    expect(screen.queryByText('Add a server')).toBeNull();
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription(
      'Use any name except “DorkOS_Connections”.'
    );
    // Each hidden value says to type it again; a plain one says nothing.
    expect(screen.getByLabelText('Value of MADE_UP_KEY')).toHaveAccessibleDescription(
      'Type the value of MADE_UP_KEY again. Hidden values aren’t kept.'
    );
    expect(screen.queryByText(/value of REGION/)).toBeNull();
    expect(screen.getByLabelText('Command')).toHaveValue('npx');
    expect(screen.getByLabelText('Arguments')).toHaveValue(
      '-y made-up-mcp@1.2.3 --workspace "Design team"'
    );
    // A saved value is never shown again, so every one is typed, not only the secret.
    await user.type(screen.getByLabelText('Name'), 'notion-demo');
    expect(screen.queryByText(/Use any name except/)).toBeNull();
    await user.type(screen.getByLabelText('Value of MADE_UP_KEY'), 'typed-key');
    expect(screen.queryByText(/value of MADE_UP_KEY/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Type a value for REGION.')).toBeInTheDocument();
    expect(addGlobalMcpServer).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Value of REGION'), 'eu');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(addGlobalMcpServer).toHaveBeenCalledWith({
        name: 'notion-demo',
        enabled: true,
        excludedAgents: ['b'],
        secretNames: ['MADE_UP_KEY'],
        connection: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'made-up-mcp@1.2.3', '--workspace', 'Design team'],
          env: { MADE_UP_KEY: 'typed-key', REGION: 'eu' },
        },
      })
    );
    // Then the old one's own Remove, which the person still answers.
    const ask = within(await screen.findByRole('alertdialog'));
    expect(ask.getByRole('heading')).toHaveTextContent('Remove DorkOS_Connections?');
    expect(removeGlobalMcpServer).not.toHaveBeenCalled();
    await user.click(ask.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(removeGlobalMcpServer).toHaveBeenCalledWith('DorkOS_Connections'));
  });

  it('a cancelled re-add adds nothing and removes nothing', async () => {
    const user = userEvent.setup();
    const addGlobalMcpServer = vi.fn();
    const removeGlobalMcpServer = vi.fn();
    renderTab(reservedTransport({ addGlobalMcpServer, removeGlobalMcpServer }));
    const sheet = await openSheet(user);
    await user.click(sheet.getByRole('button', { name: 'Remove and add again…' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Add it again under a new name')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(addGlobalMcpServer).not.toHaveBeenCalled();
    expect(removeGlobalMcpServer).not.toHaveBeenCalled();
  });
});
