/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useTunnelActions } from '../model/use-tunnel-actions';
import type { TunnelMachine } from '../model/use-tunnel-machine';

/**
 * Turning remote access on and off is no longer this hook's business — three
 * surfaces do that and it lives once in `@/layers/entities/tunnel` (DOR-1743),
 * where `remote-access.test.tsx` drives it. What is left here is the pair of
 * writes only the dialog makes: the ngrok token and the custom domain.
 */

/**
 * Minimal fake machine — the setters these two writes touch, plus the field
 * values they read. Every setter is a spy, so nothing here is real React state
 * and no assertion needs `act`.
 */
function fakeMachine(overrides: Partial<TunnelMachine> = {}): TunnelMachine {
  return {
    authToken: 'ngrok-auth-token',
    // The field holds something the server has not got, so a save is a real
    // change. `handleSaveDomain` compares the two.
    domain: 'my-box.ngrok.app',
    tunnel: undefined,
    setAuthToken: vi.fn(),
    setShowTokenInput: vi.fn(),
    setShowSetup: vi.fn(),
    setTokenError: vi.fn(),
    setDomainError: vi.fn(),
    ...overrides,
  } as unknown as TunnelMachine;
}

/** Mount the actions over a fake machine and a mock transport. */
function setup(overrides: Partial<TunnelMachine> = {}) {
  const transport = createMockTransport();
  const machine = fakeMachine(overrides);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result } = renderHook(() => useTunnelActions({ machine }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  });
  return { transport, machine, actions: result };
}

/**
 * A refusal shaped the way `PATCH /api/config` sends one and `fetchJSON` throws
 * it: the SAME `error` sentence for both codes, with the distinguishing detail
 * in `body.message`. Getting this shape right is the point — a fixture that gave
 * each code its own `.message` would let a broken implementation pass by reading
 * the message alone.
 */
