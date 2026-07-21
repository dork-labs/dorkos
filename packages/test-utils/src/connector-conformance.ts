/**
 * Shared ConnectorProvider conformance suite — the behavioral gate every
 * connector backend (raw-MCP, Composio, Nango, {@link ./fake-connector-provider.js | FakeConnectorProvider})
 * clears. The connector analogue of `runtimeConformance`.
 *
 * `connectorConformance(makeProvider, opts)` registers a `describe` block that
 * asserts the `ConnectorProvider` contract
 * (`packages/shared/src/connector-provider.ts`) against any backend,
 * parameterized by a factory. The suite is capability-aware: the multi-account
 * assertion branches on `supportsMultiAccount` rather than weakening, exactly as
 * `runtimeConformance` declares differences via opts.
 *
 * Division of labor: this suite covers connector BEHAVIOR; the TypeScript
 * interface covers SHAPE (a provider omitting a method fails compilation).
 *
 * @module test-utils/connector-conformance
 */
import { describe, expect, it } from 'vitest';
import {
  ConnectedAccountSchema,
  ConnectorCapabilitiesSchema,
  ConnectorToolkitSchema,
  type ConnectedAccount,
  type ConnectedAccountId,
  type ConnectorProvider,
} from '@dorkos/shared/connector-provider';

/** Poll attempts allowed before a connect flow is deemed stuck. */
const MAX_POLL_ATTEMPTS = 10;

/** Valid `McpAppServerConnection.transport` discriminants. */
const MCP_TRANSPORTS = ['stdio', 'http', 'sse'];

/**
 * An arranged account that cannot be exposed — the input to the REQUIRED
 * null-branch case. Bundles the provider and the id together because different
 * backends reach "unexposable" differently (an `expired` fake account, an
 * unreachable raw-MCP server), and `toolServerForAccount` must be asked on the
 * same instance that was arranged.
 */
export interface UnexposableAccount {
  /** The provider holding the unexposable account. */
  provider: ConnectorProvider;
  /** The account whose `toolServerForAccount` must resolve to `null`. */
  accountId: ConnectedAccountId;
}

/** Tuning knobs + required hooks for the connector conformance suite. */
export interface ConnectorConformanceOpts {
  /** Label for the registered describe block. Defaults to `'ConnectorProvider conformance'`. */
  name?: string;
  /**
   * Toolkit slug to exercise connect/list/expose against; must appear in the
   * provider's `listToolkits()`. Defaults to `'gmail'`.
   */
  toolkit?: string;
  /**
   * REQUIRED: arrange an account whose `toolServerForAccount` resolves to
   * `null`, returning the provider and the account id. This makes the
   * null-branch case a required, always-run assertion — a provider that wrongly
   * throws instead of returning `null` fails here.
   */
  makeUnexposableAccount: () => Promise<UnexposableAccount>;
}

/**
 * Assert a value is a well-formed `McpAppServerConnection` (a TS-only type, so
 * validated structurally here).
 *
 * @param connection - The value returned by `toolServerForAccount`.
 */
function assertMcpConnection(connection: unknown): void {
  expect(connection, 'an active account must expose a tool server').not.toBeNull();
  const conn = connection as { transport?: string; url?: string; command?: string };
  expect(MCP_TRANSPORTS, `invalid transport '${String(conn.transport)}'`).toContain(conn.transport);
  if (conn.transport === 'http' || conn.transport === 'sse') {
    expect(typeof conn.url, 'http/sse connection must carry a url').toBe('string');
    expect(conn.url!.length, 'http/sse connection url must be non-empty').toBeGreaterThan(0);
  } else {
    expect(typeof conn.command, 'stdio connection must carry a command').toBe('string');
    expect(conn.command!.length, 'stdio connection command must be non-empty').toBeGreaterThan(0);
  }
}

/**
 * Register the shared ConnectorProvider conformance suite for one backend.
 *
 * Call at the top level of a Vitest test file. The factory is invoked once per
 * test so every assertion starts from a fresh provider instance.
 *
 * @param makeProvider - Factory producing a fresh, ready-to-use provider.
 * @param opts - Required hooks + declared differences; see {@link ConnectorConformanceOpts}.
 */
