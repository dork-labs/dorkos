import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { BrowserReferenceSchema } from '@dorkos/shared/browser-schemas';
import {
  SemanticSnapshotV1Schema,
  SemanticEventV1Schema,
  SemanticActionV1Schema,
  SemanticReceiptV1Schema,
  type SemanticReceiptV1,
  type SemanticEventV1,
  SemanticAdmissionIdentityV1Schema,
  type SemanticSnapshotV1,
} from '@dorkos/shared/browser-semantic-schemas';
import { parseBrowserBinding, type BrowserBinding } from '../contracts.js';
import type { BrowserRecord, TabRecord } from '../lifecycle/records.js';
import { currentTab, readyInput } from '../lifecycle/input-owner.js';
import { currentAuthorityCustody } from '../lifecycle/live-custody.js';
import { ownOperation, requestRetirement } from '../lifecycle/ownership.js';
import type { OwnedInputAuthorization } from '../input/owned-work.js';
import { createSemanticInputIssuer } from '../input/semantic-work.js';
import {
  NativeSemanticTargetSchema,
  NativeSemanticEditResultSchema,
  NativeSemanticChangesSchema,
} from './native-target.js';
import { sameBinding } from '../input/binding.js';

/** Constructor-private original authentication; caller JSON never supplies these keys. */
export interface OwnedSemanticReadAuthorization {
  readonly actorKey: string;
  readonly grantKey: string;
  readonly grantRevision: number;
  isCurrent(): boolean;
  refresh(): Promise<void>;
  isOriginalRefusal(value: unknown): boolean;
  onOriginalDenial(value: unknown): void;
}
/** Original control receiver, independently refreshed from the view grant. */
export interface OwnedSemanticControlAuthorization extends OwnedSemanticReadAuthorization {
  readonly input: OwnedInputAuthorization;
  secretCurrent(): boolean;
}
/** Private bounded delivery, with original pending reads retained until their settlement. */
export interface PrivateSemanticStream {
  readonly eventStreamId: string;
  next(): Promise<SemanticEventV1 | null>;
  close(): Promise<void>;
}
/** Exact current actor/grant scope; no native selector is exposed. */
export interface PrivateBrowserSemanticDispatcher {
  action(
    request: unknown,
    authorization: OwnedSemanticControlAuthorization,
    signal: AbortSignal
  ): Promise<SemanticReceiptV1>;
  openStream(
    binding: unknown,
    leaseId: string,
    authorization: OwnedSemanticReadAuthorization,
    signal: AbortSignal
  ): Promise<PrivateSemanticStream>;
  read(
    binding: unknown,
    authorization: OwnedSemanticReadAuthorization,
    signal: AbortSignal
  ): Promise<SemanticSnapshotV1>;
  resolve(
    binding: unknown,
    leaseId: string,
    nodeRef: string,
    authorization: OwnedSemanticReadAuthorization,
    signal: AbortSignal
  ): Promise<boolean>;
}
/** Actual original engine captures this receiver once at construction. */
export interface PrivateBrowserSemanticOwner {
  registerDispatcher(dispatcher: PrivateBrowserSemanticDispatcher): void;
}
const refusals = new WeakSet<object>();
/** Exact locally issued refusal provenance; a producer-thrown class/reason cannot imitate it. */
export function isOriginalSemanticReadRefusal(value: unknown): boolean {
  return !!value && typeof value === 'object' && refusals.has(value);
}
function refusal(reason: string): Error {
  const error = new Error(reason);
  refusals.add(error);
  return error;
}
const rows = z
  .array(
    z
      .object({
        tab: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        url: z.string().max(4096),
        targetId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      })
      .strict()
  )
  .max(64);
type RetainedLease = Readonly<{
  binding: BrowserBinding;
  actor: string;
  grant: string;
  end: number;
  snapshot: SemanticSnapshotV1;
}>;

