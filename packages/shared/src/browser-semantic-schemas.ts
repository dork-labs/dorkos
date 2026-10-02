/** Frozen version-1 semantic wire contracts; references never establish authorization. */
import { z } from 'zod';
import {
  boundedBrowserJson,
  BrowserCounterSchema as counter,
  BrowserReferenceSchema as ref,
  BrowserTimestampSchema,
  browserText,
  browserPlainText,
} from './browser-schema-json.js';

/** Closed public roles, independent from remote ARIA or protocol role identifiers. */
export const SemanticRoleV1Schema = z.enum([
  'document',
  'frame',
  'generic',
  'text',
  'heading',
  'paragraph',
  'link',
  'button',
  'textbox',
  'checkbox',
  'radio',
  'switch',
  'combobox',
  'listbox',
  'option',
  'list',
  'listitem',
  'table',
  'row',
  'cell',
  'columnheader',
  'rowheader',
  'tablist',
  'tab',
  'tabpanel',
  'menu',
  'menuitem',
  'dialog',
  'alert',
  'status',
  'navigation',
  'main',
  'region',
  'form',
  'group',
  'separator',
  'slider',
  'spinbutton',
  'progressbar',
  'tree',
  'treeitem',
  'unknown',
]);
/** Closed operations; no executable string or arbitrary shortcut is accepted. */
export const SemanticActionKindV1Schema = z.enum([
  'focus',
  'activate',
  'toggle',
  'insertText',
  'replaceText',
  'writeSecret',
  'key',
]);
/** Closed canonical keyboard commands. */
export const SemanticKeyV1Schema = z.enum([
  'Tab',
  'ShiftTab',
  'Enter',
  'Space',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Backspace',
  'Delete',
]);
const identityShape = {
  version: z.literal(1),
  browserId: ref,
  browserGeneration: counter,
  tabId: ref,
  navigationGeneration: counter,
  viewportVersion: counter,
  treeId: ref,
  treeRevision: counter,
  epoch: counter,
  inputGeneration: counter,
  grantRevision: counter,
};
/** Admission identity excludes a lease; service checks actor, grant and attachment separately. */
export const SemanticAdmissionIdentityV1Schema = boundedBrowserJson(
  z.object(identityShape).strict()
);
/** Snapshot/action identity includes a short-lived server-issued lease reference. */
export const SemanticIdentityV1Schema = boundedBrowserJson(
  z.object({ ...identityShape, semanticLeaseId: ref }).strict()
);
const states = z
  .object({
    disabled: z.boolean().optional(),
    readonly: z.boolean().optional(),
    required: z.boolean().optional(),
    checked: z.union([z.boolean(), z.literal('mixed')]).optional(),
    expanded: z.boolean().optional(),
    selected: z.boolean().optional(),
    pressed: z.union([z.boolean(), z.literal('mixed')]).optional(),
    invalid: z.boolean().optional(),
    level: counter.optional(),
    focused: z.boolean().optional(),
  })
  .strict();
const node = z
  .object({
    nodeRef: ref,
    frameId: ref,
    frameNavigationGeneration: counter,
    parentRef: ref.nullable(),
    childRefs: z.array(ref).max(2000),
    role: SemanticRoleV1Schema,
    name: browserPlainText(512),
    description: browserPlainText(1024)
      .refine((text) => !/<[^>]*>/u.test(text))
      .optional(),
    text: browserPlainText(2048).optional(),
    value: browserPlainText(2048).optional(),
    states,
    editKind: z.enum(['none', 'plainText', 'secret', 'unsupported']),
    actions: z.array(SemanticActionKindV1Schema).max(7),
    redacted: z.boolean(),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = () =>
      context.addIssue({
        code: 'custom',
        message: 'Invalid semantic node capabilities or redaction',
      });
    if (
      new Set(value.childRefs).size !== value.childRefs.length ||
      new Set(value.actions).size !== value.actions.length
    )
      issue();
    if (value.editKind !== 'plainText' && value.value !== undefined) issue();
    if (value.editKind === 'plainText' && value.truncated) issue();
    if (value.editKind === 'secret' && (value.name !== 'Password field' || !value.redacted))
      issue();
    if (
      value.redacted &&
      (value.text !== undefined || value.value !== undefined || value.description !== undefined)
    )
      issue();
    if (value.role === 'unknown' && value.actions.length) issue();
    if (
      value.actions.some((kind) => ['insertText', 'replaceText'].includes(kind)) &&
      (value.editKind !== 'plainText' ||
        value.truncated ||
        value.states.readonly ||
        value.states.disabled)
    )
      issue();
    if (
      value.actions.includes('writeSecret') &&
      (value.editKind !== 'secret' ||
        value.truncated ||
        value.states.readonly ||
        value.states.disabled)
    )
      issue();
    if (value.actions.includes('activate') && !['button', 'link'].includes(value.role)) issue();
    if (value.actions.includes('toggle') && !['checkbox', 'radio', 'switch'].includes(value.role))
      issue();
  });
