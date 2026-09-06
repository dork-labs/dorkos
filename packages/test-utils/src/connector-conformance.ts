/** Shared conformance suite for the instance-bound ConnectorProvider port. */
import { describe, expect, it } from 'vitest';
import {
  ConnectStartSchema,
  ConnectorCapabilitiesSchema,
  ConnectorToolkitSchema,
  ProviderConnectedAccountSchema,
  type ConnectorExternalAccountRef,
  type ConnectorProvider,
  type ProviderConnectedAccount,
} from '@dorkos/shared/connector-provider';
import {
  ConnectorOperationPageSchema,
  ConnectorProviderExecuteResultSchema,
  ConnectorUnsupportedResultSchema,
  type ConnectorOperationRevision,
} from '@dorkos/shared/connector-schemas';

/** Poll attempts allowed before a connect flow is deemed stuck. */
const MAX_POLL_ATTEMPTS = 10;

/** An arranged account that cannot be exposed through the compatibility MCP seam. */
export interface UnexposableAccount {
  /** Provider holding the account. */
  provider: ConnectorProvider;
  /** Private provider account reference. */
  externalAccountRef: ConnectorExternalAccountRef;
}

/** Tuning knobs and required hooks for connector conformance. */
export interface ConnectorConformanceOpts {
  /** Label for the registered describe block. */
  name?: string;
  /** Toolkit exercised by the suite. */
  toolkit?: string;
  /** Arrange an account that the compatibility MCP seam cannot expose. */
  makeUnexposableAccount: () => Promise<UnexposableAccount>;
  /** Optional executing provider that stays pending until a deadline aborts it. */
  makeSlowExecutingProvider?: () => ConnectorProvider;
}

