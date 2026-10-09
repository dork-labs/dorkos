import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createOriginalVMSemanticDispatcher } from '../semantic-dispatcher.mjs';
import { createOriginalSemanticProtocol } from '../../runtime/semantic-protocol.mjs';
import { encodeSemanticChunk } from '../../runtime/guest/semantic-wire.mjs';
// Policy ports only: no release/profile/native/broker/session admission token is
// minted. Observations DO use the original correlated semantic receiver and the
// dispatcher DOES consume the real canonical private semantic input Work.
const ref = (value: string) => value.repeat(22);
const binding = Object.freeze({
  browserId: ref('b'),
  browserGeneration: 1,
  tabId: ref('t'),
  navigationGeneration: 2,
  viewportVersion: 0,
  epoch: 3,
  inputGeneration: 4,
});
const snapshot = (revision = 1, value = 'old') => ({
  guestLease: ref(revision === 1 ? 'g' : 'j'),
  treeRef: ref('r'),
  revision,
  capturedAt: new Date().toISOString(),
  expiresInMs: 2000,
  rootRefs: [ref('n')],
  nodes: [
    {
      nodeRef: ref('n'),
      frameId: ref('f'),
      frameNavigationGeneration: 1,
      parentRef: null,
      childRefs: [],
      role: 'textbox',
      name: 'Field',
      value,
      states: { focused: true },
      editKind: 'plainText',
      actions: ['focus', 'insertText', 'replaceText', 'key'],
      redacted: false,
      truncated: false,
    },
  ],
  focusedRef: ref('n'),
  focusState: 'node',
  focusRevision: 0,
  completeness: 'complete',
});
function fixture() {
  let request = 0,
    refreshes = 0,
    revokeAt = 0,
    allowed = true,
    revision = 1,
    tail = Promise.resolve();
  const inputs: unknown[] = [],
    retired: string[] = [],
    commands: string[] = [];
  let failKeyUp: undefined | { value: unknown }, failNeutral: undefined | { value: unknown };
  const tab = {
    keys: new Set<string>(),
    buttons: new Set<string>(),
    composing: false,
    inputEntered: false,
  };
  const wire = createOriginalSemanticProtocol({
    guard() {},
    originalSession: (): unknown => session,
    request(body: any) {
      const pending = { ...body, request: ++request };
      commands.push(body.action);
      let value: any;
      if (body.action === 'semantic-read') value = snapshot();
      else if (body.action === 'semantic-resolve') value = { resolved: true };
      else if (body.action === 'semantic-changes') value = { revision, dirty: false };
      else if (body.action === 'semantic-effect')
        value = {
          state: {
            connected: true,
            focused: true,
            disabled: false,
            readonly: false,
            kind: 'plainText',
            selectedAll: true,
          },
        };
      else if (body.action === 'semantic-edit-finish') {
        revision = 2;
        value = { snapshot: snapshot(2, 'new'), correlated: true };
      } else value = { entered: true };
      const bytes = Buffer.from(JSON.stringify(value)),
        sha256 = createHash('sha256').update(bytes).digest('hex'),
        base = { request: pending.request, tabId: binding.tabId };
      wire.consume(pending, {
        ...base,
        event: 'semantic-result-begin',
        action: body.action,
        bytes: bytes.length,
        chunks: Math.ceil(bytes.length / 61440),
        sha256,
      });
      for (let offset = 0, sequence = 0; offset < bytes.length; offset += 61440, sequence++)
        wire.frame(
          pending,
          encodeSemanticChunk({ ...base, sequence }, bytes.subarray(offset, offset + 61440))
        );
      wire.consume(pending, { ...base, event: 'semantic-result-end', sha256 });
      return Promise.resolve(
        wire.consume(pending, { ...base, event: 'semantic-completed', action: body.action }).value
      );
    },
  });
  const session = {
    semantic: wire.request,
    key: async (_tab: string, event: string, key: string) => {
      inputs.push({ event, key });
      if (event === 'keyUp' && failKeyUp) throw failKeyUp.value;
    },
    text: async (_tab: string, text: string) => {
      inputs.push({ text });
    },
  };
  const record = {
    exactTab(value: any) {
      if (Object.keys(binding).some((key) => value[key] !== binding[key as keyof typeof binding]))
        throw new Error('POLICY_FIXTURE_STALE');
      return tab;
    },
    dispatch(enter: () => unknown) {
      const job = tail.then(enter);
      tail = job.then(
        () => {},
        () => {}
      );
      return job;
    },
    originalSession: (): unknown => session,
    retire(reason: string) {
      retired.push(reason);
      return Promise.resolve();
    },
    async neutralizeInput() {
      inputs.push({ neutralize: true });
      if (failNeutral) throw failNeutral.value;
      tab.keys.clear();
    },
  };
  const authority = {
    actorKey: ref('a'),
    grantKey: ref('q'),
    grantRevision: 0,
    isCurrent: () => allowed,
    async refresh() {
      refreshes++;
      if (refreshes === revokeAt) allowed = false;
    },
    isOriginalRefusal: () => false,
    onOriginalDenial() {},
    input: {
      isCurrent: () => allowed,
      async authorize() {
        return 'allowed' as const;
      },
    },
    secretCurrent: () => false,
  };
  const dispatcher = createOriginalVMSemanticDispatcher(
    { get: () => record },
    {
      async authorizeAction() {
        return allowed ? ('allowed' as const) : ('refused' as const);
      },
    }
  );
  return {
    dispatcher,
    authority,
    inputs,
    retired,
    commands,
    signal: new AbortController().signal,
    revokeFinal() {
      revokeAt = refreshes + 2;
    },
    allow() {
      allowed = true;
      revokeAt = 0;
    },
    faults(original: unknown, cleanup: unknown) {
      failKeyUp = { value: original };
      failNeutral = { value: cleanup };
    },
  };
}
const identity = (value: any) =>
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
      'semanticLeaseId',
      'epoch',
      'inputGeneration',
      'grantRevision',
    ].map((key) => [key, value[key]])
  );
