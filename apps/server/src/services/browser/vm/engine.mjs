import { URL } from 'node:url';
import { createOriginalVMSemanticDispatcher } from './semantic-dispatcher.mjs';
import { parseBrowserBinding } from '@dorkos/browser/server-owner';
import { issueOriginalVMRuntimeSubject } from '../runtime/runtime-subject.mjs';
import { randomBytes } from 'node:crypto';
import { parseBrowserCommand, parseBrowserResult } from '@dorkos/browser';
import { BrowserRegistryStore } from '../registry/store.js';
import { acquireOriginalRegistryManagedVM } from '../runtime/registry-vm-acquisition.mjs';
import { createOriginalVMRecordOwner } from './record.mjs';
import { installOriginalVMDispatchers } from './dispatchers.mjs';
const { AbortController } = globalThis;
const refused = (code) => new Error(code);
/** Server-private lifecycle constructor. Original installed release and production
 * network capabilities remain mandatory; this constructor mints neither. */
export function constructOriginalManagedVMEngine({
  registry,
  owner,
  dataHome,
  release,
  width,
  height,
  birthOwner,
  policy,
  policyRevision,
}) {
  if (!(registry instanceof BrowserRegistryStore) || typeof owner !== 'string' || !owner)
    throw refused('VM_ORIGINAL_REGISTRY_REQUIRED');
  const birth = birthOwner.registerBirth.bind(birthOwner),
    refuseBirth = birthOwner.refuseBirth.bind(birthOwner);
  const network = birthOwner.network;
  if (!network || !birthOwner.capture || !birthOwner.input || !birthOwner.navigation)
    throw refused('VM_ORIGINAL_OWNERS_REQUIRED');
  const authorize = policy.authorizeAction.bind(policy);
  const records = createOriginalVMRecordOwner(),
    live = new Set(),
    opening = new Set();
  let stopping = false,
    shutdown;
  installOriginalVMDispatchers(records, birthOwner, policy);
  if (!birthOwner.semantic) throw refused('VM_ORIGINAL_SEMANTIC_OWNER_REQUIRED');
  const registerSemantic = birthOwner.semantic.registerDispatcher.bind(birthOwner.semantic);
  registerSemantic(createOriginalVMSemanticDispatcher(records, policy));
  const find = (binding) => records.get(binding.browserId, binding.browserGeneration);
  const closeRecord = async (record, requestId) => {
    await record.retire('explicitStop');
    return parseBrowserResult({
      kind: 'close',
      requestId,
      browserId: record.browserId,
      browserGeneration: record.browserGeneration,
      cleanup: 'unverified',
      reason: 'observationUnavailable',
    });
  };
  const engine = Object.freeze({
    open(value) {
      if (stopping) return Promise.reject(refused('VM_ENGINE_STOPPED'));
      const command = parseBrowserCommand(value);
      if (command.kind !== 'open') throw refused('VM_OPEN_COMMAND');
      const record = records.issue(command);
      live.add(record);
      // Reserve the opening original before constructor-private callbacks execute.
      const original = record.own(async () => {
        try {
          if (stopping) throw refused('VM_ENGINE_STOPPED');
          const subject = await issueOriginalVMRuntimeSubject(release, policyRevision);
          record.attachOriginalRuntimeSubject(subject, release);
          record.guard();
          birth(record.receiver);
          record.guard();
          const session = acquireOriginalRegistryManagedVM({
            registry,
            owner,
            receiver: record.receiver,
            release,
            dataHome,
            network,
            width,
            height,
          });
          record.attachOriginalSession(session);
          await session.opening;
          record.guard();
          const tab = await record.publishTab();
          record.guard();
          return parseBrowserResult({
            kind: 'opened',
            requestId: command.requestId,
            browserId: record.browserId,
            browserGeneration: record.browserGeneration,
            tab,
            ...(command.mode === 'persistent'
              ? { mode: 'persistent', profileId: command.profileId }
              : { mode: 'ephemeral' }),
          });
        } catch (value) {
          try {
            refuseBirth(record.receiver);
          } catch {
            /* Preserve the original admission failure; record.own retains retirement and cleanup. */
          }
          throw value;
        }
      });
      opening.add(original);
      void original.then(
        () => opening.delete(original),
        () => opening.delete(original)
      );
      void record.receiver.observation.then(() => {
        try {
          records.get(record.browserId, record.browserGeneration);
        } catch {
          live.delete(record);
        }
      });
      // Private first-document navigation has its own one-use owner; it cannot
      // supply a reusable human navigation authorization or arbitrary Page.
      let initial = false;
      record.installInitialNavigation((value) => {
        const command = parseBrowserCommand(value);
        if (command.kind !== 'navigate') throw refused('VM_NAVIGATION_COMMAND');
        const tab = record.exactTab(command.binding);
        if (
          initial ||
          tab.keys.size ||
          tab.buttons.size ||
          tab.composing ||
          tab.inputEntered ||
          tab.binding.navigationGeneration !== 0
        )
          throw refused('VM_INITIAL_NAVIGATION_OCCURRENCE');
        const u = new URL(command.url);
        if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash)
          throw refused('VM_INITIAL_NAVIGATION_URL');
        initial = true;
        return record.dispatch(async () => {
          record.exactTab(command.binding);
          const abort = new AbortController();
          try {
            if ((await authorize(command.binding, abort.signal)) !== 'allowed')
              throw refused('VM_ENGINE_POLICY_REFUSED');
            record.exactTab(command.binding);
            await record.originalSession().navigate(command.binding.tabId, command.url);
            const binding = tab.binding;
            record.exactTab(binding);
            if ((await authorize(binding, abort.signal)) !== 'allowed')
              throw refused('VM_ENGINE_POLICY_REFUSED');
            record.exactTab(binding);
            return binding;
          } finally {
            abort.abort();
          }
        });
      });
      return original;
    },
    listTabs(browserId, browserGeneration) {
      return records.get(browserId, browserGeneration).listTabs();
    },
    capture() {
      return Promise.reject(refused('VM_PRIVATE_CAPTURE_AUTHORITY_REQUIRED'));
    },
    input(value) {
      const command = parseBrowserCommand(value);
      if (command.kind !== 'input') throw refused('VM_INPUT_COMMAND');
      return Promise.resolve(
        parseBrowserResult({
          kind: 'action',
          requestId: command.requestId,
          binding: command.binding,
          outcome: 'rejected',
          reason: 'policyRefused',
        })
      );
    },
    diagnostics(value) {
      const binding = parseBrowserBinding(value);
      return find(binding).diagnostics(binding);
    },
    async resetInput(value) {
      const binding = parseBrowserBinding(value),
        record = find(binding);
      try {
        return Object.freeze({ binding: await record.resetInput(binding), status: 'ready' });
      } catch {
        void record.retire('engineFault');
        return Object.freeze({ binding, status: 'stopped' });
      }
    },
    close(value) {
      const command = parseBrowserCommand(value);
      if (command.kind !== 'close') throw refused('VM_CLOSE_COMMAND');
      return closeRecord(
        records.get(command.browserId, command.browserGeneration),
        command.requestId
      );
    },
    shutdown() {
      if (shutdown) return shutdown;
      stopping = true;
      const snapshot = [...live];
      const closes = snapshot.map((record) =>
        closeRecord(record, randomBytes(16).toString('base64url'))
      );
      shutdown = (async () => {
        await Promise.allSettled([...opening]);
        const rows = await Promise.allSettled(closes);
        for (const row of rows) if (row.status === 'rejected') throw row.reason;
        return Object.freeze(rows.map((row) => row.value));
      })();
      return shutdown;
    },
  });
  return engine;
}
