/**
 * Stable identities and durable connector contracts shared by every DorkOS
 * connector surface.
 *
 * Provider account references belong to the server-side provider port. Public
 * API and Transport DTOs use {@link ConnectionIdSchema} exclusively.
 *
 * @module shared/connector-schemas
 */
import { z } from 'zod';

/** Maximum complete operation set supported by the provider discovery safety ceiling. */
export const CONNECTOR_OPERATION_SELECTION_LIMIT = 100_000;

/**
 * How long a sign-in flow stays open before it expires, unless a server is
 * configured otherwise. Shared so the app can stop asking a person to finish a
 * sign-in that can no longer be finished.
 */
export const CONNECTOR_AUTHENTICATION_FLOW_TTL_MS = 15 * 60 * 1_000;
/** Maximum event scopes one owner review can validate and apply atomically. */
export const CONNECTOR_EVENT_REVIEW_SCOPE_LIMIT = 32;

/** JSON value accepted by connector operation arguments and provider schemas. */
export type ConnectorJsonValue =
  string | number | boolean | null | ConnectorJsonValue[] | { [key: string]: ConnectorJsonValue };

/**
 * JSON value accepted by connector operation arguments and provider schemas.
 *
 * Spelled out rather than `z.json()`, which builds its object branch from
 * `z.record()`: this schema reaches the three `connectors.execute_*` agent tools,
 * and a record anywhere in an in-session tool's schema crashes the WHOLE
 * `tools/list` answer on claude-agent-sdk 0.3.257+ with zod 4.5.3+ — the model is
 * then handed no DorkOS tools at all, with no other symptom. Full story in
 * `apps/server/.../claude-code/mcp-tools/tool-exposure.ts`.
 *
 * **Two measured differences from the record it replaces, both unreachable over
 * the wire.** `catchall` walks a value as an object where `record` first insisted
 * it was a plain one, so: a class instance (`new Date()`, `new Map()`) that a
 * record REJECTED is now accepted and parses to `{}`; and an object carrying
 * inherited enumerable properties keeps them, where a record kept only its own.
 * Everything else is identical — strings, numbers, booleans, null, arrays and
 * plain objects of those, with `undefined`, functions, `NaN` and arrays-as-objects
 * still refused.
 *
 * Neither delta can be reached by a caller: every consumer parses a value that
 * arrived as JSON — `managed-authority-sync-service.ts` calls
 * `ConnectorJsonObjectSchema.parse(JSON.parse(…))` outright, and the rest are DTO
 * fields on an HTTP body or on an agent tool's arguments — and `JSON.parse`
 * produces neither a class instance nor a non-`Object` prototype. A `.refine()`
 * guard was measured and does NOT close the gap: refinements run on the parsed
 * OUTPUT, by which point a `Date` is already `{}`. Restoring it exactly would need
 * a pre-parse `pipe`/`preprocess` — a shape change to the very schema whose
 * JSON-Schema conversion is the reason this workaround exists, which is not a risk
 * worth taking for an unreachable case. Revisit if an in-process caller ever hands
 * this schema a hand-built object.
 */
export const ConnectorJsonValueSchema: z.ZodType<ConnectorJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().refine(Number.isFinite, { message: 'Expected a finite number' }),
    z.boolean(),
    z.null(),
    z.array(ConnectorJsonValueSchema),
    z.object({}).catchall(ConnectorJsonValueSchema),
  ])
);

/**
 * JSON object accepted as one connector operation's argument payload.
 *
 * `z.object({}).catchall(...)` plus an explicit key check, rather than the
 * `z.record(z.string().min(1).max(200), …)` it reads as: this schema is the input
 * of the three `connectors.execute_*` agent tools, and a record anywhere in an
 * in-session tool's schema crashes the WHOLE `tools/list` answer on
 * claude-agent-sdk 0.3.257+ with zod 4.5.3+ — the model is then handed no DorkOS
 * tools at all, with no other symptom. Full story in
 * `apps/server/.../claude-code/mcp-tools/tool-exposure.ts`. The check keeps the
 * 1–200 key bounds a record enforced, so the accepted values are unchanged — but
 * it enforces them at RUNTIME ONLY. A record contributed `propertyNames` to the
 * generated JSON Schema; `catchall` contributes none, so the bounds no longer
 * reach a model reading the tool's schema or a reader of the OpenAPI document.
 * They are still refused on the way in. See {@link ConnectorJsonValueSchema} for
 * the two value-level differences the same swap carries.
 */
export const ConnectorJsonObjectSchema = z
  .object({})
  .catchall(ConnectorJsonValueSchema)
  .superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (key.length >= 1 && key.length <= 200) continue;
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: 'Argument names must be between 1 and 200 characters',
      });
    }
  });
/** JSON object accepted as one connector operation's argument payload. */
export type ConnectorJsonObject = z.infer<typeof ConnectorJsonObjectSchema>;

/** Stable identifier for one configured connector provider and payer. */
export const ConnectorProviderInstanceIdSchema = z
  .string()
  .min(1)
  .brand('ConnectorProviderInstanceId');
/** Stable identifier for one configured connector provider and payer. */
export type ConnectorProviderInstanceId = z.infer<typeof ConnectorProviderInstanceIdSchema>;

/** DorkOS-owned opaque identifier for one connected external account. */
export const ConnectionIdSchema = z.string().min(1).brand('ConnectionId');
/** DorkOS-owned opaque identifier for one connected external account. */
export type ConnectionId = z.infer<typeof ConnectionIdSchema>;

/** Private provider-owned account reference. Never place this in a public DTO. */
export const ConnectorExternalAccountRefSchema = z
  .string()
  .min(1)
  .brand('ConnectorExternalAccountRef');
/** Private provider-owned account reference. Never place this in a public DTO. */
export type ConnectorExternalAccountRef = z.infer<typeof ConnectorExternalAccountRefSchema>;

/** Who pays for calls made through a provider instance. */
export const ConnectorProviderModeSchema = z.enum(['managed', 'byo']);
/** Who pays for calls made through a provider instance. */
export type ConnectorProviderMode = z.infer<typeof ConnectorProviderModeSchema>;

/** Durable health of a configured provider instance. */
export const ConnectorProviderHealthSchema = z.enum([
  'available',
  'unavailable',
  'migration_failed',
]);
/** Durable health of a configured provider instance. */
export type ConnectorProviderHealth = z.infer<typeof ConnectorProviderHealthSchema>;

/** Reconciliation state for operation-level grants on a connection. */
export const ConnectorGrantReconciliationStatusSchema = z.enum([
  'ready',
  'migration_needs_reconcile',
]);
/** Reconciliation state for operation-level grants on a connection. */
export type ConnectorGrantReconciliationStatus = z.infer<
  typeof ConnectorGrantReconciliationStatusSchema
>;

/** Security classification frozen into an immutable operation revision. */
export const ConnectorOperationClassificationSchema = z.enum(['read', 'write', 'destructive']);
/** Security classification frozen into an immutable operation revision. */
export type ConnectorOperationClassification = z.infer<
  typeof ConnectorOperationClassificationSchema
>;

/**
 * An access level the owner gives an agent, or every agent, on one account:
 * `read` is every action the app lets agents read, and `read-write` adds every
 * action that changes something there. A level is stored as the owner's
 * intent, not as a snapshot of today's actions, so actions the app adds or
 * reclassifies join or leave it by class, and it never covers more than its
 * classes (ADR 260929-071355). No level ever covers a `destructive` action;
 * that is only ever allowed one action at a time.
 */
export const ConnectorAccessLevelSchema = z.enum(['read', 'read-write']);
/** An access level the owner gives on one account. */
export type ConnectorAccessLevel = z.infer<typeof ConnectorAccessLevelSchema>;

/**
 * Whether an access level covers an action of this safety classification:
 * "Read" is `read` only, "Read and write" adds `write`, and no level covers
 * `destructive`. The one rule the server grants and follows levels with, and
 * every screen describing a level reads.
 *
 * @param classification - The action's stored safety classification.
 * @param level - The access level, or `'none'`.
 */
export function levelIncludes(
  classification: ConnectorOperationClassification,
  level: 'none' | ConnectorAccessLevel
): boolean {
  if (level === 'none') return false;
  return classification === 'read' || (level === 'read-write' && classification === 'write');
}

/** Provider-acknowledged retry behavior frozen into an operation revision. */
export const ConnectorRetryPolicySchema = z.enum(['never', 'provider_idempotency_key']);
/** Provider-acknowledged retry behavior frozen into an operation revision. */
export type ConnectorRetryPolicy = z.infer<typeof ConnectorRetryPolicySchema>;

/** One immutable operation schema discovered from a provider. */
export const ConnectorOperationRevisionSchema = z.object({
  id: z.string().min(1),
  providerInstanceId: ConnectorProviderInstanceIdSchema,
  toolkit: z.string().min(1),
  operationSlug: z.string().min(1),
  toolkitVersion: z.string().min(1),
  schemaHash: z.string().min(1),
  capabilityClassification: ConnectorOperationClassificationSchema,
  retryPolicy: ConnectorRetryPolicySchema,
  inputSchema: z.record(z.string(), z.unknown()),
  discoveredAt: z.string().datetime(),
});
/** One immutable operation schema discovered from a provider. */
export type ConnectorOperationRevision = z.infer<typeof ConnectorOperationRevisionSchema>;

