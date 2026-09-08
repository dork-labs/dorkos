/** Confined, no-retry Composio trigger management and raw signature verification. */
import { createHash } from 'node:crypto';
import { Composio } from '@composio/core';
import { stableStringify } from '@dorkos/shared/capabilities';
import {
  ConnectorEventDefinitionSchema,
  type ConnectorEventDefinition,
} from '@dorkos/shared/connector-event-schemas';
import type {
  ConnectorEventCapability,
  ConnectorEventMutationAuthority,
  ConnectorEventMutationResult,
  ConnectorEventPageRequest,
  ConnectorPhysicalTriggerScope,
  ConnectorRawWebhook,
} from '@dorkos/shared/connector-events';
import { ComposioCatalogError, type ComposioSdkClientOpts } from './sdk-client.js';
import { verifyComposioWebhook } from './webhook-verifier.js';

/** Server-only event adapter configuration; secret material is never returned in results. */
export interface ComposioEventClientOptions extends ComposioSdkClientOpts {
  webhookSecret?: string;
}

type Sdk = ReturnType<Composio['getClient']>;
type DefinitionResponse = Awaited<ReturnType<Sdk['triggersTypes']['retrieve']>>;

/** Preserve actual detection metadata, rejecting another toolkit or version. */
function definition(
  item: DefinitionResponse,
  toolkit: string,
  version: string
): ConnectorEventDefinition {
  if (item.toolkit.slug !== toolkit || item.version !== version || version === 'latest') {
    throw new ComposioCatalogError('Event metadata did not match the selected service version.');
  }
  const fields = {
    eventType: item.slug,
    displayName: item.name,
    toolkit,
    toolkitVersion: version,
    filterSchema: item.config,
    payloadSchema: item.payload,
    deliveryMode:
      item.type === 'poll' ? 'polling' : item.type === 'webhook' ? 'webhook' : 'unknown',
    expectedCadenceSeconds: null,
  };
  return ConnectorEventDefinitionSchema.parse({
    ...fields,
    definitionHash: `sha256:${createHash('sha256').update(stableStringify(fields)).digest('hex')}`,
  });
}

/** Exact-account event adapter shared by BYO and the managed service. */
export class ComposioEventClient implements ConnectorEventCapability {
  private readonly sdk: Composio;
  private readonly client: Sdk;
  private readonly serverUserId: string;
  private readonly webhookSecret: string | undefined;

  constructor(options: ComposioEventClientOptions) {
    this.sdk = new Composio({
      apiKey: options.apiKey,
      allowTracking: false,
      dangerouslyAllowAutoUploadDownloadFiles: false,
      disableVersionCheck: true,
      ...(options.baseUrl !== undefined && { baseURL: options.baseUrl }),
    });
    this.client = this.sdk.getClient().withOptions({ maxRetries: 0 });
    this.serverUserId = options.serverUserId;
    this.webhookSecret = options.webhookSecret;
  }

  /** Discover a bounded page while retaining metadata discarded by the SDK convenience API. */
  async listDefinitions(request: ConnectorEventPageRequest) {
    if (
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 100 ||
      !request.toolkitVersion ||
      request.toolkitVersion === 'latest'
    ) {
      throw new ComposioCatalogError(
        'Event discovery needs an exact version and a limit from 1 to 100.'
      );
    }
    try {
      const page = await this.client.triggersTypes.list(
        {
          toolkit_slugs: [request.toolkit],
          toolkit_versions: { [request.toolkit]: request.toolkitVersion },
          limit: request.limit,
          ...(request.cursor !== undefined && { cursor: request.cursor }),
        },
        { signal: request.signal }
      );
      if (
        page.total_pages > 100 ||
        page.items.length > request.limit ||
        (page.current_page < page.total_pages && !page.next_cursor) ||
        (page.next_cursor !== undefined && page.next_cursor === request.cursor)
      ) {
        throw new Error('Incomplete event metadata page');
      }
      return {
        status: 'ok' as const,
        definitions: page.items.map((item) =>
          definition(item, request.toolkit, request.toolkitVersion)
        ),
        ...(page.next_cursor && { nextCursor: page.next_cursor }),
      };
    } catch {
      throw new ComposioCatalogError('Event discovery failed. Check the connection status.');
    }
  }