function configRefusal(code: string) {
  return Object.assign(new Error('Only a person can change those settings'), {
    code,
    status: 403,
    body: { error: 'Only a person can change those settings', code, message: 'server detail' },
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useTunnelActions — handleSaveToken surfaces why the save failed', () => {
  it('clears the error and resets the field when the save goes through', async () => {
    const { transport, machine, actions } = setup();

    await actions.current.handleSaveToken();

    expect(transport.updateConfig).toHaveBeenCalledWith({
      tunnel: { authtoken: 'ngrok-auth-token' },
    });
    expect(machine.setTokenError).toHaveBeenCalledWith(null);
    expect(machine.setTokenError).not.toHaveBeenCalledWith(expect.any(String));
    expect(machine.setAuthToken).toHaveBeenCalledWith('');
    expect(machine.setShowTokenInput).toHaveBeenCalledWith(false);
    expect(machine.setShowSetup).toHaveBeenCalledWith(false);
  });

  it('shows the field problem a rejected patch names, not "Validation failed"', async () => {
    const { transport, machine, actions } = setup();
    // The REAL 400: `applyConfigPatch` answers with the constant headline
    // `'Validation failed'` and puts the per-field text in `details[]`, so the
    // only useful sentence is in the body. `fetchJSON` builds `.message` from
    // `error`, which is the headline.
    vi.mocked(transport.updateConfig).mockRejectedValue(
      Object.assign(new Error('Validation failed'), {
        status: 400,
        body: {
          error: 'Validation failed',
          details: ['tunnel.authtoken: Expected string, received number'],
        },
      })
    );

    await actions.current.handleSaveToken();

    expect(machine.setTokenError).toHaveBeenLastCalledWith(
      'tunnel.authtoken: Expected string, received number'
    );
    expect(machine.setTokenError).not.toHaveBeenCalledWith('Validation failed');
    expect(machine.setTokenError).not.toHaveBeenCalledWith('Could not save token. Try again.');
  });

  it("shows a 4xx's own sentence when it wrote one instead of details", async () => {
    const { transport, machine, actions } = setup();
    // `applyConfigPatch`'s other 400, and the 428 autonomy gate, both send a
    // real sentence and no `details`.
    vi.mocked(transport.updateConfig).mockRejectedValue(
      Object.assign(new Error('Request body must be a JSON object'), { status: 400 })
    );

    await actions.current.handleSaveToken();

    expect(machine.setTokenError).toHaveBeenLastCalledWith('Request body must be a JSON object');
  });

  it('does not repeat "Internal server error" at a person', async () => {
    const { transport, machine, actions } = setup();
    // Every throw inside the route lands here, and the body is that constant —
    // jargon that names nothing the person can act on. Showing it raw would be
    // WORSE than the generic line, which at least suggests what to do.
    vi.mocked(transport.updateConfig).mockRejectedValue(
      Object.assign(new Error('Internal server error'), {
        status: 500,
        body: { error: 'Internal server error' },
      })
    );

    await actions.current.handleSaveToken();

    expect(machine.setTokenError).toHaveBeenLastCalledWith('Could not save token. Try again.');
  });

  it('does not repeat a raw network failure at a person', async () => {
    const { transport, machine, actions } = setup();
    // `fetch` rejecting never reaches the `!res.ok` branch, so there is no
    // status and no body — just the browser's own words.
    vi.mocked(transport.updateConfig).mockRejectedValue(new TypeError('Failed to fetch'));

    await actions.current.handleSaveToken();

    expect(machine.setTokenError).toHaveBeenLastCalledWith('Could not save token. Try again.');
  });

  it('tells a caller with no session cookie to sign in', async () => {
    const { transport, machine, actions } = setup();
    vi.mocked(transport.updateConfig).mockRejectedValue(configRefusal('operator_cookie_required'));

    await actions.current.handleSaveToken();

    expect(machine.setTokenError).toHaveBeenLastCalledWith(
      'Sign in to DorkOS first — only a signed-in person can change Remote Access settings.'
    );
  });

  it('tells an agent that Remote Access settings are not its to change', async () => {
    const { transport, machine, actions } = setup();
    vi.mocked(transport.updateConfig).mockRejectedValue(configRefusal('operator_only_config'));

    await actions.current.handleSaveToken();

    expect(machine.setTokenError).toHaveBeenLastCalledWith(
      'Only you can change Remote Access settings — an agent cannot. Nothing changed.'
    );
  });

  it('keeps the two operator refusals apart, which the server sentence cannot', async () => {
    const cookie = setup();
    vi.mocked(cookie.transport.updateConfig).mockRejectedValue(
      configRefusal('operator_cookie_required')
    );
    await cookie.actions.current.handleSaveToken();

    const agent = setup();
    vi.mocked(agent.transport.updateConfig).mockRejectedValue(
      configRefusal('operator_only_config')
    );
    await agent.actions.current.handleSaveToken();

    const [cookieMessage] = vi.mocked(cookie.machine.setTokenError).mock.lastCall ?? [];
    const [agentMessage] = vi.mocked(agent.machine.setTokenError).mock.lastCall ?? [];
    expect(cookieMessage).not.toBe(agentMessage);
    // Neither one repeats the single sentence the route sends for both.
    expect(cookieMessage).not.toBe('Only a person can change those settings');
    expect(agentMessage).not.toBe('Only a person can change those settings');
  });

  it('falls back to the generic line when the failure carries no message', async () => {
    const { transport, machine, actions } = setup();
    vi.mocked(transport.updateConfig).mockRejectedValue(new Error(''));

    await actions.current.handleSaveToken();

    expect(machine.setTokenError).toHaveBeenLastCalledWith('Could not save token. Try again.');
  });
});

describe('useTunnelActions — handleSaveDomain no longer swallows failures', () => {
  it('clears the error when the save goes through', async () => {
    const { transport, machine, actions } = setup();

    await actions.current.handleSaveDomain();

    expect(transport.updateConfig).toHaveBeenCalledWith({
      tunnel: { domain: 'my-box.ngrok.app' },
    });
    expect(machine.setDomainError).toHaveBeenCalledWith(null);
    expect(machine.setDomainError).not.toHaveBeenCalledWith(expect.any(String));
  });

  it('sends null when a saved domain is deliberately cleared', async () => {
    const { transport, actions } = setup({
      domain: '   ',
      tunnel: { domain: 'my-box.ngrok.app' } as TunnelMachine['tunnel'],
    });

    await actions.current.handleSaveDomain();

    expect(transport.updateConfig).toHaveBeenCalledWith({ tunnel: { domain: null } });
  });

  it('writes nothing when the field was only blurred, not changed', async () => {
    const { transport, machine, actions } = setup({
      domain: 'my-box.ngrok.app',
      tunnel: { domain: 'my-box.ngrok.app' } as TunnelMachine['tunnel'],
    });

    await actions.current.handleSaveDomain();

    expect(transport.updateConfig).not.toHaveBeenCalled();
    expect(machine.setDomainError).not.toHaveBeenCalled();
  });

  it('writes nothing when an empty field is blurred over an unset domain', async () => {
    // The shape that used to wipe a saved domain: the input renders empty
    // because the config DTO reported no LIVE domain, and a blur past it wrote
    // `null` over whatever was stored.
    const { transport, actions } = setup({ domain: '', tunnel: undefined });

    await actions.current.handleSaveDomain();

    expect(transport.updateConfig).not.toHaveBeenCalled();
  });

  it('shows the field problem a rejected domain patch names', async () => {
    const { transport, machine, actions } = setup();
    vi.mocked(transport.updateConfig).mockRejectedValue(
      Object.assign(new Error('Validation failed'), {
        status: 400,
        body: { error: 'Validation failed', details: ['tunnel.domain: must be a hostname'] },
      })
    );

    await actions.current.handleSaveDomain();

    expect(machine.setDomainError).toHaveBeenLastCalledWith('tunnel.domain: must be a hostname');
  });

  it('applies the operator-refusal copy to the domain save too', async () => {
    const { transport, machine, actions } = setup();
    vi.mocked(transport.updateConfig).mockRejectedValue(configRefusal('operator_cookie_required'));

    await actions.current.handleSaveDomain();

    expect(machine.setDomainError).toHaveBeenLastCalledWith(
      'Sign in to DorkOS first — only a signed-in person can change Remote Access settings.'
    );
  });

  it('falls back to the generic line when the failure carries no message', async () => {
    const { transport, machine, actions } = setup();
    vi.mocked(transport.updateConfig).mockRejectedValue(new Error(''));

    await actions.current.handleSaveDomain();

    expect(machine.setDomainError).toHaveBeenLastCalledWith('Could not save domain. Try again.');
  });
});