/** Cursor page returned by provider discovery. */
export const ConnectorOperationPageSchema = z.object({
  operations: z.array(
    ConnectorOperationRevisionSchema.omit({ id: true, discoveredAt: true }).extend({
      // Private upstream revision identity, never included in public revision DTOs.
      providerRevisionRef: z.string().min(1).max(500).optional(),
      // Presentation hints only. Neither is part of a revision's identity, its
      // stored row, or its safety classification.
      /** The service's own display name for the operation, when it gives one. */
      displayName: z.string().min(1).max(200).optional(),
      /** True when the service marks the operation as one of its main ones. */
      important: z.boolean().optional(),
    })
  ),
  nextCursor: z.string().min(1).optional(),
  truncated: z.boolean(),
});
/** Cursor page returned by provider discovery. */
export type ConnectorOperationPage = z.infer<typeof ConnectorOperationPageSchema>;

/** A provider capability is either available or honestly unsupported. */
export const ConnectorCapabilityAvailabilitySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available') }),
  z.object({ status: z.literal('unsupported'), reason: z.string().min(1) }),
]);
/** A provider capability is either available or honestly unsupported. */
export type ConnectorCapabilityAvailability = z.infer<typeof ConnectorCapabilityAvailabilitySchema>;

/** Typed result used when a provider does not implement a declared capability. */
export const ConnectorUnsupportedResultSchema = z.object({
  status: z.literal('unsupported'),
  reason: z.string().min(1),
});
/** Typed result used when a provider does not implement a declared capability. */
export type ConnectorUnsupportedResult = z.infer<typeof ConnectorUnsupportedResultSchema>;

/** Capability declaration for the instance-bound provider port. */
export const ConnectorProviderCapabilitySetSchema = z.object({
  catalog: ConnectorCapabilityAvailabilitySchema,
  authentication: ConnectorCapabilityAvailabilitySchema,
  accounts: ConnectorCapabilityAvailabilitySchema,
  operations: ConnectorCapabilityAvailabilitySchema,
  execution: ConnectorCapabilityAvailabilitySchema,
  triggers: ConnectorCapabilityAvailabilitySchema,
});
/** Capability declaration for the instance-bound provider port. */
export type ConnectorProviderCapabilitySet = z.infer<typeof ConnectorProviderCapabilitySetSchema>;

/** Request for one bounded page of provider catalog results. */
export interface ConnectorCatalogPageRequest {
  /** Optional provider cursor from the preceding page. */
  cursor?: string;
  /** Maximum results requested from the provider. */
  limit: number;
  /** Cancels account-free discovery when its server-owned deadline expires. */
  signal: AbortSignal;
}

/** Request for one bounded page of provider operation schemas. */
export interface ConnectorOperationPageRequest {
  /** Toolkit whose operations are being discovered. */
  toolkit: string;
  /** Exact version selected from trusted provider catalog metadata. */
  toolkitVersion: string;
  /** Optional provider cursor from the preceding page. */
  cursor?: string;
  /** Maximum results requested from the provider. */
  limit: number;
  /** Cancels schema discovery when its server-owned deadline expires. */
  signal: AbortSignal;
}

/** Trusted provider metadata that pins operation discovery to one toolkit version. */
export const ConnectorToolkitVersionResultSchema = z
  .object({
    status: z.literal('ok'),
    toolkit: z.string().min(1),
    toolkitVersion: z.string().min(1),
  })
  .strict();
/** Trusted provider metadata that pins operation discovery to one toolkit version. */
export type ConnectorToolkitVersionResult = z.infer<typeof ConnectorToolkitVersionResultSchema>;

/** Exact provider operation call after private connection resolution. */
export interface ConnectorProviderExecuteCommand {
  /** Private provider account selected by the DorkOS connection. */
  externalAccountRef: ConnectorExternalAccountRef;
  /** Immutable operation revision selected by the grant. */
  operation: ConnectorOperationRevision;
  /** Validated arguments for the frozen input schema. */
  arguments: Record<string, unknown>;
  /** Stable id shared by retries of one logical call. */
  logicalOperationId: string;
  /** Unique id for this provider attempt. */
  attemptId: string;
  /** Stable provider key reused only by a revision whose pinned policy allows it. */
  upstreamIdempotencyKey?: string;
  /** Cancels provider work when the caller deadline expires. */
  signal: AbortSignal;
  /**
   * Revalidates server-owned authority at the provider's last safe boundary.
   *
   * Providers call this after every account/schema preflight await and directly
   * before an irreversible upstream request. It is created by the broker and is
   * never accepted from an HTTP, CLI, MCP, or other public request.
   */
  authorizeDispatch: () => boolean | Promise<boolean>;
}

/** Normalized result of one provider execution attempt. */
export const ConnectorProviderExecuteResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('success'),
      data: z.unknown(),
      providerLogId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('error'),
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean(),
      providerLogId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('cancelled'),
      code: z.literal('CANCELLED_BEFORE_DISPATCH'),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('outcome_unknown'),
      code: z.string().min(1),
      message: z.string().min(1),
      providerLogId: z.string().min(1).optional(),
    })
    .strict(),
  ConnectorUnsupportedResultSchema.strict(),
]);
/** Normalized result of one provider execution attempt. */
export type ConnectorProviderExecuteResult = z.infer<typeof ConnectorProviderExecuteResultSchema>;

/** Public reference for an opaque provider authentication flow. */
export const ConnectorAuthenticationFlowSchema = z
  .object({
    authorizeUrl: z.string().url().optional(),
    flowId: z.string().min(1),
  })
  .strict();
/** Public reference for an opaque provider authentication flow. */
export type ConnectorAuthenticationFlow = z.infer<typeof ConnectorAuthenticationFlowSchema>;

/** Public execution target; all private routing and authority are server-derived. */
export const ConnectorExecutionTargetSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    operationRevisionId: z.string().min(1),
    arguments: ConnectorJsonObjectSchema,
  })
  .strict();
/** Public execution target; all private routing and authority are server-derived. */
export type ConnectorExecutionTarget = z.infer<typeof ConnectorExecutionTargetSchema>;

/** Program execution input, which must declare the owned agent whose grants apply. */
export const ConnectorProgramExecutionRequestSchema = ConnectorExecutionTargetSchema.extend({
  agentId: z.string().min(1),
}).strict();
/** Program execution input, which must declare the owned agent whose grants apply. */
export type ConnectorProgramExecutionRequest = z.infer<
  typeof ConnectorProgramExecutionRequestSchema
>;

/** Secret-free public result of one logical connector operation. */
export const ConnectorExecutionPublicResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('success'), data: z.unknown() }).strict(),
  z
    .object({
      status: z.literal('error'),
      code: z.string().min(1),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('cancelled'),
      code: z.literal('CANCELLED_BEFORE_DISPATCH'),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('outcome_unknown'),
      code: z.string().min(1),
      message: z.string().min(1),
    })
    .strict(),
  ConnectorUnsupportedResultSchema.strict(),
]);
/** Secret-free public result of one logical connector operation. */
export type ConnectorExecutionPublicResult = z.infer<typeof ConnectorExecutionPublicResultSchema>;

/** Public response after at least one immutable attempt intent was persisted. */
export const ConnectorExecutionResponseSchema = z
  .object({
    logicalOperationId: z.string().min(1),
    attemptCount: z.number().int().min(1).max(2),
    result: ConnectorExecutionPublicResultSchema,
  })
  .strict();
/** Public response after at least one immutable attempt intent was persisted. */
export type ConnectorExecutionResponse = z.infer<typeof ConnectorExecutionResponseSchema>;

/**
 * Whether agents can use one connected account right now, at a glance.
 *
 * - `ready` — agents can use it now. The only state shown green.
 * - `paused` — the person turned it off; resuming it brings it back.
 * - `needs_you` — it stopped working and one thing the person does fixes it.
 * - `finishing` — DorkOS is still working on a change; nothing to do but wait.
 * - `unavailable` — it can't be used right now and nobody can change that from
 *   here right away (a way that isn't answering, a way that can't run
 *   actions, an account turned off for one chat).
 * - `gone` — it was disconnected. Agents can't use it.
 */
export const ConnectionReadinessStateSchema = z.enum([
  'ready',
  'paused',
  'needs_you',
  'finishing',
  'unavailable',
  'gone',
]);
/** Whether agents can use one connected account right now, at a glance. */
export type ConnectionReadinessState = z.infer<typeof ConnectionReadinessStateSchema>;

/**
 * Why one connected account is in its readiness state. A closed set: the
 * server's readiness function (`deriveConnectionReadiness`) is the only place
 * that picks one, and its truth table documents the facts behind each.
 */