/** Match genuine native Page target metadata uniquely; URL/order cannot select a semantic reader. */
export function uniqueSemanticTab(value: unknown, targetId: string): number {
  const observed = rows.parse(value),
    matches = observed.filter((row) => row.targetId === targetId);
  if (
    matches.length !== 1 ||
    new Set(observed.map((row) => row.tab)).size !== observed.length ||
    new Set(observed.map((row) => row.targetId)).size !== observed.length
  )
    throw new Error('SEMANTIC_PAGE_CORRELATION_REFUSED');
  return matches[0]!.tab;
}
/** Compose only canonical live originals with the already owned supervisor read APIs. */
export function createPrivateSemanticDispatcher(
  find: (binding: BrowserBinding) => BrowserRecord,
  canonical: (record: BrowserRecord) => boolean
): PrivateBrowserSemanticDispatcher {
  const issuedDenials = new WeakMap<OwnedSemanticReadAuthorization, (reason: string) => Error>();
  const issued = (authority: OwnedSemanticReadAuthorization, reason: string): Error => {
    const original = issuedDenials.get(authority);
    if (!original) return new Error(reason);
    return original(reason);
  };
  const issuer = createSemanticInputIssuer();
  const active = new WeakSet<TabRecord>();
  const streamCells = new WeakMap<
    PrivateSemanticStream,
    {
      closed: boolean;
      actor: string;
      grant: string;
      end: number;
      revision: number;
      sequence: number;
      identity: import('@dorkos/shared/browser-semantic-schemas').SemanticAdmissionIdentityV1;
      events: SemanticEventV1[];
    }
  >();
  const streams = new WeakMap<TabRecord, Set<PrivateSemanticStream>>();
  const leases = new WeakMap<TabRecord, Map<string, RetainedLease>>();
  const enter = <T>(
    bindingValue: unknown,
    authority: OwnedSemanticReadAuthorization,
    signal: AbortSignal,
    effect: (
      record: BrowserRecord,
      tab: TabRecord,
      numeric: number,
      check: () => void
    ) => Promise<T>
  ): Promise<T> => {
    const binding = Object.freeze(parseBrowserBinding(bindingValue)),
      record = find(binding);
    const retained: { originalRefusal?: (value: unknown) => boolean } = {};
    const locallyIssued = new WeakSet<object>();
    const operation = ownOperation(record, async () => {
      // The parent's whole original is reserved before any authority getter/receiver acquisition.
      const current = authority.isCurrent.bind(authority),
        refresh = authority.refresh.bind(authority);
      retained.originalRefusal = authority.isOriginalRefusal.bind(authority);
      const reportDenial = authority.onOriginalDenial.bind(authority);
      issuedDenials.set(authority, (reason) => {
        const value = refusal(reason);
        locallyIssued.add(value);
        try {
          reportDenial(value);
        } catch {
          /* Retain the issued first refusal. */
        }
        return value;
      });
      const actor = BrowserReferenceSchema.parse(authority.actorKey),
        grant = BrowserReferenceSchema.parse(authority.grantKey);
      const grantRevision = authority.grantRevision;
      if (!Number.isSafeInteger(grantRevision) || grantRevision < 0)
        throw issued(authority, 'SEMANTIC_AUTHORITY_REFUSED');
      const tab = record.tabs.get(binding.tabId);
      if (!tab) throw issued(authority, 'SEMANTIC_BINDING_REFUSED');
      if (active.has(tab)) throw issued(authority, 'SEMANTIC_BUSY');
      active.add(tab);
      try {
        const check = () => {
          signal.throwIfAborted();
          if (
            !canonical(record) ||
            !currentTab(record, tab) ||
            !sameBinding(tab.binding, binding) ||
            !currentAuthorityCustody(record, () => canonical(record)) ||
            !current() ||
            !canonical(record) ||
            !currentTab(record, tab) ||
            !sameBinding(tab.binding, binding)
          )
            throw issued(authority, 'SEMANTIC_BINDING_REFUSED');
        };
        await refresh();
        check();
        const slot = readyInput(record, binding),
          handle = slot.handle,
          supervisor = record.supervisor;
        if (!handle?.semanticTarget || !supervisor)
          throw issued(authority, 'SEMANTIC_SUPERVISOR_UNAVAILABLE');
        const target = handle.semanticTarget.bind(handle),
          list = supervisor.list.bind(supervisor);
        check();
        const targetId = await target(signal);
        check();
        await refresh();
        check();
        const numeric = uniqueSemanticTab(await list(), targetId);
        check();
        await refresh();
        check();
        const result = await effect(record, tab, numeric, check);
        check();
        if (authority.actorKey !== actor || authority.grantKey !== grant)
          throw issued(authority, 'SEMANTIC_AUTHORITY_REFUSED');
        check();
        return result;
      } finally {
        active.delete(tab);
      }
    });
    return operation.catch((value) => {
      let expected = Boolean(value && typeof value === 'object' && locallyIssued.has(value));
      if (!expected) {
        try {
          expected = retained.originalRefusal?.(value) === true;
        } catch {
          // A classifier failure cannot replace the original operation's first cause.
          expected = false;
        }
      }
      if (!expected) {
        record.lifetime.uncertain = true;
        requestRetirement(record, 'engineFault');
      }
      throw value;
    });
  };
  return Object.freeze({
    action(
      requestValue: unknown,
      authority: OwnedSemanticControlAuthorization,
      signal: AbortSignal
    ) {
      const request = SemanticActionV1Schema.parse(requestValue);
      const binding = Object.freeze(
        parseBrowserBinding({
          browserId: request.identity.browserId,
          browserGeneration: request.identity.browserGeneration,
          tabId: request.identity.tabId,
          navigationGeneration: request.identity.navigationGeneration,
          viewportVersion: request.identity.viewportVersion,
          epoch: request.identity.epoch,
          inputGeneration: request.identity.inputGeneration,
        })
      );
      return enter(binding, authority, signal, async (record, tab, numeric, check) => {
        const lease = leases.get(tab)?.get(request.identity.semanticLeaseId),
          supervisor = record.supervisor;
        if (
          !lease ||
          !supervisor ||
          lease.actor !== authority.actorKey ||
          lease.grant !== authority.grantKey ||
          !sameBinding(binding, lease.binding) ||
          performance.now() >= lease.end
        )
          throw issued(authority, 'SEMANTIC_LEASE_REFUSED');
        const node = lease.snapshot.nodes.find((entry) => entry.nodeRef === request.nodeRef);
        if (
          !node ||
          !node.actions.includes(request.action.kind) ||
          lease.snapshot.completeness !== 'complete' ||
          node.frameId !== request.frameId ||
          node.frameNavigationGeneration !== request.frameNavigationGeneration ||
          lease.snapshot.focusRevision !== request.focusRevision ||
          Object.keys(request.identity).some(
            (key) =>
              request.identity[key as keyof typeof request.identity] !==
              lease.snapshot[key as keyof SemanticSnapshotV1]
          )
        )
          throw issued(authority, 'SEMANTIC_NODE_REFUSED');
        const handle = readyInput(record, binding).handle;
        if (!handle?.semanticEffect || !handle.submitSemantic)
          throw issued(authority, 'SEMANTIC_INPUT_UNAVAILABLE');
        const effect = handle.semanticEffect.bind(handle),
          submit = handle.submitSemantic.bind(handle);
        const targetRead = supervisor.semanticTarget.bind(supervisor);
        const begin = supervisor.semanticBeginEdit.bind(supervisor),
          phase = supervisor.semanticEditPhase.bind(supervisor),
          finish = supervisor.semanticFinishEdit.bind(supervisor);
        const input = authority.input,
          authorize = input.authorize.bind(input),
          inputCurrent = input.isCurrent.bind(input);
        const secretCurrent = authority.secretCurrent.bind(authority);
        const editing =
          ['insertText', 'replaceText', 'writeSecret'].includes(request.action.kind) ||
          (request.action.kind === 'key' &&
            !['Tab', 'ShiftTab', 'Escape'].includes(request.action.key) &&
            node.editKind !== 'none');
        const stream = request.eventStreamId
          ? [...(streams.get(tab) ?? [])].find(
              (item) => item.eventStreamId === request.eventStreamId
            )
          : undefined;
        if (editing && !stream) throw issued(authority, 'SEMANTIC_STREAM_REFUSED');
        if (
          request.action.kind === 'writeSecret'
            ? node.editKind !== 'secret' || !secretCurrent()
            : editing && node.editKind !== 'plainText'
        )
          throw issued(authority, 'SEMANTIC_SECRET_REFUSED');
        let editResult: z.infer<typeof NativeSemanticEditResultSchema> | undefined;
        let originalFailure: { value: unknown } | undefined;
        const current = () => {
          try {
            check();
            const allowed =
              inputCurrent() && (request.action.kind !== 'writeSecret' || secretCurrent());
            check();
            return allowed;
          } catch (value) {
            originalFailure ??= { value };
            throw value;
          }
        };
        const work = issuer.issue(binding, request, {
          current,
          async execute(originalSignal, queueCheck, dispatch) {
            try {
              const guard = () => {
                check();
                queueCheck();
                if (!current()) throw issued(authority, 'SEMANTIC_CONTROL_REFUSED');
              };
              guard();
              const target = NativeSemanticTargetSchema.nullable().parse(
                await targetRead(
                  numeric,
                  request.identity.semanticLeaseId,
                  request.nodeRef,
                  lease.actor,
                  lease.grant
                )
              );
              guard();
              if (
                !target ||
                target.frameId !== request.frameId ||
                target.frameNavigationGeneration !== request.frameNavigationGeneration ||
                target.disabled ||
                (editing && (target.readonly || !target.focused))
              )
                throw issued(authority, 'SEMANTIC_NODE_REFUSED');
              const observed = await effect(target, true, originalSignal, current);
              guard();
              if (!observed.focused) throw issued(authority, 'SEMANTIC_FOCUS_REFUSED');
              if (editing) {
                await begin(
                  numeric,
                  request.requestId,
                  request.identity.semanticLeaseId,
                  request.nodeRef,
                  lease.actor,
                  lease.grant
                );
                guard();
              }
              let count = 0;
              const step = async (value: import('../input/types.js').NativeInputStep) => {
                guard();
                if (++count > 16) throw issued(authority, 'SEMANTIC_STEP_LIMIT');
                const allowed = await authorize(binding, value, originalSignal);
                guard();
                if (allowed !== 'allowed') throw issued(authority, 'SEMANTIC_CONTROL_REFUSED');
                await dispatch(value);
                guard();
              };
              const key = async (
                value: import('../input/types.js').NativeInputStep & {
                  kind: 'keyDown';
                }
              ) => {
                await step(value);
                await step({ kind: 'keyUp', key: value.key });
              };
              if (request.action.kind === 'focus') return;
              if (editing) {
                await phase(numeric, request.requestId, lease.actor, lease.grant, 'input');
                guard();
              }
              if (request.action.kind === 'activate') await key({ kind: 'keyDown', key: 'Enter' });
              else if (request.action.kind === 'toggle')
                await key({ kind: 'keyDown', key: 'Space' });
              else if (request.action.kind === 'key') {
                if (request.action.key === 'ShiftTab') {
                  await step({ kind: 'keyDown', key: 'Shift' });
                  await key({ kind: 'keyDown', key: 'Tab' });
                  await step({ kind: 'keyUp', key: 'Shift' });
                } else await key({ kind: 'keyDown', key: request.action.key });
              } else {
                if (
                  request.action.kind === 'replaceText' ||
                  (request.action.kind === 'writeSecret' && request.action.mode === 'replace')
                ) {
                  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
                  // Fixed original platform document selection uses only the existing bounded key vocabulary.
                  await step({ kind: 'keyDown', key: modifier });
                  await key({
                    kind: 'keyDown',
                    key: process.platform === 'darwin' ? 'ArrowUp' : 'Home',
                  });
                  await step({ kind: 'keyDown', key: 'Shift' });
                  await key({
                    kind: 'keyDown',
                    key: process.platform === 'darwin' ? 'ArrowDown' : 'End',
                  });
                  await step({ kind: 'keyUp', key: 'Shift' });
                  await step({ kind: 'keyUp', key: modifier });
                  if (request.action.kind !== 'writeSecret') {
                    const selected = await effect(target, false, originalSignal, current);
                    guard();
                    if (!selected.selectedAll)
                      throw issued(authority, 'SEMANTIC_SELECTION_REFUSED');
                  }
                }
                await step({ kind: 'text', text: request.action.text });
              }
              if (editing) {
                await phase(numeric, request.requestId, lease.actor, lease.grant, 'idle');
                guard();
                editResult = NativeSemanticEditResultSchema.parse(
                  await finish(numeric, request.requestId, lease.actor, lease.grant)
                );
                guard();
              }
            } catch (value) {
              originalFailure ??= { value };
              throw value;
            }
          },
        });
        try {
          check();
          const result = await submit(work, signal);
          check();
          if (originalFailure) throw originalFailure.value;
          let editContinuation:
            | import('@dorkos/shared/browser-semantic-schemas').SemanticEditContinuationV1
            | undefined;
          if (
            result.outcome === 'completed' &&
            editResult?.correlated &&
            editResult.target &&
            stream
          ) {
            const snapshot = editResult.snapshot,
              target = editResult.target,
              cell = streamCells.get(stream);
            if (
              cell &&
              !cell.closed &&
              cell.actor === lease.actor &&
              cell.grant === lease.grant &&
              performance.now() < cell.end &&
              cell.sequence < 128
            ) {
              const { semanticLeaseId: _freshLease, ...freshIdentityFields } = target.identity;
              const freshIdentity = SemanticAdmissionIdentityV1Schema.parse(freshIdentityFields);
              const event = SemanticEventV1Schema.parse({
                version: 1,
                sequence: cell.sequence + 1,
                eventStreamId: stream.eventStreamId,
                identity: freshIdentity,
                type: 'dirty',
                reason: 'domChanged',
                editRequestId: request.requestId,
              });
              check();
              cell.sequence = event.sequence;
              cell.identity = freshIdentity;
              cell.revision = snapshot.treeRevision;
              cell.events.push(event);
              const end = performance.now() + Math.min(2000, snapshot.expiresInMs);
              leases.get(tab)!.set(
                snapshot.semanticLeaseId,
                Object.freeze({
                  binding,
                  actor: lease.actor,
                  grant: lease.grant,
                  end,
                  snapshot,
                })
              );
              editContinuation = {
                identity: target.identity,
                frameId: target.frameId,
                frameNavigationGeneration: target.frameNavigationGeneration,
                nodeRef: target.nodeRef,
                focusRevision: snapshot.focusRevision,
                expiresInMs: Math.max(1, Math.floor(end - performance.now())),
                eventStreamId: stream.eventStreamId,
                coveredEventSequence: event.sequence,
                allowedKinds:
                  target.kind === 'secret' ? ['writeSecret'] : ['insertText', 'replaceText', 'key'],
              };
            }
          }
          const { semanticLeaseId: _lease, ...identity } = request.identity;
          return SemanticReceiptV1Schema.parse({
            version: 1,
            requestId: request.requestId,
            identity,
            outcome: result.outcome,
            ...(result.outcome === 'completed'
              ? editContinuation
                ? { editContinuation }
                : {}
              : {
                  reason:
                    result.outcome === 'rejected'
                      ? 'inaccessible'
                      : result.reason === 'deadline'
                        ? 'deadline'
                        : 'dispatchFailed',
                }),
          });
        } finally {
          issuer.invalidate(work);
        }
      });
    },
    openStream(
      bindingValue: unknown,
      leaseValue: string,
      authority: OwnedSemanticReadAuthorization,
      signal: AbortSignal
    ) {
      const binding = Object.freeze(parseBrowserBinding(bindingValue));
      const leaseId = BrowserReferenceSchema.parse(leaseValue);
      return enter(binding, authority, signal, async (record, tab, numeric, check) => {
        const lease = leases.get(tab)?.get(leaseId),
          supervisor = record.supervisor;
        if (
          !lease ||
          !supervisor ||
          lease.actor !== authority.actorKey ||
          lease.grant !== authority.grantKey ||
          !sameBinding(binding, lease.binding) ||
          performance.now() >= lease.end
        )
          throw issued(authority, 'SEMANTIC_LEASE_REFUSED');
        let bank = streams.get(tab);
        if (!bank) streams.set(tab, (bank = new Set()));
        if (bank.size >= 8) throw issued(authority, 'SEMANTIC_STREAM_CAPACITY');
        const changes = supervisor.semanticChanges.bind(supervisor);
        check();
        const initial = NativeSemanticChangesSchema.parse(
          await changes(numeric, lease.actor, lease.grant)
        );
        check();
        const eventStreamId = randomBytes(16).toString('base64url'),
          end = performance.now() + 300000;
        const identity = SemanticAdmissionIdentityV1Schema.parse({
          version: lease.snapshot.version,
          browserId: lease.snapshot.browserId,
          browserGeneration: lease.snapshot.browserGeneration,
          tabId: lease.snapshot.tabId,
          navigationGeneration: lease.snapshot.navigationGeneration,
          viewportVersion: lease.snapshot.viewportVersion,
          treeId: lease.snapshot.treeId,
          treeRevision: lease.snapshot.treeRevision,
          epoch: lease.snapshot.epoch,
          inputGeneration: lease.snapshot.inputGeneration,
          grantRevision: lease.snapshot.grantRevision,
        });
        const cell = {
          closed: false,
          actor: lease.actor,
          grant: lease.grant,
          end,
          revision: initial.revision,
          sequence: 0,
          identity,
          events: [] as SemanticEventV1[],
        };
        let closed = false,
          delivered = false;
        let pending: Promise<SemanticEventV1 | null> | undefined;
        let closing: Promise<void> | undefined;
        let nextAt = 0;
        const stream: PrivateSemanticStream = Object.freeze({
          eventStreamId,
          next() {
            if (closed) return Promise.reject(issued(authority, 'SEMANTIC_STREAM_CLOSED'));
            if (pending) return Promise.reject(issued(authority, 'SEMANTIC_STREAM_PENDING'));
            if (performance.now() < nextAt)
              return Promise.reject(issued(authority, 'SEMANTIC_STREAM_RATE'));
            nextAt = performance.now() + 200;
            const operation = Promise.resolve().then(() =>
              enter(
                binding,
                authority,
                signal,
                async (_record, actualTab, actualNumeric, current) => {
                  if (
                    closed ||
                    actualTab !== tab ||
                    actualNumeric !== numeric ||
                    performance.now() >= end ||
                    (cell.sequence >= 128 && cell.events.length === 0)
                  )
                    throw issued(authority, 'SEMANTIC_STREAM_CLOSED');
                  current();
                  if (cell.events.length) {
                    delivered = true;
                    return cell.events.shift()!;
                  }
                  const observed = NativeSemanticChangesSchema.parse(
                    await changes(numeric, lease.actor, lease.grant)
                  );
                  current();
                  if (closed) throw issued(authority, 'SEMANTIC_STREAM_CLOSED');
                  if (delivered && observed.revision === cell.revision) return null;
                  const event = SemanticEventV1Schema.parse({
                    version: 1,
                    sequence: ++cell.sequence,
                    eventStreamId,
                    identity: cell.identity,
                    ...(delivered
                      ? { type: 'dirty', reason: 'domChanged' }
                      : { type: 'ready', reason: 'initial' }),
                  });
                  delivered = true;
                  cell.revision = observed.revision;
                  return event;
                }
              )
            );
            pending = operation;
            void operation.then(
              () => {
                if (pending === operation) pending = undefined;
              },
              () => {
                if (pending === operation) pending = undefined;
              }
            );
            return operation;
          },
          close() {
            closed = true;
            cell.closed = true;
            if (closing) return closing;
            const original = pending;
            closing = Promise.resolve().then(async () => {
              try {
                if (original) await original;
              } finally {
                bank!.delete(stream);
              }
            });
            return closing;
          },
        });
        check();
        streamCells.set(stream, cell);
        bank.add(stream);
        return stream;
      });
    },
    read(bindingValue: unknown, authority: OwnedSemanticReadAuthorization, signal: AbortSignal) {
      const binding = Object.freeze(parseBrowserBinding(bindingValue));
      return enter(binding, authority, signal, async (record, tab, numeric, check) => {
        const supervisor = record.supervisor;
        if (!supervisor) throw issued(authority, 'SEMANTIC_SUPERVISOR_UNAVAILABLE');
        const read = supervisor.semanticRead.bind(supervisor);
        // The native reader replaces the non-authoritative tree seed with its actual observed tree.
        const identity = SemanticAdmissionIdentityV1Schema.parse({
          version: 1,
          ...binding,
          treeId: randomBytes(16).toString('base64url'),
          treeRevision: 0,
          grantRevision: authority.grantRevision,
        });
        check();
        const started = performance.now();
        const snapshot = SemanticSnapshotV1Schema.parse(
          await read(numeric, identity, authority.actorKey, authority.grantKey)
        );
        check();
        if (
          Object.keys(binding).some(
            (key) => snapshot[key as keyof BrowserBinding] !== binding[key as keyof BrowserBinding]
          ) ||
          snapshot.grantRevision !== authority.grantRevision ||
          Buffer.byteLength(JSON.stringify(snapshot)) > 262144
        )
          throw new Error('SEMANTIC_SNAPSHOT_REFUSED');
        await authority.refresh();
        check();
        let bank = leases.get(tab);
        if (!bank) leases.set(tab, (bank = new Map()));
        const now = performance.now();
        for (const [id, prior] of bank) if (now >= prior.end) bank.delete(id);
        if (bank.size >= 8) throw issued(authority, 'SEMANTIC_LEASE_CAPACITY');
        bank.set(
          snapshot.semanticLeaseId,
          Object.freeze({
            binding,
            snapshot,
            actor: authority.actorKey,
            grant: authority.grantKey,
            end: started + Math.min(snapshot.expiresInMs, 2000),
          })
        );
        return snapshot;
      });
    },
    resolve(
      bindingValue: unknown,
      leaseId: string,
      nodeRef: string,
      authority: OwnedSemanticReadAuthorization,
      signal: AbortSignal
    ) {
      const binding = Object.freeze(parseBrowserBinding(bindingValue));
      leaseId = BrowserReferenceSchema.parse(leaseId);
      nodeRef = BrowserReferenceSchema.parse(nodeRef);
      return enter(binding, authority, signal, async (record, tab, numeric, check) => {
        const lease = leases.get(tab)?.get(leaseId),
          supervisor = record.supervisor;
        if (
          !lease ||
          !supervisor ||
          !sameBinding(lease.binding, binding) ||
          lease.actor !== authority.actorKey ||
          lease.grant !== authority.grantKey ||
          performance.now() >= lease.end
        )
          return false;
        const resolve = supervisor.semanticResolve.bind(supervisor);
        check();
        const result = await resolve(
          numeric,
          leaseId,
          nodeRef,
          authority.actorKey,
          authority.grantKey
        );
        check();
        await authority.refresh();
        check();
        if (typeof result !== 'boolean') throw new Error('SEMANTIC_RESOLUTION_REFUSED');
        return result && leases.get(tab)?.get(leaseId) === lease && performance.now() < lease.end;
      });
    },
  });
}