/** Sanitized bounded node projection; native edit eligibility still requires exact engine checks. */
export const SemanticNodeV1Schema = boundedBrowserJson(node, 256 * 1024);
const focusShape = {
  focusedRef: ref.nullable(),
  focusState: z.enum(['node', 'none', 'unmapped']),
  focusRevision: counter,
};
const snapshot = z
  .object({
    ...identityShape,
    semanticLeaseId: ref,
    capturedAt: BrowserTimestampSchema,
    expiresInMs: z.number().int().min(1).max(2000),
    rootRefs: z.array(ref).max(2000),
    nodes: z.array(node).max(2000),
    ...focusShape,
    completeness: z.enum(['complete', 'truncated', 'unavailable']),
    reason: z.enum(['limit', 'unstable', 'unsupportedFrame', 'engineUnavailable']).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = () =>
      context.addIssue({ code: 'custom', message: 'Invalid semantic graph or completeness' });
    if ((value.completeness === 'complete') !== (value.reason === undefined)) issue();
    if (value.completeness !== 'complete' && value.nodes.some((item) => item.actions.length))
      issue();
    if (
      value.completeness === 'unavailable' &&
      (value.nodes.length ||
        value.rootRefs.length ||
        value.focusedRef !== null ||
        value.focusState !== 'none')
    )
      issue();
    const nodes = new Map(value.nodes.map((item) => [item.nodeRef, item]));
    if (nodes.size !== value.nodes.length || new Set(value.rootRefs).size !== value.rootRefs.length)
      issue();
    const frames = new Map<string, number>();
    for (const item of value.nodes) {
      if (frames.has(item.frameId) && frames.get(item.frameId) !== item.frameNavigationGeneration)
        issue();
      frames.set(item.frameId, item.frameNavigationGeneration);
      if ((item.parentRef === null) !== value.rootRefs.includes(item.nodeRef)) issue();
      if (item.parentRef !== null && !nodes.get(item.parentRef)?.childRefs.includes(item.nodeRef))
        issue();
      for (const child of item.childRefs) if (nodes.get(child)?.parentRef !== item.nodeRef) issue();
    }
    if (frames.size > 32) issue();
    const seen = new Set<string>();
    const stack = value.rootRefs.map((id) => ({ id, depth: 1 }));
    while (stack.length) {
      const { id, depth } = stack.pop()!;
      const current = nodes.get(id);
      if (!current || seen.has(id) || depth > 32) {
        issue();
        continue;
      }
      seen.add(id);
      for (const child of current.childRefs) stack.push({ id: child, depth: depth + 1 });
    }
    if (seen.size !== nodes.size) issue();
    if (
      value.focusState === 'node'
        ? !value.focusedRef || !nodes.has(value.focusedRef)
        : value.focusedRef !== null
    )
      issue();
    for (const item of value.nodes)
      if (item.states.focused && item.nodeRef !== value.focusedRef) issue();
  });