export const ConnectionReadinessReasonSchema = z.enum([
  /** Agents can use it now. */
  'usable',
  /** Turned off for this one chat, so its agent can't use it here. */
  'off_for_this_chat',
  /** Connected through a DorkOS account that isn't linked anymore. */
  'dorkos_account_unlinked',
  /** Connected through a DorkOS account that can't reach apps right now. */
  'dorkos_account_unavailable',
  /** Connected through the person's own key, which isn't set up or didn't answer. */
  'own_key_unavailable',
  /** The way it was connected through isn't reachable, and DorkOS can't name a fix. */
  'way_unreachable',
  /** Connected through the person's own key, which signs in but can't run actions. */
  'own_key_cannot_run_actions',
  /** Connected a way that can sign in but can never run actions. */
  'cannot_run_actions',
  /** The person paused it. */
  'paused',
  /** Paused while the person signs in to it again; finishing that sign-in brings it back. */
  'signing_in',
  /** The sign-in ended at the service (expired or revoked). */
  'signed_out',
  /** A sign-in started and never finished. */
  'sign_in_unfinished',
  /** Who can use it has to be checked again before agents can use it. */
  'needs_review',
  /** A change to who can use it did not go through. */
  'access_update_failed',
  /** A change to who can use it is still being applied. */
  'access_updating',
  /** Disconnected, and nothing is owed at the service. */
  'disconnected',
  /** Disconnected, and DorkOS is still removing its access at the service. */
  'disconnect_finishing',
  /** Disconnected, and DorkOS can't finish removing its access at the service right now. */
  'disconnect_stuck',
  /** Closed because the service said the account no longer exists there. */
  'gone_at_service',
]);
/** Why one connected account is in its readiness state. */
export type ConnectionReadinessReason = z.infer<typeof ConnectionReadinessReasonSchema>;

/**
 * The one fix for an account that is not ready, as the one control that makes
 * it. A closed set every surface maps to exactly one control.
 *
 * - `sign_in_again` — sign in to this same account again.
 * - `connect_again` — connect this same, disconnected account again.
 * - `connect_new` — connect the app again through a way that works (the
 *   one-time "how DorkOS reaches apps" step first when none does).
 * - `resume` — resume the paused account.
 * - `review_access` — check who can use it.
 * - `fix_key` — fix the person's own key (Settings › Connections).
 * - `retry` — try the unfinished step again now.
 * - `remove` — remove the disconnected account from the person's apps. What
 *   DorkOS still owes at the service stays DorkOS's job in the background.
 * - `wait` — nothing to press: DorkOS tries again on its own.
 * - `turn_on_for_this_chat` — turn the app back on for this one chat. Offered
 *   only in the owner's view of a chat, and only when turning it on puts back
 *   access the chat had (it never adds any).
 */
export const ConnectionFixActionSchema = z.enum([
  'sign_in_again',
  'connect_again',
  'connect_new',
  'resume',
  'review_access',
  'fix_key',
  'retry',
  'remove',
  'wait',
  'turn_on_for_this_chat',
]);
/** The one fix for an account that is not ready. */
export type ConnectionFixAction = z.infer<typeof ConnectionFixActionSchema>;