/** Register the provider-neutral conformance suite for one backend. */
export function connectorConformance(
  makeProvider: () => ConnectorProvider,
  opts: ConnectorConformanceOpts
): void {
  const {
    name = 'ConnectorProvider conformance',
    toolkit = 'gmail',
    makeUnexposableAccount,
    makeSlowExecutingProvider,
  } = opts;

  async function connect(
    provider: ConnectorProvider,
    label?: string
  ): Promise<{ status: string; account?: ProviderConnectedAccount }> {
    const start = await provider.startConnect(toolkit, label ? { label } : undefined);
    expect(
      ConnectStartSchema.safeParse(start).success,
      'startConnect must return a valid connect-flow reference'
    ).toBe(true);
    expect(start.flowId.length, 'startConnect must return a flow id').toBeGreaterThan(0);
    let poll = await provider.pollConnect(start.flowId);
    let attempts = 0;
    while (poll.status === 'pending' && attempts < MAX_POLL_ATTEMPTS) {
      poll = await provider.pollConnect(start.flowId);
      attempts += 1;
    }
    return poll;
  }

  async function connectOk(
    provider: ConnectorProvider,
    label?: string
  ): Promise<ProviderConnectedAccount> {
    const poll = await connect(provider, label);
    expect(poll.status).toBe('connected');
    return ProviderConnectedAccountSchema.parse(poll.account);
  }

  async function firstOperation(provider: ConnectorProvider): Promise<ConnectorOperationRevision> {
    const result = await provider.listOperationSchemas({ toolkit, limit: 1 });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.reason);
    const operation = result.page.operations[0];
    expect(operation).toBeDefined();
    return {
      ...operation!,
      id: 'revision-for-conformance',
      discoveredAt: new Date(0).toISOString(),
    };
  }

  function operationFixture(provider: ConnectorProvider): ConnectorOperationRevision {
    return {
      id: 'revision-for-conformance',
      providerInstanceId: provider.instanceId,
      toolkit,
      operationSlug: `${toolkit}.read`,
      toolkitVersion: '2026-09-01',
      schemaHash: 'sha256:conformance-read-v1',
      capabilityClassification: 'read',
      inputSchema: { type: 'object', additionalProperties: false },
      discoveredAt: new Date(0).toISOString(),
    };
  }

  describe(name, () => {
    it('declares an instance identity and every capability honestly', () => {
      const provider = makeProvider();
      const capabilities = ConnectorCapabilitiesSchema.parse(provider.getCapabilities());
      expect(capabilities.instanceId).toBe(provider.instanceId);
      expect(capabilities.type).toBe(provider.type);
      expect(Object.keys(capabilities.capabilities).sort()).toEqual([
        'accounts',
        'authentication',
        'catalog',
        'execution',
        'operations',
        'triggers',
      ]);
    });

    it('returns a bounded catalog page and well-formed legacy aggregate', async () => {
      const provider = makeProvider();
      const page = await provider.listToolkitPage({ limit: 1 });
      expect(page.status).toBe('ok');
      if (page.status === 'ok') {
        expect(page.toolkits.length).toBeLessThanOrEqual(1);
        page.toolkits.forEach((entry) => ConnectorToolkitSchema.parse(entry));
        expect(page.truncated).toBe(Boolean(page.nextCursor));
      }
      const all = await provider.listToolkits();
      expect(all.map((entry) => entry.slug)).toContain(toolkit);
    });

    it('surfaces operation pagination, immutable metadata, and truncation', async () => {
      const provider = makeProvider();
      const first = await provider.listOperationSchemas({ toolkit, limit: 1 });
      const operationCapability = provider.getCapabilities().capabilities.operations;
      if (operationCapability.status === 'unsupported') {
        ConnectorUnsupportedResultSchema.parse(first);
        expect(first).toMatchObject({
          status: 'unsupported',
          reason: operationCapability.reason,
        });
        expect(JSON.stringify(first)).not.toMatch(/authorization|headers|https?:\/\//i);
        return;
      }
      expect(first.status).toBe('ok');
      if (first.status !== 'ok') return;
      ConnectorOperationPageSchema.parse(first.page);
      expect(first.page.operations).toHaveLength(1);
      expect(first.page.operations[0]).toMatchObject({
        providerInstanceId: provider.instanceId,
        toolkit,
        toolkitVersion: expect.any(String),
        schemaHash: expect.any(String),
        capabilityClassification: expect.stringMatching(/^(read|write|destructive)$/),
      });
      expect(first.page.truncated).toBe(true);
      expect(first.page.nextCursor).toBeDefined();
      const second = await provider.listOperationSchemas({
        toolkit,
        cursor: first.page.nextCursor,
        limit: 1,
      });
      expect(second.status).toBe('ok');
      if (second.status === 'ok') {
        expect(second.page.operations[0]?.operationSlug).not.toBe(
          first.page.operations[0]?.operationSlug
        );
      }
    });

    it('authenticates, lists, and disconnects an exact private account reference', async () => {
      const provider = makeProvider();
      const account = await connectOk(provider, 'personal');
      expect(account.toolkit).toBe(toolkit);
      expect(
        (await provider.listAccounts({ toolkit })).map((row) => row.externalAccountRef)
      ).toContain(account.externalAccountRef);
      await provider.disconnect(account.externalAccountRef);
      expect(
        (await provider.listAccounts({ toolkit })).map((row) => row.externalAccountRef)
      ).not.toContain(account.externalAccountRef);
    });

    it('executes only the supplied private account and returns a secret-free envelope', async () => {
      const provider = makeProvider();
      const first = await connectOk(provider, 'personal');
      const selected = provider.getCapabilities().supportsMultiAccount
        ? await connectOk(provider, 'work')
        : first;
      const executionCapability = provider.getCapabilities().capabilities.execution;
      if (executionCapability.status === 'unsupported') {
        const unsupported = await provider.execute({
          externalAccountRef: selected.externalAccountRef,
          operation: operationFixture(provider),
          arguments: { query: 'hello' },
          logicalOperationId: 'logical-unsupported',
          attemptId: 'attempt-unsupported',
          signal: new AbortController().signal,
        });
        ConnectorProviderExecuteResultSchema.parse(unsupported);
        ConnectorUnsupportedResultSchema.parse(unsupported);
        expect(unsupported).toMatchObject({
          status: 'unsupported',
          reason: executionCapability.reason,
        });
        const serialized = JSON.stringify(unsupported);
        expect(serialized).not.toContain(first.externalAccountRef);
        expect(serialized).not.toContain(selected.externalAccountRef);
        expect(serialized).not.toMatch(/authorization|headers|https?:\/\//i);
        return;
      }
      const operation = await firstOperation(provider);
      const result = await provider.execute({
        externalAccountRef: selected.externalAccountRef,
        operation,
        arguments: { query: 'hello' },
        logicalOperationId: 'logical-1',
        attemptId: 'attempt-1',
        signal: new AbortController().signal,
      });
      ConnectorProviderExecuteResultSchema.parse(result);
      expect(result.status).toBe('success');
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(first.externalAccountRef);
      expect(serialized).not.toContain(selected.externalAccountRef);
      expect(serialized).not.toMatch(/authorization|headers|https?:\/\//i);

      const unknownAccount = await provider.execute({
        externalAccountRef: '__missing_private_account__' as ConnectorExternalAccountRef,
        operation,
        arguments: { query: 'hello' },
        logicalOperationId: 'logical-missing-account',
        attemptId: 'attempt-missing-account',
        signal: new AbortController().signal,
      });
      expect(unknownAccount.status).toBe('error');
    });

    it('honors an already-aborted signal', async () => {
      const provider = makeProvider();
      if (provider.getCapabilities().capabilities.execution.status === 'unsupported') return;
      const account = await connectOk(provider);
      const controller = new AbortController();
      controller.abort();
      const result = await provider.execute({
        externalAccountRef: account.externalAccountRef,
        operation: await firstOperation(provider),
        arguments: {},
        logicalOperationId: 'logical-abort',
        attemptId: 'attempt-abort',
        signal: controller.signal,
      });
      expect(result).toMatchObject({ status: 'error', code: 'aborted' });
    });

    if (makeSlowExecutingProvider) {
      it('honors a deadline abort after execution has started', async () => {
        const provider = makeSlowExecutingProvider();
        const account = await connectOk(provider);
        const controller = new AbortController();
        const pending = provider.execute({
          externalAccountRef: account.externalAccountRef,
          operation: await firstOperation(provider),
          arguments: {},
          logicalOperationId: 'logical-timeout',
          attemptId: 'attempt-timeout',
          signal: controller.signal,
        });
        controller.abort();
        await expect(pending).resolves.toMatchObject({ status: 'error', code: 'aborted' });
      });
    }

    it('returns typed unsupported for a capability declared unsupported', async () => {
      const provider = makeProvider();
      const declaration = provider.getCapabilities().capabilities.triggers;
      const result = await provider.listTriggerTypes(toolkit);
      if (declaration.status === 'unsupported') {
        ConnectorUnsupportedResultSchema.parse(result);
        expect(result).toMatchObject({ status: 'unsupported', reason: declaration.reason });
        expect(JSON.stringify(result)).not.toMatch(/authorization|headers|https?:\/\//i);
      } else {
        expect(result.status).toBe('ok');
      }
    });

    it('keeps compatibility MCP exposure exact-account and nullable', async () => {
      const provider = makeProvider();
      const account = await connectOk(provider);
      const connection = await provider.toolServerForAccount(account.externalAccountRef);
      if (provider.getCapabilities().exposesOverMcp) expect(connection).not.toBeNull();
      else expect(connection).toBeNull();

      const unexposable = await makeUnexposableAccount();
      await expect(
        unexposable.provider.toolServerForAccount(unexposable.externalAccountRef)
      ).resolves.toBeNull();
    });
  });
}