/** Complete bounded forest with consistent frame documents and focus; incomplete snapshots are read-only. */
export const SemanticSnapshotV1Schema = boundedBrowserJson(snapshot, 256 * 1024);
const operation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('focus') }).strict(),
  z.object({ kind: z.literal('activate') }).strict(),
  z.object({ kind: z.literal('toggle') }).strict(),
  z.object({ kind: z.literal('insertText'), text: browserText(2048) }).strict(),
  z.object({ kind: z.literal('replaceText'), text: browserText(2048) }).strict(),
  z
    .object({
      kind: z.literal('writeSecret'),
      mode: z.enum(['insert', 'replace']),
      text: browserText(2048),
    })
    .strict(),
  z.object({ kind: z.literal('key'), key: SemanticKeyV1Schema }).strict(),
]);
/** Text edits require a stream; keys permit it structurally and require trusted context validation. */
export const SemanticActionV1Schema = boundedBrowserJson(
  z
    .object({
      requestId: ref,
      identity: SemanticIdentityV1Schema,
      frameId: ref,
      frameNavigationGeneration: counter,
      nodeRef: ref,
      focusRevision: counter,
      eventStreamId: ref.optional(),
      action: operation,
    })
    .strict()
    .superRefine((value, context) => {
      const edit = ['insertText', 'replaceText', 'writeSecret'].includes(value.action.kind);
      if (value.action.kind !== 'key' && edit !== (value.eventStreamId !== undefined))
        context.addIssue({ code: 'custom', message: 'Edit stream required only for edits' });
    })
);
/** Closed admitted refusal vocabulary; unauthorized objects must use inaccessible in the service. */
export const SemanticRefusalReasonV1Schema = z.enum([
  'inaccessible',
  'versionMismatch',
  'invalidRequest',
  'staleLease',
  'staleTree',
  'staleNode',
  'staleFocus',
  'staleEpoch',
  'navigationChanged',
  'frameChanged',
  'viewportChanged',
  'inputReset',
  'unsupportedAction',
  'secretDenied',
  'queueFull',
  'deadline',
  'engineUnavailable',
  'resetFailed',
  'dispatchFailed',
  'responseLost',
]);
/** Pre-admission error has no object identity or unvalidated input. */
export const SemanticErrorV1Schema = boundedBrowserJson(
  z
    .object({
      version: z.literal(1),
      reason: z.enum(['invalidRequest', 'versionMismatch', 'inaccessible']),
    })
    .strict()
);
const continuation = z
  .object({
    identity: SemanticIdentityV1Schema,
    frameId: ref,
    frameNavigationGeneration: counter,
    nodeRef: ref,
    focusRevision: counter,
    expiresInMs: z.number().int().min(1).max(2000),
    eventStreamId: ref,
    coveredEventSequence: counter,
    allowedKinds: z.union([
      z.tuple([z.literal('insertText'), z.literal('replaceText'), z.literal('key')]),
      z.tuple([z.literal('writeSecret')]),
    ]),
  })
  .strict();