/** The one fix, who can make it, and when DorkOS tries again on its own. */
export const ConnectionFixSchema = z
  .object({
    action: ConnectionFixActionSchema,
    /** `person` when only the person can make it; `dorkos` when DorkOS makes it on its own. */
    fixableBy: z.enum(['person', 'dorkos']),
    /** When DorkOS tries again on its own, when it knows. */
    retryAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((fix) => fix.action !== 'wait' || fix.fixableBy === 'dorkos', {
    message: 'Waiting is DorkOS’s job, never the person’s.',
  });
/** The one fix, who can make it, and when DorkOS tries again on its own. */
export type ConnectionFix = z.infer<typeof ConnectionFixSchema>;

/**
 * Whether agents can use one connected account right now and, if not, the one
 * fix and who can make it, with the words for the owner and for the agent.
 * Computed once on the server; every surface renders it and none re-derives it.
 */
export const ConnectionReadinessSchema = z
  .object({
    state: ConnectionReadinessStateSchema,
    reason: ConnectionReadinessReasonSchema,
    /** Absent when there is nothing to fix, or nothing anyone can do from here. */
    fix: ConnectionFixSchema.optional(),
    /**
     * Where the person can end DorkOS's access at the service themselves, when
     * DorkOS can't finish that on its own and the page is known.
     */
    serviceAccessPage: z
      .object({
        /** Whose account settings the page is, e.g. "Google". */
        service: z.string().min(1).max(100),
        url: z.string().url(),
      })
      .strict()
      .optional(),
    copy: z
      .object({
        /** One plain line for the account's owner. */
        owner: z.string().min(1).max(500),
        /** What an agent reads: why it can't use the account, and what the person must do. */
        agent: z.string().min(1).max(1_000),
      })
      .strict(),
  })
  .strict()
  .refine((readiness) => (readiness.state === 'ready') === (readiness.reason === 'usable'), {
    message: 'Only a usable account is ready.',
  })
  .refine((readiness) => readiness.state !== 'ready' || readiness.fix === undefined, {
    message: 'A ready account has nothing to fix.',
  });
/** Whether agents can use one connected account right now, and the one fix if not. */
export type ConnectionReadiness = z.infer<typeof ConnectionReadinessSchema>;

/** One readiness reason's words: for the owner, and for an agent. */
export interface ConnectionReadinessCopy {
  readonly owner: string;
  readonly agent: string;
}

const READINESS_ASK_ON_CONNECTIONS = 'on the Connections page in the DorkOS app';
/** What an agent reads about an account the person disconnected. */
export const CONNECTION_GONE_AGENT_COPY =
  'The person disconnected this account. Ask them to connect it again if you need it.';

/**
 * Every line readiness says, in one place: the server's readiness function is
 * its one reader (tests read it too, so a mock never copies a string). Owner
 * lines sit under the app's name, so they say "it". Agent lines say what the
 * person must do.
 */
export const CONNECTION_READINESS_COPY: Readonly<
  Record<Exclude<ConnectionReadinessReason, 'disconnect_stuck'>, ConnectionReadinessCopy>
> = {
  usable: {
    owner: 'Agents can use it.',
    agent: 'You can use this account.',
  },
  off_for_this_chat: {
    owner: 'Turned off for this chat.',
    agent:
      'The person turned this account off for this chat, so you can’t use it here. Don’t ask for it again in this chat.',
  },
  // Linking this computer again with the same DorkOS account can continue its
  // earlier link, and so bring the account back (DOR-2521); never promised.
  dorkos_account_unlinked: {
    owner:
      'It was connected through your DorkOS account, which isn’t linked anymore. Linking this computer again with the same ' +
      'DorkOS account can bring it back, unless its earlier link was removed from that account. Otherwise, connect it again.',
    agent:
      'It was connected through the person’s DorkOS account, which isn’t linked anymore. Linking this computer again with the ' +
      'same DorkOS account (Settings › Access in the DorkOS app) can bring it back, unless its earlier link was removed from ' +
      'that account. A different account, or a link made on another computer, does not bring it back: then ask the person to ' +
      `connect this app again ${READINESS_ASK_ON_CONNECTIONS}.`,
  },
  dorkos_account_unavailable: {
    owner: 'Your DorkOS account can’t reach it right now, so agents can’t use it.',
    agent:
      'It was connected through the person’s DorkOS account, which can’t reach apps right now. Try again later. The person doesn’t need to do anything.',
  },
  own_key_unavailable: {
    owner: 'The key it was connected through isn’t set up or didn’t answer. Fix the key to use it.',
    agent:
      'It was connected through the person’s own key, which isn’t set up or didn’t answer when DorkOS last checked it. ' +
      'Ask the person to fix the key in Settings › Connections in the DorkOS app.',
  },
  way_unreachable: {
    owner: 'DorkOS can’t reach the service it was connected through, so agents can’t use it.',
    agent:
      'DorkOS can’t reach the service this account was connected through. Asking for access won’t help.',
  },
  own_key_cannot_run_actions: {
    owner:
      'Agents can’t use it: your key can sign in to apps but can’t run their actions. Change it to a project key.',
    agent:
      'The person’s own key can sign in to apps but can’t run their actions. Ask the person to change it to a project key in Settings › Connections in the DorkOS app.',
  },
  cannot_run_actions: {
    owner: 'Agents can’t use apps connected this way yet.',
    agent: 'Agents can’t use apps connected the way this one was. Asking for access won’t help.',
  },
  paused: {
    owner: 'Paused. Agents can’t use it until you resume it.',
    agent: `The person paused this account. Ask them to resume it ${READINESS_ASK_ON_CONNECTIONS}.`,
  },
  signing_in: {
    owner: 'Finish signing in again. Agents can’t use it until you do.',
    agent: `The person is signing in to this account again. Ask them to finish signing in ${READINESS_ASK_ON_CONNECTIONS}.`,
  },
  signed_out: {
    owner: 'Signed out. Agents can’t use it until you sign in again.',
    agent: `The sign-in for this account ended. Ask the person to sign in again ${READINESS_ASK_ON_CONNECTIONS}.`,
  },
  sign_in_unfinished: {
    owner: 'Sign-in didn’t finish. Agents can’t use it until you sign in again.',
    agent: `The sign-in for this account didn’t finish. Ask the person to sign in again ${READINESS_ASK_ON_CONNECTIONS}.`,
  },
  needs_review: {
    owner:
      'How DorkOS reaches it changed, so check who can use it. Agents can’t use it until you do.',
    agent: `How DorkOS reaches this account changed, so the person needs to confirm who can use it before agents can use it again. Ask them to check it ${READINESS_ASK_ON_CONNECTIONS}.`,
  },
  access_update_failed: {
    owner: 'A change to who can use it didn’t go through. Check who can use it.',
    agent: `A change to who can use this account didn’t go through. Ask the person to check it ${READINESS_ASK_ON_CONNECTIONS}.`,
  },
  access_updating: {
    owner: 'Updating who can use it…',
    agent:
      'DorkOS is still updating who can use this account. Try again in a few minutes. The person doesn’t need to do anything.',
  },
  disconnected: {
    owner: 'Disconnected. Agents can’t use it.',
    agent: CONNECTION_GONE_AGENT_COPY,
  },
  disconnect_finishing: {
    owner: 'Disconnected. Agents can’t use it. DorkOS is still removing its access at the service.',
    agent: CONNECTION_GONE_AGENT_COPY,
  },
  gone_at_service: {
    owner:
      'Your DorkOS account no longer has this connection, so agents can’t use it. Connect it again to use it. To be sure its old access ended, remove it in that app’s own account settings.',
    agent:
      'The person’s DorkOS account no longer has this connection. Ask the person to connect it again if you need it.',
  },
};

/** Why DorkOS can't finish removing a disconnected account's access at the service. */
export type ConnectionDisconnectStuckCause =
  | 'own_key_unavailable'
  | 'dorkos_account_unlinked'
  | 'dorkos_account_unavailable'
  | 'unreachable'
  | 'unconfirmed';

/**
 * The owner's line for a disconnect DorkOS can't finish right now, by why it
 * can't: the one thing the person can do, or where they can finish it
 * themselves.
 *
 * @param cause - Why it can't finish.
 */
export function disconnectStuckOwnerLine(cause: ConnectionDisconnectStuckCause): string {
  const lead = 'Disconnected. Agents can’t use it.';
  const ownSettings = 'To be sure its access ended, remove it in that app’s own account settings.';
  switch (cause) {
    case 'own_key_unavailable':
      return `${lead} DorkOS can’t finish removing its access at the service until the key it was connected through works again. Add that same key again and DorkOS finishes it on its own.`;
    case 'dorkos_account_unlinked':
      return `${lead} DorkOS can’t finish removing its access at the service, because your DorkOS account isn’t linked anymore. Link this computer to the same DorkOS account again and DorkOS finishes it on its own. ${ownSettings}`;
    case 'unconfirmed':
      return `${lead} DorkOS couldn’t confirm its access ended at the service. ${ownSettings}`;
    case 'dorkos_account_unavailable':
    case 'unreachable':
      return `${lead} DorkOS can’t reach the service to finish removing its access. ${ownSettings}`;
  }
}

/**
 * The words for an account whose own key didn't answer for a reason that may
 * pass (a timeout, an outage): DorkOS checks it again on its own.
 */
export const WAY_RECHECK_COPY: ConnectionReadinessCopy = {
  owner: 'The key it was connected through didn’t answer. DorkOS checks it again on its own.',
  agent:
    'The way this account was connected through didn’t answer. DorkOS checks it again on its own, so try again in a few minutes. The person doesn’t need to do anything.',
};

/**
 * The words for an account whose way DorkOS is checking right now, or will
 * check again on its own before long: nothing for anyone to press yet.
 */
export const WAY_CHECKING_COPY: ConnectionReadinessCopy = {
  owner: 'DorkOS is checking how it reaches it. This takes a moment.',
  agent:
    'DorkOS is checking how it reaches this account. Try again in a few minutes. The person doesn’t need to do anything.',
};

/**
 * Pages where a person can end an app's access to their account themselves,
 * by the account's service. Only pages known to hold that setting are listed;
 * an app missing here gets the plain line with no link.
 */
const SERVICE_ACCESS_PAGES: Readonly<Record<string, { service: string; url: string }>> = {
  google: { service: 'Google', url: 'https://myaccount.google.com/connections' },
  github: { service: 'GitHub', url: 'https://github.com/settings/applications' },
  dropbox: { service: 'Dropbox', url: 'https://www.dropbox.com/account/connected_apps' },
};

/** Which account service each app signs in through, for the apps whose page is known. */
const SERVICE_OF_APP: Readonly<Record<string, keyof typeof SERVICE_ACCESS_PAGES>> = {
  gmail: 'google',
  googlecalendar: 'google',
  googledocs: 'google',
  googlesheets: 'google',
  googledrive: 'google',
  github: 'github',
  dropbox: 'dropbox',
};

/**
 * Where the person can end DorkOS's access to one app's account themselves,
 * when that page is known.
 *
 * @param toolkit - The app's slug, e.g. `'gmail'`.
 */
export function serviceAccessPageFor(
  toolkit: string
): { readonly service: string; readonly url: string } | undefined {
  const service = SERVICE_OF_APP[toolkit];
  return service === undefined ? undefined : SERVICE_ACCESS_PAGES[service];
}

/**
 * What an agent is told to do about an account nothing fixes from here: tell
 * the person. Added only when no concrete fix sentence follows.
 */
export const TELL_THE_PERSON_AGENT_COPY = 'Tell the person.';

/**
 * The words added when an account connected a way that can't be used offers
 * connecting it again, because another way works.
 */
export const CONNECT_ANOTHER_WAY_COPY: ConnectionReadinessCopy = {
  owner: 'Connect it again another way to use it.',
  agent:
    'Ask the person to connect it again another way on the Connections page in the DorkOS app.',
};

/**
 * The words added when the owner can turn an app back on for one chat. The
 * agent line is unchanged: an agent never reads the owner's chat view, and it
 * should not ask for an app the person turned off.
 */
export const TURN_ON_FOR_THIS_CHAT_COPY: Partial<ConnectionReadinessCopy> = {
  owner: 'Turn it on to let this agent use it here again.',
};

/**
 * Why a way can't do something at all, in the words a person or agent reads
 * wherever the way's abilities are shown (the connect dialog, the access
 * review, an agent's tool result). Each way's code states its limits with
 * these lines, never its own.
 */
export const WAY_CAPABILITY_COPY = {
  /** The way signs in to apps but can't run their actions. */
  cannotRunActions: 'Agents can’t use apps connected this way yet.',
  /** The way can't say which actions an app offers. */
  cannotListActions: 'DorkOS can’t list what an app can do when it’s connected this way.',
  /** The way can't deliver notifications from apps. */
  noNotifications: 'Notifications aren’t available for apps connected this way.',
  /** A person's own Composio key is an account key, which can't run actions. */
  accountKeyCannotRunActions:
    'This key can sign in to apps but can’t run their actions. Change it to a project key from your Composio dashboard.',
} as const;

/**
 * Why a waiting approval or request was cancelled because the access behind
 * it ended. A person reads it on the approval or request; an agent reads it
 * as the answer to what it was waiting for.
 */
export const ACCESS_ENDED_COPY = {
  /** The account was disconnected. */
  connection_removed: 'The account was disconnected, so this was cancelled.',
  /** The agent was removed. */
  agent_removed: 'The agent was removed, so this was cancelled.',
  /** The agent's access to the account was taken away. */
  agent_connection_removed:
    'The agent’s access to this account was removed, so this was cancelled.',
} as const;

/**
 * What a person reads under one of their own keys when DorkOS's last check of
 * it failed. The service's own error text goes to the log, never here.
 */
export const KEY_CHECK_COPY = {
  /** The service turned the key down (it answered 401 or 403). */
  refused: 'The service turned this key down. Check it’s the right key, then save it again.',
  /** The check failed a way that can pass, and DorkOS has a re-check scheduled. */
  checkingAgain: 'DorkOS couldn’t check this key just now. It checks again on its own.',
  /** The check failed and DorkOS has stopped checking on its own. */
  stoppedChecking:
    'DorkOS couldn’t check this key and has stopped trying on its own. Save it again to check it now.',
  /**
   * Nothing answered at the service's address (a name that doesn't resolve, a
   * refused connection, a 404 on the base address).
   *
   * @param type - The way's type: `'nango'` names the person's own server.
   * @param recheckScheduled - Whether DorkOS will check it again on its own.
   */
  unreachable(type: string, recheckScheduled: boolean): string {
    const lead =
      type === 'nango'
        ? 'DorkOS couldn’t reach your Nango server.'
        : 'DorkOS couldn’t reach Composio.';
    if (recheckScheduled) return `${lead} It checks again on its own.`;
    return type === 'nango'
      ? `${lead} Check that it’s running and its address is right, then save the key again.`
      : `${lead} Check your internet connection, then save the key again.`;
  },
} as const;

/**
 * What a person reads when a change to who can use an account can't be sent
 * because this computer's DorkOS account link is gone.
 */
export const LINK_NEEDED_TO_CHANGE_ACCESS_COPY =
  'DorkOS can’t change who uses this account until this computer is linked to your DorkOS account again. Link it in Settings › Access, then try again.';

/**
 * What a person reads when a sign-in can't start or doesn't finish. The
 * server's sign-in flow is the one writer; the connect dialog shows the line.
 */
export const SIGN_IN_COPY = {
  /** The way changed, or stopped answering, while the person was signing in. */
  wayChanged:
    'The way DorkOS reaches this app changed or stopped working while you were signing in. Start again.',
  /** The way isn't set up, or isn't working, so a sign-in can't start. */
  wayUnavailable:
    'The way DorkOS reaches this app isn’t set up or isn’t working right now. Check it in Settings › Connections, then try again.',
  /** The service said the sign-in didn't finish. */
  failed: 'Sign-in didn’t finish. Try again.',
} as const;

/** The service behind each way, by the way's type: what its key or server is called. */
const SERVICE_NAMES: Readonly<Record<string, string>> = {
  'dorkos-managed': 'DorkOS',
  composio: 'Composio',
  nango: 'Nango',
  mcp: 'MCP',
  'test-connector': 'Test connector',
};

/**
 * How a person knows each way DorkOS reaches apps, by the way's type. Every
 * surface that names a way (Settings › Connections, "How it's connected", the
 * connect dialog, the catalog's warnings, an agent's recommendation) reads it
 * from here, and the server works it out from the stored type when it reads a
 * way, so a stored raw name never reaches anyone.
 */
const WAY_NAMES: Readonly<Record<string, string>> = {
  'dorkos-managed': 'Your DorkOS account',
  composio: 'Your Composio key',
  nango: 'Your Nango server',
  // Raw MCP talks straight to the app's own server, never one the person runs.
  mcp: 'The app’s own MCP server',
  'test-connector': 'Your test key',
};

/** "Composio" from `composio`; an unknown type is title-cased. */
function titleCase(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * The name of the service behind a way, for a key's own label ("Composio
 * project key", "Nango API key"). An unknown type is title-cased.
 *
 * @param type - The way's type, e.g. `'composio'`.
 */
export function connectionServiceName(type: string): string {
  return SERVICE_NAMES[type] ?? titleCase(type);
}

/**
 * The plain name of one way DorkOS reaches apps. An unknown type is named as
 * one of the person's own keys rather than shown as a raw slug.
 *
 * @param type - The way's type, e.g. `'composio'` or `'dorkos-managed'`.
 */
export function connectionWayName(type: string): string {
  return WAY_NAMES[type] ?? `Your ${titleCase(type)} key`;
}

/**
 * The one line about who pays for an app's use, or `null` when nobody bills
 * for it: a self-hosted Nango server or an MCP server is the person's own, so
 * there is no bill to name. Only the DorkOS-account way and a person's own
 * Composio key have one.
 *
 * @param route - The way's payer and where its sign-ins are kept.
 */
export function connectionUsageLine(route: {
  readonly payer: 'operator_byo' | 'dorkos_managed';
  readonly custody: 'managed' | 'self-host' | 'external';
}): string | null {
  if (route.payer === 'dorkos_managed') return 'Your DorkOS account covers its use.';
  // Composio keeps the sign-in (managed custody) on a person's own key.
  if (route.custody === 'managed') return 'Any usage charges go to your own Composio account.';
  return null;
}

/**
 * Plain words for what one app action can do, shown in place of its stored
 * class. `destructive` is "High risk", never "Delete": the service marks
 * sending, sharing, forwarding and actions it hasn't sorted as destructive
 * too, so all the words can promise is that it needs more care.
 */
export const OPERATION_CLASSIFICATION_LABELS: Readonly<
  Record<ConnectorOperationClassification, string>
> = {
  read: 'Read',
  write: 'Write',
  destructive: 'High risk',
};

/**
 * What a set of action kinds lets an agent do, in words: `read`,
 * `read and write`, `read, write and high-risk actions`. Never "delete": the
 * service marks sending and sharing destructive too. The app and the server's
 * Activity entries both read it here.
 *
 * @param classifications - The kinds of the granted actions.
 */
export function connectionAccessWords(
  classifications: readonly ConnectorOperationClassification[]
): string {
  const words = (['read', 'write', 'destructive'] as const)
    .filter((kind) => classifications.includes(kind))
    .map((kind) => (kind === 'destructive' ? 'high-risk actions' : kind));
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** Plain words for a connected account's sign-in state, shown in place of its stored value. */
export const CONNECTION_STATUS_LABELS: Readonly<
  Record<'active' | 'expired' | 'revoked' | 'pending' | 'paused', string>
> = {
  active: 'Connected',
  expired: 'Signed out',
  revoked: 'Disconnected',
  pending: 'Signing in',
  paused: 'Paused',
};

/** Connection metadata visible to an agent that already holds access. */
export const AccessibleConnectorConnectionSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    toolkit: z.string().min(1),
    label: z.string().min(1),
    status: z.enum(['active', 'expired', 'revoked', 'pending', 'paused']),
    custody: z.enum(['managed', 'self-host', 'external']),
    reconciliationStatus: ConnectorGrantReconciliationStatusSchema,
  })
  .strict();
/** Connection metadata visible to an agent that already holds access. */
export type AccessibleConnectorConnection = z.infer<typeof AccessibleConnectorConnectionSchema>;

/** Immutable operation revision visible to an agent that already holds its grant. */
export const AccessibleConnectorOperationSchema = z
  .object({
    operationRevisionId: z.string().min(1),
    toolkit: z.string().min(1),
    operationSlug: z.string().min(1),
    toolkitVersion: z.string().min(1),
    capabilityClassification: ConnectorOperationClassificationSchema,
    retryPolicy: ConnectorRetryPolicySchema,
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();
/** Immutable operation revision visible to an agent that already holds its grant. */
export type AccessibleConnectorOperation = z.infer<typeof AccessibleConnectorOperationSchema>;

/** Agent-scoped connection list response. */
export const ConnectorAccessibleConnectionsResponseSchema = z
  .object({
    connections: z.array(AccessibleConnectorConnectionSchema),
    /**
     * Accounts this agent was given that it cannot use right now: paused,
     * signed out, waiting on a review, turned off for this chat, or reached
     * through a way that is down or can't run actions. Each note says why, and
     * what the person must do.
     */
    unavailable: z
      .array(
        z
          .object({
            connectionId: ConnectionIdSchema,
            toolkit: z.string().min(1),
            label: z.string().min(1),
            reason: ConnectionReadinessReasonSchema,
            note: z.string().min(1),
          })
          .strict()
      )
      .optional(),
  })
  .strict();
/** Agent-scoped connection list response. */
export type ConnectorAccessibleConnectionsResponse = z.infer<
  typeof ConnectorAccessibleConnectionsResponseSchema
>;

/** Agent-scoped operation list response for one stable connection. */
export const ConnectorAccessibleOperationsResponseSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    operations: z.array(AccessibleConnectorOperationSchema),
  })
  .strict();
/** Agent-scoped operation list response for one stable connection. */
export type ConnectorAccessibleOperationsResponse = z.infer<
  typeof ConnectorAccessibleOperationsResponseSchema
>;

/** Public usage item with immutable attribution and no arguments, result, or provider log id. */
export const ConnectorUsageItemSchema = z
  .object({
    logicalOperationId: z.string().min(1),
    attemptIndex: z.number().int().positive(),
    surface: z.enum(['mcp', 'rest', 'cli', 'event']),
    actorKind: z.enum(['operator', 'agent', 'program', 'event', 'runtime']),
    agentId: z.string().min(1).optional(),
    connectionId: ConnectionIdSchema,
    toolkit: z.string().min(1),
    operationRevisionId: z.string().min(1),
    operationSlug: z.string().min(1),
    payer: z.enum(['operator_byo', 'dorkos_managed']),
    outcome: z.enum(['success', 'error', 'cancelled', 'outcome_unknown', 'unsupported']).optional(),
    errorCode: z.string().min(1).optional(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();
/** Public usage item with immutable attribution and no arguments, result, or provider log id. */
export type ConnectorUsageItem = z.infer<typeof ConnectorUsageItemSchema>;

/** Cursor page of connector usage. */
export const ConnectorUsagePageSchema = z
  .object({
    items: z.array(ConnectorUsageItemSchema),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();
/** Cursor page of connector usage. */
export type ConnectorUsagePage = z.infer<typeof ConnectorUsagePageSchema>;

/** Owner request to prepare an exact grant reconciliation snapshot. */
export const ConnectorReconciliationPreviewRequestSchema = z
  .object({ connectionId: ConnectionIdSchema })
  .strict();
/** Owner request to prepare an exact grant reconciliation snapshot. */
export type ConnectorReconciliationPreviewRequest = z.infer<
  typeof ConnectorReconciliationPreviewRequestSchema
>;

/**
 * Complete replacement set for one explicitly named agent. With a `level`, the
 * set is exactly that level's actions in the reviewed catalog, and the agent
 * keeps the level as the app changes; without one, the set is exact actions
 * that stay exactly as chosen.
 */
export const ConnectorReconciliationGrantSelectionSchema = z
  .object({
    agentId: z.string().min(1),
    operationRevisionIds: z.array(z.string().min(1)),
    level: ConnectorAccessLevelSchema.optional(),
  })
  .strict();
/** Complete replacement set for one explicitly named agent. */
export type ConnectorReconciliationGrantSelection = z.infer<
  typeof ConnectorReconciliationGrantSelectionSchema
>;

/**
 * Complete replacement set for the owner-wide "every agent" grant on one
 * connection (ADR 260926-192625). It covers every agent the owner has, including
 * agents added later, for exactly these reviewed revisions. An empty list turns
 * "every agent" off.
 */
export const ConnectorReconciliationEveryAgentSelectionSchema = z
  .object({
    operationRevisionIds: z.array(z.string().min(1)),
    /** The level these revisions are, kept as the app changes; absent for exact actions. */
    level: ConnectorAccessLevelSchema.optional(),
  })
  .strict();
/** Complete replacement set for the owner-wide "every agent" grant on one connection. */
export type ConnectorReconciliationEveryAgentSelection = z.infer<
  typeof ConnectorReconciliationEveryAgentSelectionSchema
>;

/**
 * The every-agent grant as a reconciliation snapshot sees it. `available` is
 * false where "every agent" cannot be offered for this connection (a connection
 * through a DorkOS account while this process cannot reach hosted authority),
 * and then `operationRevisionIds` is empty.
 */
export const ConnectorReconciliationEveryAgentStateSchema = z
  .object({
    available: z.boolean(),
    operationRevisionIds: z.array(z.string().min(1)),
    /** The level the owner chose for every agent; absent for exact actions or no sharing. */
    level: ConnectorAccessLevelSchema.optional(),
  })
  .strict();
/** The every-agent grant as a reconciliation snapshot sees it. */
export type ConnectorReconciliationEveryAgentState = z.infer<
  typeof ConnectorReconciliationEveryAgentStateSchema
>;

/** Result of stopping sharing one connection with every agent. */
export const ConnectorEveryAgentRevokeResponseSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    /** Shared actions that ended; zero when the connection was not shared. */
    revokedCount: z.number().int().nonnegative(),
  })
  .strict();
/** Result of stopping sharing one connection with every agent. */
export type ConnectorEveryAgentRevokeResponse = z.infer<
  typeof ConnectorEveryAgentRevokeResponseSchema
>;

/** One current agent included in a server-owned reconciliation snapshot. */
export const ConnectorReconciliationAgentSchema = z
  .object({
    agentId: z.string().min(1),
    displayName: z.string().min(1),
  })
  .strict();
/** One current agent included in a server-owned reconciliation snapshot. */
export type ConnectorReconciliationAgent = z.infer<typeof ConnectorReconciliationAgentSchema>;

/** One operation in a complete reconciliation snapshot. */
export const ConnectorReconciliationCandidateSchema = AccessibleConnectorOperationSchema.extend({
  supported: z.boolean(),
}).strict();
/** One operation in a complete reconciliation snapshot. */
export type ConnectorReconciliationCandidate = z.infer<
  typeof ConnectorReconciliationCandidateSchema
>;

/**
 * The exact revisions an access level covers in one complete snapshot: every
 * action the app still offers whose class the level includes
 * ({@link levelIncludes}), sorted. The server grants a level with exactly
 * this set, and re-derives it every time the catalog is read again, so a
 * level follows the app and never covers more than its classes.
 *
 * @param candidates - The snapshot's operations.
 * @param level - The access level, or `'none'`.
 */
export function accessLevelRevisionIds(
  candidates: ReadonlyArray<
    Pick<
      ConnectorReconciliationCandidate,
      'operationRevisionId' | 'capabilityClassification' | 'supported'
    >
  >,
  level: 'none' | ConnectorAccessLevel
): string[] {
  return candidates
    .filter(
      (candidate) => candidate.supported && levelIncludes(candidate.capabilityClassification, level)
    )
    .map((candidate) => candidate.operationRevisionId)
    .sort();
}

/** Server-owned complete catalog snapshot used for an exact grant decision. */
export const ConnectorReconciliationPreviewSchema = z
  .object({
    previewId: z.string().min(1),
    connection: AccessibleConnectorConnectionSchema,
    candidates: z.array(ConnectorReconciliationCandidateSchema),
    agents: z.array(ConnectorReconciliationAgentSchema),
    currentGrants: z.array(ConnectorReconciliationGrantSelectionSchema),
    everyAgent: ConnectorReconciliationEveryAgentStateSchema,
    catalogComplete: z.literal(true),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
/** Server-owned complete catalog snapshot used for an exact grant decision. */
export type ConnectorReconciliationPreview = z.infer<typeof ConnectorReconciliationPreviewSchema>;

/** Owner request to atomically consume a reconciliation preview. */
export const ConnectorReconciliationApplyRequestSchema = z
  .object({
    previewId: z.string().min(1),
    grants: z.array(ConnectorReconciliationGrantSelectionSchema),
    /** Replaces the every-agent grant when present; leaves it untouched when absent. */
    everyAgent: ConnectorReconciliationEveryAgentSelectionSchema.optional(),
  })
  .strict();
/** Owner request to atomically consume a reconciliation preview. */
export type ConnectorReconciliationApplyRequest = z.infer<
  typeof ConnectorReconciliationApplyRequestSchema
>;

/** Exact grant state written after a reconciliation preview is consumed. */
export const ConnectorReconciliationApplyResponseSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    reconciliationStatus: ConnectorGrantReconciliationStatusSchema,
    authoritySync: z.discriminatedUnion('status', [
      z.object({ status: z.literal('ready') }).strict(),
      z.object({ status: z.literal('pending') }).strict(),
      z.object({ status: z.literal('failed'), reason: z.string().min(1).max(1_000) }).strict(),
    ]),
    grants: z.array(ConnectorReconciliationGrantSelectionSchema),
    everyAgent: ConnectorReconciliationEveryAgentSelectionSchema.optional(),
  })
  .strict();
/** Exact grant state written after a reconciliation preview is consumed. */
export type ConnectorReconciliationApplyResponse = z.infer<
  typeof ConnectorReconciliationApplyResponseSchema
>;

const ReviewActionBaseSchema = z.object({ version: z.literal(1) }).strict();
const ConnectionTargetSchema = ReviewActionBaseSchema.extend({
  connectionId: ConnectionIdSchema,
}).strict();

/**
 * The access an agent asks for, by level rather than by action name: `read`
 * is everything the app lets agents read, and `read-write` adds everything
 * that changes something there. These are the same two levels the person
 * answers with ("Read", "Read and write"), so a request and its answer are
 * compared by class, never by guessed action names. No level covers an
 * action that can't be undone; that is only ever allowed one action at a time.
 */
export const ConnectorRequestAccessSchema = ConnectorAccessLevelSchema;
/** The access an agent asks for, by level. */
export type ConnectorRequestAccess = z.infer<typeof ConnectorRequestAccessSchema>;

/**
 * Versioned operator actions accepted by durable connector review requests.
 * Every branch is strict so newly supplied fields cannot silently acquire
 * authority under an older action version.
 */
export const ConnectorReviewActionSchema = z.discriminatedUnion('kind', [
  ReviewActionBaseSchema.extend({
    kind: z.literal('connect'),
    providerInstanceId: ConnectorProviderInstanceIdSchema,
    toolkit: z.string().min(1),
    label: z.string().min(1).optional(),
  }).strict(),
  ConnectionTargetSchema.extend({ kind: z.literal('edit'), label: z.string().min(1) }).strict(),
  ConnectionTargetSchema.extend({ kind: z.literal('reconnect') }).strict(),
  ConnectionTargetSchema.extend({ kind: z.literal('pause') }).strict(),
  ConnectionTargetSchema.extend({ kind: z.literal('resume') }).strict(),
  ConnectionTargetSchema.extend({ kind: z.literal('disconnect') }).strict(),
  ConnectionTargetSchema.extend({
    kind: z.literal('set_agent_access'),
    agentId: z.string().min(1),
    operationRevisionIds: z.array(z.string().min(1)).min(1),
  }).strict(),
  ConnectionTargetSchema.extend({
    kind: z.literal('remove_agent_access'),
    agentId: z.string().min(1),
  }).strict(),
  ConnectionTargetSchema.extend({
    kind: z.literal('create_subscription'),
    agentId: z.string().min(1),
    eventType: z.string().min(1),
    destinationKind: z.enum(['agent', 'room', 'channel']),
    destinationId: z.string().min(1),
    filter: z.record(z.string(), z.unknown()),
  }).strict(),
  ReviewActionBaseSchema.extend({
    kind: z.literal('update_subscription'),
    subscriptionId: z.string().min(1),
    enabled: z.boolean().optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  ReviewActionBaseSchema.extend({
    kind: z.literal('delete_subscription'),
    subscriptionId: z.string().min(1),
  }).strict(),
  ReviewActionBaseSchema.extend({
    kind: z.literal('agent_connection_request'),
    serviceSlug: z.string().min(1),
    reason: z.string().min(1),
    access: ConnectorRequestAccessSchema,
    requestedEvents: z.array(z.string().min(1)).default([]),
  }).strict(),
  ReviewActionBaseSchema.extend({
    kind: z.literal('resolve_agent_request'),
    agentRequestId: z.string().min(1),
    decision: z.enum(['approved', 'denied']),
  }).strict(),
]);
/** Validated action stored in an operator review request. */
export type ConnectorReviewAction = z.infer<typeof ConnectorReviewActionSchema>;

/** Strict runtime request for owner-reviewed access to one service. */
export const ConnectorAgentConnectionRequestInputSchema = z
  .object({
    version: z.literal(1),
    serviceSlug: z.string().min(1).max(200),
    reason: z.string().min(1).max(2_000),
    access: ConnectorRequestAccessSchema,
    requestedEvents: z
      .array(z.string().min(1).max(500))
      .max(CONNECTOR_EVENT_REVIEW_SCOPE_LIMIT)
      .default([]),
  })
  .strict()
  .superRefine((request, context) => {
    if (new Set(request.requestedEvents).size !== request.requestedEvents.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedEvents'],
        message: 'Requested events must be unique.',
      });
    }
  });
/** Strict runtime request for owner-reviewed access to one service. */
export type ConnectorAgentConnectionRequestInput = z.infer<
  typeof ConnectorAgentConnectionRequestInputSchema
>;

const ConnectorAgentRequestBaseSchema = z
  .object({
    requestId: z.string().min(1),
    serviceSlug: z.string().min(1),
    reason: z.string().min(1),
    access: ConnectorRequestAccessSchema,
    requestedEvents: z.array(z.string().min(1)),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    /**
     * What happens next, or what the person must do, in plain words the agent
     * can pass on. Every status carries one, so an agent never has to guess
     * from a status name alone.
     */
    note: z.string().min(1),
  })
  .strict();

/**
 * The part of what an agent asked for that its access does not cover, by
 * class: `write` when it asked to change things and can only read, `read`
 * when what it holds reads nothing.
 */
export const ConnectorRequestNotGrantedSchema = z.array(z.enum(['read', 'write']));

/** Account-private-safe result returned to the originating runtime. */
export const ConnectorAgentRequestStatusSchema = z.discriminatedUnion('status', [
  ConnectorAgentRequestBaseSchema.extend({ status: z.literal('awaiting_owner') }).strict(),
  ConnectorAgentRequestBaseSchema.extend({ status: z.literal('access_pending') }).strict(),
  ConnectorAgentRequestBaseSchema.extend({
    status: z.literal('granted'),
    connectionId: ConnectionIdSchema,
    grantedOperationRevisionIds: z.array(z.string().min(1)),
    grantedEvents: z.array(z.string().min(1)),
    /**
     * What the agent asked for that its access on this account does not
     * cover, compared by class (read, write), never by action name. Empty
     * when everything asked for was allowed; otherwise the agent works within
     * what it has and says what it could not do.
     */
    notGranted: ConnectorRequestNotGrantedSchema,
  }).strict(),
  ConnectorAgentRequestBaseSchema.extend({ status: z.literal('denied') }).strict(),
  ConnectorAgentRequestBaseSchema.extend({ status: z.literal('expired') }).strict(),
  ConnectorAgentRequestBaseSchema.extend({ status: z.literal('authentication_failed') }).strict(),
  ConnectorAgentRequestBaseSchema.extend({ status: z.literal('target_deleted') }).strict(),
]);
/** Account-private-safe result returned to the originating runtime. */
export type ConnectorAgentRequestStatus = z.infer<typeof ConnectorAgentRequestStatusSchema>;

/** Owner-only presentation for one durable agent access request. */
export const ConnectorAgentRequestItemSchema = ConnectorAgentRequestStatusSchema.and(
  z
    .object({
      agent: z.object({ id: z.string().min(1), displayName: z.string().min(1) }).strict(),
      sessionId: z.string().min(1),
      /**
       * The room whose turn raised the request, when a room's agent asked. Read
       * through the room-session binding when the request is read, so it
       * follows a session's rekey. The room shows the card to its owner.
       */
      roomId: z.string().min(1).optional(),
    })
    .strict()
);
/** Owner-only presentation for one durable agent access request. */
export type ConnectorAgentRequestItem = z.infer<typeof ConnectorAgentRequestItemSchema>;

/** Owner-only list of durable agent access requests. */
export const ConnectorAgentRequestListResponseSchema = z
  .object({ requests: z.array(ConnectorAgentRequestItemSchema) })
  .strict();
/** Owner-only list of durable agent access requests. */
export type ConnectorAgentRequestListResponse = z.infer<
  typeof ConnectorAgentRequestListResponseSchema
>;

const ConnectorManagementConnectActionSchema = ReviewActionBaseSchema.extend({
  kind: z.literal('connect'),
  providerInstanceId: ConnectorProviderInstanceIdSchema,
  toolkit: z.string().min(1),
  label: z.string().min(1).optional(),
}).strict();

const ConnectorManagementAppliedActionSchema = z.discriminatedUnion('kind', [
  ConnectionTargetSchema.extend({ kind: z.literal('edit'), label: z.string().min(1) }).strict(),
  ConnectionTargetSchema.extend({ kind: z.literal('pause') }).strict(),
  ConnectionTargetSchema.extend({ kind: z.literal('resume') }).strict(),
  ConnectionTargetSchema.extend({ kind: z.literal('disconnect') }).strict(),
  ConnectionTargetSchema.extend({
    kind: z.literal('set_agent_access'),
    agentId: z.string().min(1),
    operationRevisionIds: z.array(z.string().min(1)).min(1),
  }).strict(),
  ConnectionTargetSchema.extend({
    kind: z.literal('remove_agent_access'),
    agentId: z.string().min(1),
  }).strict(),
]);

/** P2 management actions programs may submit for an owner decision. */
export const ConnectorManagementReviewActionSchema = z
  .discriminatedUnion('kind', [
    ConnectorManagementConnectActionSchema,
    ...ConnectorManagementAppliedActionSchema.options,
  ])
  .superRefine((action, context) => {
    if (
      action.kind === 'set_agent_access' &&
      new Set(action.operationRevisionIds).size !== action.operationRevisionIds.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Operation revision selections must be unique',
        path: ['operationRevisionIds'],
      });
    }
  });
/** P2 management action that can be applied by the real owner review flow. */
export type ConnectorManagementReviewAction = z.infer<typeof ConnectorManagementReviewActionSchema>;

/** Program request for a durable owner-reviewed connector management action. */
export const ConnectorManagementReviewCreateRequestSchema = z
  .object({
    action: ConnectorManagementReviewActionSchema,
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();
/** Program request for a durable owner-reviewed connector management action. */
export type ConnectorManagementReviewCreateRequest = z.infer<
  typeof ConnectorManagementReviewCreateRequestSchema
>;

/** Typed result of resolving a management review; connect approval starts auth only. */
export const ConnectorManagementReviewOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('applied') }).strict(),
  z.object({ kind: z.literal('outcome_unknown') }).strict(),
  z
    .object({
      kind: z.literal('connect_authentication_required'),
      reviewRequestId: z.string().min(1),
      authentication: ConnectorAuthenticationFlowSchema,
    })
    .strict(),
  z.object({ kind: z.literal('denied') }).strict(),
]);
/** Typed result of resolving a management review. */
export type ConnectorManagementReviewOutcome = z.infer<
  typeof ConnectorManagementReviewOutcomeSchema
>;

/** Immutable operation detail captured when an owner review is requested. */
export const ConnectorManagementReviewOperationContextSchema = z
  .object({
    operationRevisionId: z.string().min(1),
    operationSlug: z.string().min(1),
    toolkitVersion: z.string().min(1),
    capabilityClassification: ConnectorOperationClassificationSchema,
  })
  .strict();
/** Immutable operation detail captured when an owner review is requested. */
export type ConnectorManagementReviewOperationContext = z.infer<
  typeof ConnectorManagementReviewOperationContextSchema
>;

const ConnectorManagementReviewConnectionContextSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    label: z.string().min(1),
    toolkit: z.string().min(1),
    status: z.enum(['active', 'expired', 'revoked', 'pending', 'paused']),
    custody: z.enum(['managed', 'self-host', 'external']),
    providerDisplayName: z.string().min(1),
    providerStatus: z.enum(['available', 'unavailable', 'migration_failed']),
    reconciliationStatus: ConnectorGrantReconciliationStatusSchema,
  })
  .strict();