describe('VM semantic dispatcher controlled original policy integration', () => {
  it('read -> stream -> real private Work edit -> exact dirty event -> continued edit', async () => {
    const f = fixture(),
      read = await f.dispatcher.read(binding, f.authority, f.signal),
      stream = await f.dispatcher.openStream(binding, read.semanticLeaseId, f.authority, f.signal);
    try {
      const receipt = await f.dispatcher.action(
        {
          requestId: ref('u'),
          identity: identity(read),
          frameId: ref('f'),
          frameNavigationGeneration: 1,
          nodeRef: ref('n'),
          focusRevision: 0,
          eventStreamId: stream.eventStreamId,
          action: { kind: 'insertText', text: 'new' },
        },
        f.authority,
        f.signal
      );
      if (receipt.outcome !== 'completed') throw new Error('EXPECTED_COMPLETED_SEMANTIC_RECEIPT');
      expect(receipt.editContinuation).toBeDefined();
      expect(receipt.editContinuation!.identity.semanticLeaseId).not.toBe(read.semanticLeaseId);
      const dirty = await stream.next();
      expect(dirty).toMatchObject({
        type: 'dirty',
        sequence: 1,
        editRequestId: ref('u'),
        identity: { treeId: read.treeId, treeRevision: 2 },
      });
      expect(dirty!.sequence).toBe(receipt.editContinuation!.coveredEventSequence);
      expect(f.inputs).toEqual([{ text: 'new' }]);
      expect(f.retired).toEqual([]);
      const next = receipt.editContinuation!;
      expect(
        await f.dispatcher.resolve(
          binding,
          next.identity.semanticLeaseId,
          next.nodeRef,
          f.authority,
          f.signal
        )
      ).toBe(true);
    } finally {
      await stream.close();
    }
  });
  it('final authority denial removes newly minted stream and lease before publication', async () => {
    const f = fixture();
    for (let i = 0; i < 9; i++) {
      f.revokeFinal();
      await expect(f.dispatcher.read(binding, f.authority, f.signal)).rejects.toThrow();
      f.allow();
    }
    const read = await f.dispatcher.read(binding, f.authority, f.signal);
    for (let i = 0; i < 9; i++) {
      f.revokeFinal();
      await expect(
        f.dispatcher.openStream(binding, read.semanticLeaseId, f.authority, f.signal)
      ).rejects.toThrow();
      f.allow();
    }
    const originals = [];
    try {
      for (let i = 0; i < 8; i++)
        originals.push(
          await f.dispatcher.openStream(binding, read.semanticLeaseId, f.authority, f.signal)
        );
      expect(originals).toHaveLength(8);
    } finally {
      await Promise.all(originals.map((stream) => stream.close()));
    }
    expect(f.retired).toEqual([]);
  });
  it('final denied event publication retains sequence and payload for the later authorized next', async () => {
    const f = fixture(),
      read = await f.dispatcher.read(binding, f.authority, f.signal),
      stream = await f.dispatcher.openStream(binding, read.semanticLeaseId, f.authority, f.signal);
    try {
      f.revokeFinal();
      await expect(stream.next()).rejects.toThrow();
      f.allow();
      await new Promise((resolve) => setTimeout(resolve, 205));
      expect(await stream.next()).toMatchObject({ sequence: 1, type: 'ready' });
    } finally {
      await stream.close();
    }
  });
  for (const original of [false, undefined])
    it(
      'original falsy key release failure survives independent cleanup failure ' + String(original),
      async () => {
        const f = fixture(),
          read = await f.dispatcher.read(binding, f.authority, f.signal);
        f.faults(original, new Error('secondary neutralization'));
        let caught = false;
        try {
          await f.dispatcher.action(
            {
              requestId: ref('u'),
              identity: identity(read),
              frameId: ref('f'),
              frameNavigationGeneration: 1,
              nodeRef: ref('n'),
              focusRevision: 0,
              action: { kind: 'key', key: 'Tab' },
            },
            f.authority,
            f.signal
          );
        } catch (value) {
          caught = true;
          expect(value).toBe(original);
        }
        expect(caught).toBe(true);
        expect(f.inputs).toEqual([
          { event: 'keyDown', key: 'Tab' },
          { event: 'keyUp', key: 'Tab' },
          { neutralize: true },
        ]);
        expect(f.retired).toContain('engineFault');
      }
    );
});
