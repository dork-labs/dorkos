import { performance } from 'node:perf_hooks';
import { projectOriginalVMSemanticSnapshot } from './semantic-projection.mjs';
import { randomBytes } from 'node:crypto';
import {
  parseBrowserBinding,
  createOriginalSemanticRefusalIssuer,
  createSemanticInputIssuer,
  consumeSemanticInputWork,
  semanticInputCurrent,
  executeSemanticInputWork,
  settleSemanticInputWork,
} from '@dorkos/browser/server-owner';
import { BrowserReferenceSchema } from '@dorkos/shared/browser-schemas';
import {
  SemanticSnapshotV1Schema,
  SemanticAdmissionIdentityV1Schema,
  SemanticEventV1Schema,
  SemanticActionV1Schema,
  SemanticReceiptV1Schema,
} from '@dorkos/shared/browser-semantic-schemas';
import { inspectOriginalManagedVMSemanticRefusal } from '../runtime/managed-vm-acquisition.mjs';
import { inspectOriginalSemanticObservation } from '../runtime/semantic-protocol.mjs';
const bad = (code) => new Error(code),
  same = (a, b) => Object.keys(a).every((key) => a[key] === b[key]);
const refs = () => randomBytes(16).toString('base64url');
// Closed host identity projection intentionally omits the local semantic lease ID.
const admissionIdentity = (value) =>
  SemanticAdmissionIdentityV1Schema.parse(
    Object.fromEntries(
      [
        'version',
        'browserId',
        'browserGeneration',
        'tabId',
        'navigationGeneration',
        'viewportVersion',
        'treeId',
        'treeRevision',
        'epoch',
        'inputGeneration',
        'grantRevision',
      ].map((key) => [key, value[key]])
    )
  );
/** Constructor-private host actor/grant custody. Guest references locate only
 * observations; every local lease is minted after original authority refresh. */