const ConnectorManagementReviewAgentContextSchema = z
  .object({ agentId: z.string().min(1), displayName: z.string().min(1) })
  .strict();

/** Owner-visible facts frozen beside a management request before it can be approved. */
export const ConnectorManagementReviewContextSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('connect'),
      providerInstanceId: ConnectorProviderInstanceIdSchema,
      providerDisplayName: z.string().min(1),
      toolkit: z.string().min(1),
      label: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.enum(['edit', 'pause', 'resume']),
      connection: ConnectorManagementReviewConnectionContextSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('disconnect'),
      connection: ConnectorManagementReviewConnectionContextSchema,
      affectedAgentCount: z.number().int().nonnegative(),
      /**
       * True when the connection is shared with every agent, so disconnecting
       * takes it from every agent, not only the counted ones. Absent on a
       * review stored before every-agent grants existed, when it was false.
       */
      everyAgent: z.boolean().default(false),
      affectedOperations: z.array(ConnectorManagementReviewOperationContextSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('set_agent_access'),
      connection: ConnectorManagementReviewConnectionContextSchema,
      agent: ConnectorManagementReviewAgentContextSchema,
      requestedOperations: z.array(ConnectorManagementReviewOperationContextSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('remove_agent_access'),
      connection: ConnectorManagementReviewConnectionContextSchema,
      agent: ConnectorManagementReviewAgentContextSchema,
      affectedOperations: z.array(ConnectorManagementReviewOperationContextSchema),
      /**
       * Actions the agent KEEPS after this removal, because the connection
       * shares them with every agent (ADR 260926-192625). Removing one agent
       * cannot take these away; only turning off "every agent" can. Absent on a
       * review stored before every-agent grants existed, when it was empty.
       */
      keptThroughEveryAgent: z.array(ConnectorManagementReviewOperationContextSchema).default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
      reason: z.literal('created_before_context_snapshot'),
    })
    .strict(),
]);
/** Owner-visible facts frozen beside a management request before it can be approved. */
export type ConnectorManagementReviewContext = z.infer<
  typeof ConnectorManagementReviewContextSchema