  /** Reconcile every bounded exact-scope match, including disabled pre-existing triggers. */
  async reconcileTrigger(input: ConnectorPhysicalTriggerScope & { signal: AbortSignal }) {
    try {
      const matches = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const page = await this.client.triggerInstances.listActive(
          {
            connected_account_ids: [input.externalAccountRef],
            user_ids: [this.serverUserId],
            trigger_names: [input.definition.eventType],
            show_disabled: true,
            limit: 100,
            ...(cursor !== undefined && { cursor }),
          },
          { signal: input.signal }
        );
        for (const item of page.items) {
          if (
            item.connected_account_id !== input.externalAccountRef ||
            item.user_id !== this.serverUserId ||
            item.trigger_name !== input.definition.eventType ||
            item.version !== input.definition.toolkitVersion ||
            stableStringify(item.trigger_config) !== stableStringify(input.filter)
          )
            continue;
          matches.push({
            providerTriggerRef: item.id,
            ...(item.uuid && { providerTriggerUuid: item.uuid }),
            externalAccountRef: item.connected_account_id,
            externalAccountUuid: item.connected_account_uuid,
            enabled: item.disabled_at === null,
          });
        }
        if (matches.length > 1) return { status: 'ambiguous' as const };
        if (!page.next_cursor) {
          if (page.current_page < page.total_pages) return { status: 'unavailable' as const };
          return matches[0]
            ? { status: 'found' as const, trigger: matches[0] }
            : { status: 'absent' as const };
        }
        if (cursors.has(page.next_cursor)) return { status: 'unavailable' as const };
        cursors.add(page.next_cursor);
        cursor = page.next_cursor;
      }
    } catch {
      /* Return a bounded, payload-free reconciliation failure. */
    }
    return { status: 'unavailable' as const };
  }

  /** Create or reuse a trigger without asserting exclusive ownership of the result. */
  async createTrigger(input: ConnectorPhysicalTriggerScope & ConnectorEventMutationAuthority) {
    let dispatched = false;
    try {
      const metadata = await this.client.triggersTypes.retrieve(
        input.definition.eventType,
        {
          toolkit_versions: { [input.definition.toolkit]: input.definition.toolkitVersion },
        },
        { signal: input.signal }
      );
      const current = definition(
        metadata,
        input.definition.toolkit,
        input.definition.toolkitVersion
      );
      if (
        current.definitionHash !== input.definition.definitionHash ||
        !input.externalAccountRef ||
        !this.serverUserId
      ) {
        return { status: 'error' as const, code: 'PROVIDER_PRECHECK_FAILED' as const };
      }
      const body = {
        connected_account_id: input.externalAccountRef,
        user_id: this.serverUserId,
        toolkit_versions: { [current.toolkit]: current.toolkitVersion },
        trigger_config: input.filter,
      };
      if (input.signal.aborted) return { status: 'denied' as const, code: 'CANCELLED' as const };
      if (!(await input.authorizeDispatch()))
        return { status: 'denied' as const, code: 'AUTHORITY_CHANGED' as const };
      // No asynchronous preflight remains after this authority check.
      dispatched = true;
      const result = await this.client.triggerInstances.upsert(current.eventType, body, {
        signal: input.signal,
      });
      if (!result.trigger_id) throw new Error('Missing trigger identity');
      return {
        status: 'ready' as const,
        providerTriggerRef: result.trigger_id,
        ownership: 'unproven' as const,
      };
    } catch {
      return dispatched
        ? { status: 'outcome_unknown' as const, code: 'PROVIDER_OUTCOME_UNKNOWN' as const }
        : { status: 'error' as const, code: 'PROVIDER_PRECHECK_FAILED' as const };
    }
  }

  /** Enable or disable only after the owning service proves management authority. */
  setTriggerEnabled(
    input: ConnectorEventMutationAuthority & { providerTriggerRef: string; enabled: boolean }
  ) {
    return this.mutate(input, () =>
      this.client.triggerInstances.manage.update(
        input.providerTriggerRef,
        {
          status: input.enabled ? 'enable' : 'disable',
        },
        { signal: input.signal }
      )
    );
  }

  /** Delete only a binding whose cleanup ownership the owning service proved. */
  deleteTrigger(input: ConnectorEventMutationAuthority & { providerTriggerRef: string }) {
    return this.mutate(input, () =>
      this.client.triggerInstances.manage.delete(input.providerTriggerRef, { signal: input.signal })
    );
  }

  private async mutate(
    input: ConnectorEventMutationAuthority,
    dispatch: () => Promise<unknown>
  ): Promise<ConnectorEventMutationResult> {
    let dispatched = false;
    try {
      if (input.signal.aborted) return { status: 'denied', code: 'CANCELLED' };
      if (!(await input.authorizeDispatch()))
        return { status: 'denied', code: 'AUTHORITY_CHANGED' };
      dispatched = true;
      await dispatch();
      return { status: 'ok' };
    } catch {
      return dispatched
        ? { status: 'outcome_unknown', code: 'PROVIDER_OUTCOME_UNKNOWN' }
        : { status: 'error', code: 'PROVIDER_PRECHECK_FAILED' };
    }
  }

  /** Verify the signature and additionally pin BYO envelopes to the configured user. */
  async verifyWebhook(input: ConnectorRawWebhook) {
    const result = await verifyComposioWebhook(this.sdk, this.webhookSecret, input);
    if (
      result.status === 'verified' &&
      result.event.envelopeVersion === 'V2' &&
      result.event.providerUserRef !== this.serverUserId
    ) {
      return { status: 'rejected' as const, code: 'INVALID_BINDING' };
    }
    return result;
  }
}