export function createOriginalVMSemanticDispatcher(records, policy) {
  const inputIssuer = createSemanticInputIssuer(),
    denialIssuer = createOriginalSemanticRefusalIssuer();
  const leases = new WeakMap(),
    streams = new WeakMap(),
    streamCells = new WeakMap(),
    refusals = new WeakSet(),
    authorize = policy.authorizeAction.bind(policy);
  const denied = (authority, code) => {
    const value = denialIssuer.issue(code);
    refusals.add(value);
    try {
      authority.onOriginalDenial(value);
    } catch {
      /* Notification is diagnostic; retain this original private denial. */
    }
    return value;
  };
  const enter = (value, authority, signal, operation) => {
    const binding = Object.freeze(parseBrowserBinding(value)),
      record = records.get(binding.browserId, binding.browserGeneration),
      tab = record.exactTab(binding);
    // Reserve the original queue job before reading fallible authority members.
    return record.dispatch(async () => {
      const current = authority.isCurrent.bind(authority),
        refresh = authority.refresh.bind(authority),
        isRefusal = authority.isOriginalRefusal.bind(authority);
      const actor = BrowserReferenceSchema.parse(authority.actorKey),
        grant = BrowserReferenceSchema.parse(authority.grantKey),
        revision = authority.grantRevision;
      if (!Number.isSafeInteger(revision) || revision < 0) throw bad('VM_SEMANTIC_GRANT_REVISION');
      const check = () => {
        if (
          signal.aborted ||
          !current() ||
          record.exactTab(binding) !== tab ||
          authority.actorKey !== actor ||
          authority.grantKey !== grant ||
          authority.grantRevision !== revision ||
          !current()
        )
          throw denied(authority, 'VM_SEMANTIC_AUTHORITY');
      };
      const fence = async () => {
        check();
        await refresh();
        check();
        if ((await authorize(binding, signal)) !== 'allowed')
          throw denied(authority, 'VM_SEMANTIC_POLICY');
        check();
      };
      const unpublished = new Set();
      let publishReturn;
      try {
        await fence();
        const result = await operation({
          binding,
          record,
          tab,
          actor,
          grant,
          revision,
          started: performance.now(),
          check,
          fence,
          onUnpublished: (cleanup) => unpublished.add(cleanup),
          onPublish: (callback) => {
            if (publishReturn) throw bad('VM_SEMANTIC_PUBLICATION_ONCE');
            publishReturn = callback;
          },
        });
        await fence();
        const published = publishReturn ? publishReturn() : result;
        check();
        unpublished.clear();
        return published;
      } catch (value) {
        for (const cleanup of unpublished)
          try {
            await cleanup();
          } catch {
            /* Cleanup callbacks remove only unpublished local leases/streams; preserve the originating failure. */
          }
        let expected = refusals.has(value);
        if (!expected)
          try {
            expected = !!inspectOriginalManagedVMSemanticRefusal(record.originalSession(), value);
          } catch {
            /* Failed provenance inspection stays unclassified and cannot replace the original cause. */
          }
        if (!expected)
          try {
            expected = isRefusal(value) === true;
          } catch {
            /* A throwing classifier grants no expected-refusal exemption. */
          }
        if (!expected) void record.retire('engineFault');
        throw value;
      }
    });
  };
  const selected = (tab, id, scope) => {
    const row = leases.get(tab)?.get(id);
    return row &&
      same(row.binding, scope.binding) &&
      row.actor === scope.actor &&
      row.grant === scope.grant &&
      row.revision === scope.revision &&
      performance.now() < row.end
      ? row
      : null;
  };
  const publish = (scope, value, prior) => {
    const { snapshot, guestLease, treeRef } = projectOriginalVMSemanticSnapshot(value, {
      version: 1,
      ...scope.binding,
      treeId: prior && prior.treeRef === value.treeRef ? prior.snapshot.treeId : refs(),
      semanticLeaseId: refs(),
      grantRevision: scope.revision,
    });
    // Strict schema means wire additions cannot override local identity fields.
    if (!same(scope.binding, snapshot) || snapshot.grantRevision !== scope.revision)
      throw bad('VM_SEMANTIC_IDENTITY');
    let bank = leases.get(scope.tab);
    if (!bank) leases.set(scope.tab, (bank = new Map()));
    const now = performance.now();
    for (const [id, row] of bank) if (now >= row.end) bank.delete(id);
    if (bank.size >= 8) throw bad('VM_SEMANTIC_LEASE_BANK');
    scope.check();
    const row = Object.freeze({
      binding: scope.binding,
      actor: scope.actor,
      grant: scope.grant,
      revision: scope.revision,
      guestLease,
      treeRef,
      snapshot,
      end: scope.started + Math.min(2000, snapshot.expiresInMs),
    });
    bank.set(snapshot.semanticLeaseId, row);
    scope.onUnpublished(() => {
      if (bank.get(snapshot.semanticLeaseId) === row) bank.delete(snapshot.semanticLeaseId);
    });
    return snapshot;
  };
  return Object.freeze({
    action(value, authority, signal) {
      const action = SemanticActionV1Schema.parse(value),
        binding = parseBrowserBinding(
          Object.fromEntries(
            [
              'browserId',
              'browserGeneration',
              'tabId',
              'navigationGeneration',
              'viewportVersion',
              'epoch',
              'inputGeneration',
            ].map((key) => [key, action.identity[key]])
          )
        );
      return enter(binding, authority, signal, async (scope) => {
        const lease = selected(scope.tab, action.identity.semanticLeaseId, scope),
          node = lease?.snapshot.nodes.find((row) => row.nodeRef === action.nodeRef);
        if (
          !lease ||
          !node ||
          lease.snapshot.completeness !== 'complete' ||
          !node.actions.includes(action.action.kind) ||
          node.frameId !== action.frameId ||
          node.frameNavigationGeneration !== action.frameNavigationGeneration ||
          lease.snapshot.focusRevision !== action.focusRevision ||
          !same(action.identity, lease.snapshot)
        )
          throw denied(authority, 'VM_SEMANTIC_NODE');
        const input = authority.input,
          inputCurrent = input.isCurrent.bind(input),
          authorizeInput = input.authorize.bind(input),
          secretCurrent = authority.secretCurrent.bind(authority);
        const editing =
          ['insertText', 'replaceText', 'writeSecret'].includes(action.action.kind) ||
          (action.action.kind === 'key' &&
            !['Tab', 'ShiftTab', 'Escape'].includes(action.action.key) &&
            node.editKind !== 'none');
        const stream = action.eventStreamId
          ? [...(streams.get(scope.tab) ?? [])].find(
              (row) => row.eventStreamId === action.eventStreamId
            )
          : undefined;
        const streamCell = stream && streamCells.get(stream);
        if (
          (editing &&
            (!streamCell ||
              streamCell.closed ||
              streamCell.actor !== scope.actor ||
              streamCell.grant !== scope.grant ||
              performance.now() >= streamCell.end)) ||
          (action.action.kind === 'writeSecret'
            ? node.editKind !== 'secret' || !secretCurrent()
            : editing && node.editKind !== 'plainText')
        )
          throw denied(authority, 'VM_SEMANTIC_EDIT');
        const current = () => {
          scope.check();
          const result =
            inputCurrent() &&
            (action.action.kind !== 'writeSecret' || secretCurrent()) &&
            selected(scope.tab, action.identity.semanticLeaseId, scope) === lease;
          scope.check();
          return result;
        };
        const session = scope.record.originalSession(),
          native = async (command, fields = {}) => {
            scope.check();
            const token = await session.semantic(command, scope.binding.tabId, fields);
            scope.check();
            return inspectOriginalSemanticObservation(token, session, scope.binding.tabId, command);
          };
        const state = async (focus) => {
          const result = await native('semantic-effect', {
              lease: lease.guestLease,
              node: action.nodeRef,
              mode: focus ? 'focus' : 'inspect',
            }),
            observed = result?.state;
          if (result && Object.keys(result).join(',') === 'state' && observed === null)
            throw denied(authority, 'VM_SEMANTIC_TARGET');
          if (
            !result ||
            Object.keys(result).join(',') !== 'state' ||
            !observed ||
            Object.keys(observed).sort().join(',') !==
              'connected,disabled,focused,kind,readonly,selectedAll' ||
            ['connected', 'disabled', 'focused', 'readonly', 'selectedAll'].some(
              (key) => typeof observed[key] !== 'boolean'
            ) ||
            !['none', 'plainText', 'secret', 'unsupported'].includes(observed.kind)
          )
            throw bad('VM_SEMANTIC_EFFECT');
          return observed;
        };
        let work, editContinuation, continuationEnd;
        const owner = Object.freeze({}),
          edit = refs();
        try {
          work = inputIssuer.issue(scope.binding, action, {
            current,
            async execute(originalSignal, queueCheck, dispatch) {
              const guard = () => {
                scope.check();
                queueCheck();
                if (!current()) throw denied(authority, 'VM_SEMANTIC_CONTROL');
              };
              guard();
              const observed = await state(true);
              guard();
              if (
                !observed.connected ||
                !observed.focused ||
                observed.disabled ||
                (editing && (observed.readonly || observed.kind !== node.editKind))
              )
                throw denied(authority, 'VM_SEMANTIC_FOCUS');
              if (editing) {
                await native('semantic-edit-begin', {
                  edit,
                  lease: lease.guestLease,
                  node: action.nodeRef,
                });
                guard();
                await native('semantic-edit-phase', { edit, phase: 'input' });
                guard();
              }
              let count = 0;
              const step = async (row) => {
                guard();
                if (++count > 16) throw denied(authority, 'VM_SEMANTIC_STEP_BANK');
                if ((await authorizeInput(scope.binding, row, originalSignal)) !== 'allowed')
                  throw denied(authority, 'VM_SEMANTIC_INPUT');
                guard();
                await dispatch(row);
                guard();
              };
              const key = async (key) => {
                await step({ kind: 'keyDown', key });
                await step({ kind: 'keyUp', key });
              };
              if (action.action.kind === 'focus') return;
              if (action.action.kind === 'activate') await key('Enter');
              else if (action.action.kind === 'toggle') await key('Space');
              else if (action.action.kind === 'key') {
                if (action.action.key === 'ShiftTab') {
                  await step({ kind: 'keyDown', key: 'Shift' });
                  await key('Tab');
                  await step({ kind: 'keyUp', key: 'Shift' });
                } else await key(action.action.key);
              } else {
                if (
                  action.action.kind === 'replaceText' ||
                  (action.action.kind === 'writeSecret' && action.action.mode === 'replace')
                ) {
                  // The original browser runs on Linux: use its fixed document selection.
                  await step({ kind: 'keyDown', key: 'Control' });
                  await key('Home');
                  await step({ kind: 'keyDown', key: 'Shift' });
                  await key('End');
                  await step({ kind: 'keyUp', key: 'Shift' });
                  await step({ kind: 'keyUp', key: 'Control' });
                  if (action.action.kind !== 'writeSecret') {
                    const selected = await state(false);
                    guard();
                    if (!selected.selectedAll) throw denied(authority, 'VM_SEMANTIC_SELECTION');
                  }
                }
                await step({ kind: 'text', text: action.action.text });
              }
              if (editing) {
                await native('semantic-edit-phase', { edit, phase: 'idle' });
                guard();
                const finishStarted = performance.now(),
                  finished = await native('semantic-edit-finish', { edit });
                guard();
                if (
                  !finished ||
                  Object.keys(finished).sort().join(',') !== 'correlated,snapshot' ||
                  typeof finished.correlated !== 'boolean'
                )
                  throw bad('VM_SEMANTIC_EDIT_RETURN');
                const fresh = publish(
                    { ...scope, started: finishStarted },
                    finished.snapshot,
                    lease
                  ),
                  forest = (snapshot) =>
                    JSON.stringify({
                      rootRefs: snapshot.rootRefs,
                      nodes: snapshot.nodes.map((row) =>
                        row.nodeRef === action.nodeRef ? { ...row, value: undefined } : row
                      ),
                    }),
                  freshNode = fresh.nodes.find((row) => row.nodeRef === action.nodeRef);
                if (
                  finished.correlated &&
                  freshNode &&
                  fresh.completeness === 'complete' &&
                  fresh.focusState === 'node' &&
                  fresh.focusedRef === action.nodeRef &&
                  lease.snapshot.focusedRef === action.nodeRef &&
                  fresh.treeId === lease.snapshot.treeId &&
                  fresh.treeRevision > lease.snapshot.treeRevision &&
                  freshNode.frameId === action.frameId &&
                  freshNode.frameNavigationGeneration === action.frameNavigationGeneration &&
                  forest(fresh) === forest(lease.snapshot) &&
                  streamCell &&
                  !streamCell.closed &&
                  performance.now() < streamCell.end &&
                  streamCell.sequence < 128
                ) {
                  guard();
                  const event = SemanticEventV1Schema.parse({
                    version: 1,
                    sequence: streamCell.sequence + 1,
                    eventStreamId: stream.eventStreamId,
                    identity: admissionIdentity(fresh),
                    type: 'dirty',
                    reason: 'domChanged',
                    editRequestId: action.requestId,
                  });
                  if (streamCell.events.length >= 128)
                    throw denied(authority, 'VM_SEMANTIC_EVENT_BANK');
                  streamCell.sequence = event.sequence;
                  streamCell.identity = event.identity;
                  streamCell.revision = fresh.treeRevision;
                  streamCell.events.push(event);
                  continuationEnd = leases.get(scope.tab).get(fresh.semanticLeaseId).end;
                  editContinuation = {
                    identity: Object.fromEntries(
                      [
                        'version',
                        'browserId',
                        'browserGeneration',
                        'tabId',
                        'navigationGeneration',
                        'viewportVersion',
                        'treeId',
                        'treeRevision',
                        'epoch',
                        'inputGeneration',
                        'grantRevision',
                        'semanticLeaseId',
                      ].map((key) => [key, fresh[key]])
                    ),
                    frameId: freshNode.frameId,
                    frameNavigationGeneration: freshNode.frameNavigationGeneration,
                    nodeRef: freshNode.nodeRef,
                    focusRevision: fresh.focusRevision,
                    expiresInMs: Math.max(1, Math.floor(Math.min(2000, fresh.expiresInMs))),
                    eventStreamId: stream.eventStreamId,
                    coveredEventSequence: event.sequence,
                    allowedKinds:
                      freshNode.editKind === 'secret'
                        ? ['writeSecret']
                        : ['insertText', 'replaceText', 'key'],
                  };
                }
              }
            },
          });
          // Consumption failures retain the exact original issuer cleanup scope.
          consumeSemanticInputWork(work, owner);
          const guard = () => {
            scope.check();
            if (!semanticInputCurrent(work, owner)) throw denied(authority, 'VM_SEMANTIC_WORK');
          };
          await executeSemanticInputWork(work, owner, signal, guard, async (step) => {
            guard();
            scope.tab.inputEntered = true;
            if (step.kind === 'text') await session.text(scope.binding.tabId, step.text);
            else if (step.kind === 'keyDown' || step.kind === 'keyUp') {
              if (step.kind === 'keyDown') scope.tab.keys.add(step.key);
              const code =
                { Shift: 'ShiftLeft', Control: 'ControlLeft', Alt: 'AltLeft', Meta: 'MetaLeft' }[
                  step.key
                ] ?? step.key;
              await session.key(
                scope.binding.tabId,
                step.kind,
                step.key === 'Space' ? ' ' : step.key,
                code
              );
              if (step.kind === 'keyUp') scope.tab.keys.delete(step.key);
            } else throw bad('VM_SEMANTIC_NATIVE_STEP');
            guard();
          });
          guard();
          await scope.fence();
          const identity = admissionIdentity(action.identity);
          scope.onPublish(() => {
            scope.check();
            if (editContinuation) {
              if (performance.now() >= continuationEnd || streamCell.closed)
                throw denied(authority, 'VM_SEMANTIC_CONTINUATION_EXPIRED');
              editContinuation = {
                ...editContinuation,
                expiresInMs: Math.max(1, Math.floor(continuationEnd - performance.now())),
              };
            }
            return SemanticReceiptV1Schema.parse({
              version: 1,
              requestId: action.requestId,
              identity,
              outcome: 'completed',
              ...(editContinuation ? { editContinuation } : {}),
            });
          });
        } catch (value) {
          if (scope.tab.keys.size || scope.tab.buttons.size || scope.tab.composing)
            try {
              await scope.record.neutralizeInput(scope.tab);
            } catch {
              void scope.record.retire('engineFault');
            }
          throw value;
        } finally {
          if (work) {
            settleSemanticInputWork(work, owner);
            inputIssuer.invalidate(work);
          }
        }
      });
    },
    read(binding, authority, signal) {
      return enter(binding, authority, signal, async (scope) => {
        const session = scope.record.originalSession(),
          original = await session.semantic('semantic-read', scope.binding.tabId);
        scope.check();
        const value = inspectOriginalSemanticObservation(
          original,
          session,
          scope.binding.tabId,
          'semantic-read'
        );
        await scope.fence();
        const snapshot = publish(scope, value);
        scope.onPublish(() => {
          const row = selected(scope.tab, snapshot.semanticLeaseId, scope);
          if (!row) throw denied(authority, 'VM_SEMANTIC_LEASE_EXPIRED');
          return SemanticSnapshotV1Schema.parse({
            ...snapshot,
            expiresInMs: Math.max(1, Math.floor(row.end - performance.now())),
          });
        });
        return snapshot;
      });
    },
    openStream(binding, id, authority, signal) {
      id = BrowserReferenceSchema.parse(id);
      return enter(binding, authority, signal, async (scope) => {
        const lease = selected(scope.tab, id, scope);
        if (!lease) throw denied(authority, 'VM_SEMANTIC_LEASE');
        let bank = streams.get(scope.tab);
        if (!bank) streams.set(scope.tab, (bank = new Set()));
        if (bank.size >= 8) throw denied(authority, 'VM_SEMANTIC_STREAM_BANK');
        const session = scope.record.originalSession(),
          readChanges = async () => {
            const original = await session.semantic('semantic-changes', scope.binding.tabId),
              value = inspectOriginalSemanticObservation(
                original,
                session,
                scope.binding.tabId,
                'semantic-changes'
              );
            if (
              !value ||
              Object.keys(value).sort().join(',') !== 'dirty,revision' ||
              typeof value.dirty !== 'boolean' ||
              !Number.isSafeInteger(value.revision) ||
              value.revision < 0
            )
              throw bad('VM_SEMANTIC_CHANGES');
            return value;
          };
        const initial = await readChanges();
        scope.check();
        const identity = Object.fromEntries(
          [
            'version',
            'browserId',
            'browserGeneration',
            'tabId',
            'navigationGeneration',
            'viewportVersion',
            'treeId',
            'treeRevision',
            'epoch',
            'inputGeneration',
            'grantRevision',
          ].map((key) => [key, lease.snapshot[key]])
        );
        const capturedIdentity = SemanticAdmissionIdentityV1Schema.parse(identity),
          eventStreamId = refs(),
          end = performance.now() + 300000;
        const streamCell = {
          closed: false,
          actor: scope.actor,
          grant: scope.grant,
          end,
          identity: capturedIdentity,
          sequence: 0,
          revision: initial.revision,
          events: [],
        };
        let closed = false,
          pending,
          closing,
          nextAt = 0,
          delivered = false;
        const stream = Object.freeze({
          eventStreamId,
          next() {
            if (closed || pending || performance.now() < nextAt)
              return Promise.reject(denied(authority, 'VM_SEMANTIC_STREAM_PENDING'));
            nextAt = performance.now() + 200;
            const original = enter(scope.binding, authority, signal, async (current) => {
              if (
                closed ||
                current.tab !== scope.tab ||
                performance.now() >= end ||
                (streamCell.sequence >= 128 && streamCell.events.length === 0)
              )
                throw denied(authority, 'VM_SEMANTIC_STREAM_CLOSED');
              if (streamCell.events.length) {
                const event = streamCell.events[0];
                current.onPublish(() => {
                  current.check();
                  if (closed || streamCell.events[0] !== event)
                    throw denied(authority, 'VM_SEMANTIC_STREAM_CLOSED');
                  streamCell.events.shift();
                  delivered = true;
                  return event;
                });
                return;
              }
              const observed = await readChanges();
              current.check();
              if (closed) throw denied(authority, 'VM_SEMANTIC_STREAM_CLOSED');
              if (delivered && observed.revision === streamCell.revision) return null;
              const event = SemanticEventV1Schema.parse({
                version: 1,
                sequence: streamCell.sequence + 1,
                eventStreamId,
                identity: streamCell.identity,
                ...(delivered
                  ? { type: 'dirty', reason: 'domChanged' }
                  : { type: 'ready', reason: 'initial' }),
              });
              current.onPublish(() => {
                current.check();
                if (closed) throw denied(authority, 'VM_SEMANTIC_STREAM_CLOSED');
                streamCell.sequence = event.sequence;
                delivered = true;
                streamCell.revision = observed.revision;
                return event;
              });
            });
            pending = original;
            void original.then(
              () => {
                if (pending === original) pending = undefined;
              },
              () => {
                if (pending === original) pending = undefined;
              }
            );
            return original;
          },
          close() {
            closed = true;
            streamCell.closed = true;
            return (closing ??= Promise.resolve().then(async () => {
              try {
                if (pending) await pending;
              } finally {
                bank.delete(stream);
              }
            }));
          },
        });
        scope.check();
        streamCells.set(stream, streamCell);
        bank.add(stream);
        scope.onUnpublished(() => stream.close());
        return stream;
      });
    },
    resolve(binding, id, node, authority, signal) {
      id = BrowserReferenceSchema.parse(id);
      node = BrowserReferenceSchema.parse(node);
      return enter(binding, authority, signal, async (scope) => {
        const row = selected(scope.tab, id, scope);
        if (!row || !row.snapshot.nodes.some((item) => item.nodeRef === node)) return false;
        const session = scope.record.originalSession(),
          original = await session.semantic('semantic-resolve', scope.binding.tabId, {
            lease: row.guestLease,
            node,
          });
        scope.check();
        const value = inspectOriginalSemanticObservation(
          original,
          session,
          scope.binding.tabId,
          'semantic-resolve'
        );
        if (
          !value ||
          Object.keys(value).join(',') !== 'resolved' ||
          typeof value.resolved !== 'boolean'
        )
          throw bad('VM_SEMANTIC_RESOLVE');
        await scope.fence();
        return value.resolved && selected(scope.tab, id, scope) === row;
      });
    },
  });
}