>;

const ManagementReviewItemBaseShape = {
  reviewRequestId: z.string().min(1),
  requesterKind: z.enum(['program', 'operator']),
  context: ConnectorManagementReviewContextSchema,
  targetStatus: z.enum(['available', 'unavailable']),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
};

const ConnectorPendingManagementReviewItemSchema = z
  .object({
    ...ManagementReviewItemBaseShape,
    action: ConnectorManagementReviewActionSchema,
    state: z.literal('pending'),
  })
  .strict();

const ConnectorResolvingManagementReviewItemSchema = z
  .object({
    ...ManagementReviewItemBaseShape,
    action: ConnectorManagementReviewActionSchema,
    state: z.literal('resolving'),
    resolvedAt: z.string().datetime(),
  })
  .strict();

const ConnectorExpiredManagementReviewItemSchema = z
  .object({
    ...ManagementReviewItemBaseShape,
    action: ConnectorManagementReviewActionSchema,
    state: z.literal('expired'),
    resolvedAt: z.string().datetime(),
  })
  .strict();

const ConnectorDeniedManagementReviewItemSchema = z
  .object({
    ...ManagementReviewItemBaseShape,
    action: ConnectorManagementReviewActionSchema,
    state: z.literal('denied'),
    resolvedAt: z.string().datetime(),
    resolution: z.object({ kind: z.literal('denied') }).strict(),
  })
  .strict();