export function connectorConformance(
  makeProvider: () => ConnectorProvider,
  opts: ConnectorConformanceOpts
): void {
  const {
    name = 'ConnectorProvider conformance',
    toolkit = 'gmail',
    makeUnexposableAccount,
  } = opts;

  /** Drive one connect flow to a terminal poll result. */
  async function connect(
    provider: ConnectorProvider,
    label?: string
  ): Promise<{ status: string; account?: ConnectedAccount }> {
    const start = await provider.startConnect(toolkit, label ? { label } : undefined);
    expect(start.authorizeUrl.length, 'startConnect must return an authorize URL').toBeGreaterThan(
      0
    );
    expect(start.flowId.length, 'startConnect must return a flow id').toBeGreaterThan(0);

    let poll = await provider.pollConnect(start.flowId);
    let attempts = 0;
    while (poll.status === 'pending' && attempts < MAX_POLL_ATTEMPTS) {
      poll = await provider.pollConnect(start.flowId);
      attempts += 1;
    }
    return poll;
  }

  /** Connect and assert success, returning the parsed account. */
  async function connectOk(provider: ConnectorProvider, label?: string): Promise<ConnectedAccount> {
    const poll = await connect(provider, label);
    expect(poll.status, `connect must reach 'connected', got '${poll.status}'`).toBe('connected');
    const parsed = ConnectedAccountSchema.safeParse(poll.account);
    expect(
      parsed.success,
      `pollConnect account must parse: ${parsed.success ? '' : parsed.error.message}`
    ).toBe(true);
    return parsed.data as ConnectedAccount;
  }

  describe(name, () => {
    describe('capabilities', () => {
      it('getCapabilities returns a structurally valid ConnectorCapabilities matching type', () => {
        const provider = makeProvider();
        const caps = provider.getCapabilities();
        const parsed = ConnectorCapabilitiesSchema.safeParse(caps);
        expect(
          parsed.success,
          `malformed capabilities: ${parsed.success ? '' : parsed.error.message}`
        ).toBe(true);
        // The instance identifier and its declared capabilities must agree.
        expect(caps.type).toBe(provider.type);
      });
    });

    describe('discovery', () => {
      it('listToolkits returns well-formed toolkits including the exercised one', async () => {
        const provider = makeProvider();
        const toolkits = await provider.listToolkits();
        expect(Array.isArray(toolkits)).toBe(true);
        for (const tk of toolkits) {
          const parsed = ConnectorToolkitSchema.safeParse(tk);
          expect(
            parsed.success,
            `malformed toolkit: ${parsed.success ? '' : parsed.error.message}`
          ).toBe(true);
        }
        expect(
          toolkits.map((tk) => tk.slug),
          `the exercised toolkit '${toolkit}' must be listed`
        ).toContain(toolkit);
      });
    });

    describe('connect flow', () => {
      it('startConnect -> pollConnect reaches connected with a well-formed account', async () => {
        const provider = makeProvider();
        const account = await connectOk(provider);
        expect(account.toolkit).toBe(toolkit);
        expect(account.provider).toBe(provider.type);
      });

      it('listAccounts reflects a connect and then a disconnect', async () => {
        const provider = makeProvider();
        const account = await connectOk(provider);

        const afterConnect = await provider.listAccounts({ toolkit });
        expect(afterConnect.map((a) => a.id)).toContain(account.id);

        await provider.disconnect(account.id);
        const afterDisconnect = await provider.listAccounts({ toolkit });
        expect(afterDisconnect.map((a) => a.id)).not.toContain(account.id);
      });
    });

    describe('multi-account addressing', () => {
      it('honors supportsMultiAccount: two distinct ids when true, exactly one when false', async () => {
        const provider = makeProvider();
        const multi = provider.getCapabilities().supportsMultiAccount;

        const first = await connectOk(provider, 'personal');

        if (multi) {
          const second = await connectOk(provider, 'work');
          expect(second.id, 'two connects of one toolkit must yield distinct ids').not.toBe(
            first.id
          );
          const accounts = await provider.listAccounts({ toolkit });
          const ids = new Set(accounts.map((a) => a.id));
          expect(ids.size).toBeGreaterThanOrEqual(2);
        } else {
          // Single-account: a second connect is a no-op/rejects — never a second account.
          try {
            await connect(provider, 'work');
          } catch {
            // rejecting the second connect is a valid single-account behavior
          }
          const accounts = await provider.listAccounts({ toolkit });
          expect(accounts.length, 'a single-account backend holds at most one account').toBe(1);
        }
      });
    });

    describe('tool exposure (the MCP seam)', () => {
      it('toolServerForAccount honors exposesOverMcp for a healthy account', async () => {
        const provider = makeProvider();
        const account = await connectOk(provider);
        const connection = await provider.toolServerForAccount(account.id);
        if (provider.getCapabilities().exposesOverMcp) {
          assertMcpConnection(connection);
        } else {
          // A backend that does not expose over MCP resolves null even for a
          // perfectly healthy account — never a throw.
          expect(
            connection,
            'a provider with exposesOverMcp:false resolves null for a healthy account'
          ).toBeNull();
        }
      });

      it('toolServerForAccount returns NULL (never throws) for an unexposable account', async () => {
        // The REQUIRED null-branch case (spec §Detailed Design 3): expired/
        // revoked/unavailable accounts are skipped and surfaced, never thrown.
        const { provider, accountId } = await makeUnexposableAccount();
        const connection = await provider.toolServerForAccount(accountId);
        expect(connection, 'an unexposable account must resolve to null, not throw').toBeNull();
      });
    });

    describe('disconnect', () => {
      it('is idempotent — revoking an unknown id resolves without throwing', async () => {
        const provider = makeProvider();
        await expect(
          provider.disconnect('never-connected-id' as ConnectedAccountId)
        ).resolves.toBeUndefined();

        const account = await connectOk(provider);
        await expect(provider.disconnect(account.id)).resolves.toBeUndefined();
        // Revoking the same id twice still resolves.
        await expect(provider.disconnect(account.id)).resolves.toBeUndefined();
      });
    });
  });
}