/** Fresh exact-field continuation with one of the two approved capability tuples; never secret echo. */
export const SemanticEditContinuationV1Schema = boundedBrowserJson(continuation);
const receipt = z
  .union([
    z
      .object({
        version: z.literal(1),
        requestId: ref,
        identity: SemanticAdmissionIdentityV1Schema,
        outcome: z.literal('completed'),
        editContinuation: continuation.optional(),
      })
      .strict(),
    z
      .object({
        version: z.literal(1),
        requestId: ref,
        identity: SemanticAdmissionIdentityV1Schema,
        outcome: z.enum(['rejected', 'aborted', 'uncertain']),
        reason: SemanticRefusalReasonV1Schema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.outcome !== 'completed' || !value.editContinuation) return;
    const fresh = value.editContinuation.identity;
    const stable = [
      'version',
      'browserId',
      'browserGeneration',
      'tabId',
      'navigationGeneration',
      'viewportVersion',
      'treeId',
      'epoch',
      'inputGeneration',
      'grantRevision',
    ] as const;
    if (
      stable.some((key) => fresh[key] !== value.identity[key]) ||
      fresh.treeRevision <= value.identity.treeRevision
    )
      context.addIssue({
        code: 'custom',
        message: 'Continuation must preserve admission binding and advance tree revision',
      });
  });
/** Admitted receipt; outcome does not guarantee a site effect, grant or durable write. */
export const SemanticReceiptV1Schema = boundedBrowserJson(receipt);
const focus = z
  .object({
    frameId: ref.nullable(),
    frameNavigationGeneration: counter.nullable(),
    ...focusShape,
  })
  .strict()
  .superRefine((value, context) => {
    const hasFrame = value.frameId !== null && value.frameNavigationGeneration !== null;
    const noFrame = value.frameId === null && value.frameNavigationGeneration === null;
    if (
      value.focusState === 'node'
        ? !hasFrame || value.focusedRef === null
        : value.focusState === 'none'
          ? !noFrame || value.focusedRef !== null
          : !hasFrame || value.focusedRef !== null
    )
      context.addIssue({
        code: 'custom',
        message: 'Focus state must match frame and node presence',
      });
  });
const eventBase = {
  version: z.literal(1),
  sequence: counter,
  eventStreamId: ref,
  identity: SemanticAdmissionIdentityV1Schema,
};
const event = z.union([
  z
    .object({ ...eventBase, type: z.literal('ready'), reason: z.enum(['initial', 'refreshed']) })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('dirty'),
      reason: z.enum(['domChanged', 'axChanged']),
      editRequestId: ref.optional(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('focusChanged'),
      reason: z.literal('focusChanged'),
      focus,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('focusChanged'),
      reason: z.literal('selectionChanged'),
      focus,
      editRequestId: ref.optional(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('reset'),
      reason: z.enum([
        'navigation',
        'frameChanged',
        'viewportChanged',
        'inputReset',
        'streamGap',
        'leaseExpired',
      ]),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('controlChanged'),
      reason: z.enum(['acquired', 'takenOver', 'handedOff', 'disconnected']),
      control: z
        .object({ controllerId: ref.nullable(), status: z.enum(['ready', 'barrier', 'stopped']) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('revoked'),
      reason: z.enum(['grantRevoked', 'grantExpired', 'scopeRemoved', 'ownerDeleted']),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('unavailable'),
      reason: z.enum(['limit', 'unstable', 'unsupportedFrame', 'engineUnavailable']),
    })
    .strict(),
]);
/** Metadata-only notification; actual focus moves cannot claim edit correlation. */
export const SemanticEventV1Schema = boundedBrowserJson(event);

/** Version-1 roles. */
export type SemanticRoleV1 = z.infer<typeof SemanticRoleV1Schema>;
/** Version-1 operation kinds. */
export type SemanticActionKindV1 = z.infer<typeof SemanticActionKindV1Schema>;
/** Version-1 keyboard commands. */
export type SemanticKeyV1 = z.infer<typeof SemanticKeyV1Schema>;
/** Full leased identity. */
export type SemanticIdentityV1 = z.infer<typeof SemanticIdentityV1Schema>;
/** Admission identity without authority lease. */
export type SemanticAdmissionIdentityV1 = z.infer<typeof SemanticAdmissionIdentityV1Schema>;
/** Sanitized semantic node. */
export type SemanticNodeV1 = z.infer<typeof SemanticNodeV1Schema>;
/** Current snapshot, not persisted content. */
export type SemanticSnapshotV1 = z.infer<typeof SemanticSnapshotV1Schema>;
/** Semantic command body without actor claims. */
export type SemanticActionV1 = z.infer<typeof SemanticActionV1Schema>;
/** Metadata-only notification. */
export type SemanticEventV1 = z.infer<typeof SemanticEventV1Schema>;
/** Exact-field edit continuation. */
export type SemanticEditContinuationV1 = z.infer<typeof SemanticEditContinuationV1Schema>;
/** Admitted action outcome. */
export type SemanticReceiptV1 = z.infer<typeof SemanticReceiptV1Schema>;
/** Pre-admission refusal. */
export type SemanticErrorV1 = z.infer<typeof SemanticErrorV1Schema>;

/** Validate ordered own-edit metadata against a supplied request; this does not authenticate a stream or lease. */
export const SemanticEditCorrelationV1Schema = boundedBrowserJson(
  z
    .object({
      request: SemanticActionV1Schema,
      receipt: SemanticReceiptV1Schema,
      previousEventSequence: counter,
      events: z.array(SemanticEventV1Schema).min(1).max(128),
    })
    .strict()
    .superRefine((value, context) => {
      const issue = () =>
        context.addIssue({
          code: 'custom',
          message: 'Own-edit request, binding, stream and watermark must correlate',
        });
      const { request, receipt } = value;
      if (!request.eventStreamId || receipt.outcome !== 'completed' || !receipt.editContinuation) {
        issue();
        return;
      }
      const fresh = receipt.editContinuation;
      const stable = [
        'version',
        'browserId',
        'browserGeneration',
        'tabId',
        'navigationGeneration',
        'viewportVersion',
        'treeId',
        'epoch',
        'inputGeneration',
        'grantRevision',
      ] as const;
      if (
        receipt.requestId !== request.requestId ||
        Object.keys(receipt.identity).some(
          (key) =>
            receipt.identity[key as keyof typeof receipt.identity] !==
            request.identity[key as keyof typeof receipt.identity]
        )
      )
        issue();
      if (
        fresh.eventStreamId !== request.eventStreamId ||
        fresh.frameId !== request.frameId ||
        fresh.frameNavigationGeneration !== request.frameNavigationGeneration ||
        fresh.nodeRef === request.nodeRef ||
        fresh.identity.semanticLeaseId === request.identity.semanticLeaseId ||
        fresh.focusRevision < request.focusRevision
      )
        issue();
      if (
        request.action.kind === 'writeSecret'
          ? fresh.allowedKinds[0] !== 'writeSecret'
          : !['insertText', 'replaceText', 'key'].includes(request.action.kind) ||
            fresh.allowedKinds[0] !== 'insertText'
      )
        issue();
      let sequence = value.previousEventSequence;
      let freshDirty = false;
      let treeRevision = request.identity.treeRevision;
      let focusRevision = request.focusRevision;
      for (const notification of value.events) {
        if (
          sequence === Number.MAX_SAFE_INTEGER ||
          notification.sequence !== sequence + 1 ||
          notification.sequence > fresh.coveredEventSequence
        )
          issue();
        sequence = notification.sequence;
        if (
          notification.eventStreamId !== request.eventStreamId ||
          stable.some((key) => notification.identity[key] !== request.identity[key]) ||
          notification.identity.treeRevision < treeRevision ||
          notification.identity.treeRevision > fresh.identity.treeRevision
        )
          issue();
        treeRevision = notification.identity.treeRevision;
        if (
          notification.type !== 'dirty' &&
          !(notification.type === 'focusChanged' && notification.reason === 'selectionChanged')
        ) {
          issue();
          continue;
        }
        if (notification.editRequestId !== request.requestId) issue();
        if (
          notification.type === 'focusChanged' &&
          (notification.focus.frameId !== fresh.frameId ||
            notification.focus.frameNavigationGeneration !== fresh.frameNavigationGeneration ||
            notification.focus.focusedRef !== fresh.nodeRef ||
            notification.focus.focusState !== 'node' ||
            notification.focus.focusRevision < focusRevision ||
            notification.focus.focusRevision > fresh.focusRevision)
        )
          issue();
        if (notification.type === 'focusChanged') focusRevision = notification.focus.focusRevision;
        if (
          notification.type === 'dirty' &&
          notification.identity.treeRevision === fresh.identity.treeRevision
        )
          freshDirty = true;
      }
      if (sequence !== fresh.coveredEventSequence || !freshDirty) issue();
    }),
  256 * 1024
);
/** Contextual correlation proof supplied by a consumer, not authenticated authority. */
export type SemanticEditCorrelationV1 = z.infer<typeof SemanticEditCorrelationV1Schema>;

/** Trusted engine classification; it is not accepted as part of a semantic request body. */
export interface SemanticActionContext {
  readonly editKind: 'none' | 'plainText' | 'secret' | 'unsupported';
  readonly intent: 'edit' | 'nonediting';
  readonly liveEventStreamId: string | null;
}
/** Check resolved edit intent and stream equality; caller authentication and actual DOM eligibility remain service checks. */
export function validateSemanticActionContext(
  value: unknown,
  context: SemanticActionContext
): boolean {
  const parsed = SemanticActionV1Schema.safeParse(value);
  const trusted = boundedBrowserJson(
    z
      .object({
        editKind: z.enum(['none', 'plainText', 'secret', 'unsupported']),
        intent: z.enum(['edit', 'nonediting']),
        liveEventStreamId: ref.nullable(),
      })
      .strict()
  ).safeParse(context);
  if (!parsed.success || !trusted.success) return false;
  const action = parsed.data;
  const resolved = trusted.data;
  const focusKeys = ['Tab', 'ShiftTab', 'Escape'];
  if (resolved.intent === 'nonediting') {
    if (
      ['insertText', 'replaceText', 'writeSecret'].includes(action.action.kind) ||
      action.eventStreamId !== undefined
    )
      return false;
    // An editor may change value or selection from other keys. Without verified native
    // intent, Enter/Space cannot be inferred safe from a plainText/secret/unsupported label.
    return (
      action.action.kind !== 'key' ||
      resolved.editKind === 'none' ||
      focusKeys.includes(action.action.key)
    );
  }
  if (action.action.kind === 'key' && focusKeys.includes(action.action.key)) return false;
  if (action.eventStreamId === undefined || action.eventStreamId !== resolved.liveEventStreamId)
    return false;
  if (action.action.kind === 'writeSecret') return resolved.editKind === 'secret';
  return (
    resolved.editKind === 'plainText' &&
    ['insertText', 'replaceText', 'key'].includes(action.action.kind)
  );
}