const ConnectorApprovedAppliedManagementReviewItemSchema = z
  .object({
    ...ManagementReviewItemBaseShape,
    action: ConnectorManagementAppliedActionSchema,
    state: z.literal('approved'),
    resolvedAt: z.string().datetime(),
    resolution: z.object({ kind: z.literal('applied') }).strict(),
  })
  .strict();

const ConnectorApprovedConnectManagementReviewItemSchema = z
  .object({
    ...ManagementReviewItemBaseShape,
    action: ConnectorManagementConnectActionSchema,
    state: z.literal('approved'),
    resolvedAt: z.string().datetime(),
    resolution: z
      .object({
        kind: z.literal('connect_authentication_required'),
        reviewRequestId: z.string().min(1),
        authentication: ConnectorAuthenticationFlowSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.reviewRequestId !== item.resolution.reviewRequestId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Authentication outcome must belong to this management review',
        path: ['resolution', 'reviewRequestId'],
      });
    }
  });

const ConnectorApprovedUnknownManagementReviewItemSchema = z
  .object({
    ...ManagementReviewItemBaseShape,
    action: ConnectorManagementReviewActionSchema,
    state: z.literal('approved'),
    resolvedAt: z.string().datetime(),
    resolution: z.object({ kind: z.literal('outcome_unknown') }).strict(),
  })
  .strict();

/** Public durable management review item with action-bound resolution state. */
export const ConnectorManagementReviewItemSchema = z
  .union([
    ConnectorPendingManagementReviewItemSchema,
    ConnectorResolvingManagementReviewItemSchema,
    ConnectorExpiredManagementReviewItemSchema,
    ConnectorDeniedManagementReviewItemSchema,
    ConnectorApprovedAppliedManagementReviewItemSchema,
    ConnectorApprovedConnectManagementReviewItemSchema,
    ConnectorApprovedUnknownManagementReviewItemSchema,
  ])
  .superRefine((item, context) => {
    if (item.context.kind !== 'unavailable' && item.context.kind !== item.action.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Management review context must describe the reviewed action',
        path: ['context', 'kind'],
      });
    }
  });
/** Public durable management review item with typed resolution state. */
export type ConnectorManagementReviewItem = z.infer<typeof ConnectorManagementReviewItemSchema>;

const ProgramReviewStatusBaseShape = {
  reviewRequestId: z.string().min(1),
  reviewUrl: z.string().startsWith('/connections?review='),
  targetStatus: z.enum(['available', 'unavailable']),
  expiresAt: z.string().datetime(),
};

/** Requester-safe management review status without owner presentation context. */
export const ConnectorProgramReviewStatusSchema = z.union([
  z.object({ ...ProgramReviewStatusBaseShape, state: z.literal('pending') }).strict(),
  z
    .object({
      ...ProgramReviewStatusBaseShape,
      state: z.literal('resolving'),
      resolvedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      ...ProgramReviewStatusBaseShape,
      state: z.literal('expired'),
      resolvedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      ...ProgramReviewStatusBaseShape,
      state: z.literal('denied'),
      resolvedAt: z.string().datetime(),
      outcome: z.literal('denied'),
    })
    .strict(),
  z
    .object({
      ...ProgramReviewStatusBaseShape,
      state: z.literal('approved'),
      resolvedAt: z.string().datetime(),
      outcome: z.literal('applied'),
    })
    .strict(),
  z
    .object({
      ...ProgramReviewStatusBaseShape,
      state: z.literal('approved'),
      resolvedAt: z.string().datetime(),
      outcome: z.literal('authentication_required'),
    })
    .strict(),
  z
    .object({
      ...ProgramReviewStatusBaseShape,
      state: z.literal('approved'),
      resolvedAt: z.string().datetime(),
      outcome: z.literal('outcome_unknown'),
    })
    .strict(),
]);
/** Requester-safe management review status without owner presentation context. */
export type ConnectorProgramReviewStatus = z.infer<typeof ConnectorProgramReviewStatusSchema>;

/** Owner's strict approve-or-deny decision for a pending management review. */
export const ConnectorManagementReviewDecisionSchema = z
  .object({ decision: z.enum(['approved', 'denied']) })
  .strict();
/** Owner's strict approve-or-deny decision for a pending management review. */
export type ConnectorManagementReviewDecision = z.infer<
  typeof ConnectorManagementReviewDecisionSchema
>;

/** Resolved review whose action-bound resolution is the canonical decision effect. */
export const ConnectorManagementReviewDecisionResultSchema = z
  .object({
    review: ConnectorManagementReviewItemSchema,
  })
  .strict();
/** Resolved review whose action-bound resolution is the canonical decision effect. */
export type ConnectorManagementReviewDecisionResult = z.infer<
  typeof ConnectorManagementReviewDecisionResultSchema
>;

/** Encode a validated review action into its canonical persisted form. */
export function encodeConnectorReviewAction(action: ConnectorReviewAction): string {
  return JSON.stringify(ConnectorReviewActionSchema.parse(action));
}

/** Decode and validate a persisted connector review action. */
export function decodeConnectorReviewAction(payload: string): ConnectorReviewAction {
  return ConnectorReviewActionSchema.parse(JSON.parse(payload));
}

/**
 * A service's display name from its toolkit id when no catalog name is at
 * hand: `gmail` → `Gmail`, `google_calendar` → `Google Calendar`. The one rule
 * for this, shared so the app and the server's Activity entries name an app
 * the same way. Prefer the catalog's own `displayName` when you have it.
 *
 * @param toolkit - A toolkit id such as `google_calendar`.
 */
export function serviceNameFromToolkit(toolkit: string): string {
  return toolkit
    .split(/[._-]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * An action's plain name from its id: `GMAIL_SEND_EMAIL` reads "Send email",
 * `gmail.messages.list` reads "List". The one rule for this, shared so the
 * app's lists, the access editors and the server's approval card name an
 * action the same way. Prefer the service's own display name for the action
 * when you have it.
 *
 * @param operationSlug - The action's id.
 * @param toolkit - The app's service id, dropped from the front of the id.
 */
export function actionNameFromSlug(operationSlug: string, toolkit: string): string {
  const leaf = operationSlug.split('.').at(-1) ?? operationSlug;
  const prefix = toolkit.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const words = leaf
    .replace(new RegExp(`^${prefix}[_-]`, 'iu'), '')
    .replaceAll(/[_-]+/gu, ' ')
    .trim()
    .toLowerCase();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : operationSlug;
}
