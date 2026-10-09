import { NativeSemanticTargetSchema, NativeSemanticChangesSchema } from './native-target.js';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Page, CDPSession } from 'playwright-core';
import {
  SemanticSnapshotV1Schema,
  SemanticIdentityV1Schema,
  type SemanticIdentityV1,
  type SemanticSnapshotV1,
  type SemanticAdmissionIdentityV1,
} from '@dorkos/shared/browser-semantic-schemas';
import {
  projectSuppliedSemanticForest,
  type SuppliedSemanticObservation,
} from '@dorkos/shared/browser-semantic-sanitizer';

const role = (value: unknown): string => {
  const key = String(value ?? 'unknown').toLowerCase();
  return (
    (
      {
        rootwebarea: 'document',
        webarea: 'document',
        statictext: 'text',
        inlinetextbox: 'text',
        genericcontainer: 'generic',
        textfield: 'textbox',
      } as Record<string, string>
    )[key] ?? key
  );
};
const id = () => randomBytes(16).toString('base64url');
class SemanticRefusal extends Error {}
class SemanticUnstable extends SemanticRefusal {}
const MAX_NODES = 2000,
  MAX_FRAMES = 32,
  MAX_DEPTH = 32,
  DEADLINE = 1000;
const inspected = z
  .object({
    connected: z.boolean(),
    kind: z.enum(['none', 'plainText', 'secret', 'file', 'unknownSensitive']),
    disabled: z.boolean(),
    readonly: z.boolean(),
    value: z.string().max(2048).optional(),
    oversized: z.boolean(),
    focused: z.boolean(),
  })
  .strict();
// Fixed isolated-world inspector. Secret/file/unknown values are never evaluated or returned.
const INSPECT = `function(doc) {
 if(doc===globalThis.document && this===doc && this.nodeType===9)return {connected:true,kind:'none',disabled:false,readonly:false,oversized:false,focused:false};
 if(doc!==globalThis.document)return {connected:false,kind:'none',disabled:false,readonly:false,oversized:false,focused:false};
 const element=this.nodeType===1?this:this.parentElement;
 if(!element || !element.isConnected || element.ownerDocument!==doc) return {connected:false,kind:'none',disabled:false,readonly:false,oversized:false,focused:false};
 const tag=element.localName; let kind='none', value, oversized=false;
 if(tag==='input') { const type=element.type; kind=type==='password'?'secret':type==='file'?'file':['text','search','email','tel','url'].includes(type)?'plainText':['checkbox','radio','button','submit','reset','range','number'].includes(type)?'none':'unknownSensitive'; }
 else if(tag==='textarea') kind='plainText';
 else if(element.isContentEditable) kind='unknownSensitive';
 if(kind==='plainText') { const nativeValue=element.value; oversized=nativeValue.length>2048 || new TextEncoder().encode(nativeValue).length>2048; if(!oversized)value=nativeValue; }
 let active=doc.activeElement;for(let depth=0;depth<32&&active?.shadowRoot?.activeElement;depth++)active=active.shadowRoot.activeElement;const focused=active===element&&typeof doc.hasFocus==='function'&&doc.hasFocus();
 return {connected:true,kind,focused,disabled:element.disabled===true,readonly:element.readOnly===true,oversized,...(value===undefined?{}:{value})};
}`;
// Mutation notifications contain only a fixed signal; no website strings enter IPC.
const OBSERVE = `(() => {
 let editing=null, phase=null, inputs=0, selections=0, unexpected=false;
 const notify=(reason)=>globalThis.__dorkSemanticDirty(reason);
 const observer=new MutationObserver(records=>{if(editing)unexpected=true;notify('dirty');for(const record of records)for(const node of record.addedNodes)scan(node);});
 const roots=new WeakSet();let charged=0;
 function scan(start){const stack=[{node:start,depth:0}];while(stack.length&&charged<2000){const {node,depth}=stack.pop();charged++;if(depth>32)continue;if(node.shadowRoot&&!roots.has(node.shadowRoot)){roots.add(node.shadowRoot);observer.observe(node.shadowRoot,{subtree:true,childList:true,attributes:true,characterData:true});stack.push({node:node.shadowRoot,depth:depth+1});}let child=node.firstChild;while(child&&stack.length+charged<2000){stack.push({node:child,depth:depth+1});child=child.nextSibling;}}}
 observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});scan(document);
 const changed=(event)=>{
  let active=document.activeElement;for(let i=0;i<32&&active?.shadowRoot?.activeElement;i++)active=active.shadowRoot.activeElement;
  if(editing&&event.isTrusted&&active===editing&&event.type==='input'&&event.composedPath()[0]===editing&&phase==='input'){inputs++;notify('editInput');return;}
  if(editing&&event.isTrusted&&active===editing&&event.type==='selectionchange'&&(phase==='selection'||phase==='input')){selections++;notify('editSelection');return;}
  if(editing)unexpected=true;notify('dirty');
 };
 const events=['focusin','focusout','input','selectionchange'];for(const event of events)document.addEventListener(event,changed,true);
 return {arm(node){if(editing||!node.isConnected||node.ownerDocument!==document)return false;editing=node;phase=null;inputs=0;selections=0;unexpected=false;return true;},step(value){if(!editing||!['input','selection','idle'].includes(value))return false;phase=value==='idle'?null:value;return true;},finish(){const result={inputs,selections,unexpected};editing=null;phase=null;return result;},close(){observer.disconnect();editing=null;phase=null;for(const event of events)document.removeEventListener(event,changed,true);}};
})()`;
async function isolatedWorld(
  session: Pick<CDPSession, 'send'>,
  frameId: string,
  worldName: string
) {
  return session.send('Page.createIsolatedWorld', {
    frameId,
    worldName,
    grantUniveralAccess: false,
  });
}
async function axRoot(session: Pick<CDPSession, 'send'>, frameId: string) {
  return (await session.send('Accessibility.getRootAXNode', { frameId })).node;
}
type AXNode = Awaited<ReturnType<typeof axRoot>>;
type FrameRecord = {
  session: CDPSession;
  nativeId: string;
  frameId: string;
  generation: number;
  document: string;
  contextId: number;
  group: string;
  observer?: string;
  dirty: boolean;
  replaced: boolean;
  off: () => void;
};
type BoundNode = {
  object: string;
  frame: FrameRecord;
  backend: number;
  fingerprint: string;
  ref: string;
  observation: SuppliedSemanticObservation;
  parentId: string | undefined;
  childIds: readonly string[];
  axId: string;
};
type Lease = {
  readonly: boolean;
  identity: SemanticIdentityV1;
  actor: string;
  grant: string;
  end: number;
  revision: number;
  refs: Set<string>;
  snapshot: SemanticSnapshotV1;
};

/** One captured original CDP event listener fans out to this session's bounded frame records.
 * Membership and the removal duty are retained before native on() can reenter close. */
function originalFrameEvent<Args extends unknown[]>(
  on: (listener: (...args: Args) => void) => unknown,
  off: (listener: (...args: Args) => void) => unknown
) {
  const members = new Set<(...args: Args) => void>();
  const dispatch = (...args: Args) => {
    for (const listener of [...members]) listener(...args);
  };
  let listening = false;
  return {
    add(listener: (...args: Args) => void) {
      members.add(listener);
      if (!listening) {
        listening = true;
        on(dispatch);
      }
    },
    remove(listener: (...args: Args) => void) {
      if (members.delete(listener) && !members.size && listening) {
        listening = false;
        off(dispatch);
      }
    },
  };
}

/** A private supervisor-only Page reader; IPC caller authentication is an independent server prerequisite. */
export class SupervisedSemanticReader {
  private readonly frames = new Map<string, FrameRecord>();
  private originalRootSession?: CDPSession;
  private readonly originalFrameSlots = new Map<CDPSession, number>();
  private readonly sessions = new Set<CDPSession>();
  private readonly ports = new Map<
    CDPSession,
    {
      send: CDPSession['send'];
      detach: CDPSession['detach'];
      on: CDPSession['on'];
      off: CDPSession['off'];
    }
  >();
  private receiver(session: CDPSession) {
    let port = this.ports.get(session);
    if (!port) {
      port = {
        send: session.send.bind(session),
        detach: session.detach.bind(session),
        on: session.on.bind(session),
        off: session.off.bind(session),
      };
      this.ports.set(session, port);
    }
    return port;
  }
  private readonly frameEvents = new Map<
    CDPSession,
    {
      replaced: ReturnType<typeof originalFrameEvent<[]>>;
      axChanged: ReturnType<typeof originalFrameEvent<[{ nodes: AXNode[] }]>>;
      binding: ReturnType<
        typeof originalFrameEvent<[{ name: string; executionContextId: number; payload: string }]>
      >;
    }
  >();
  private originalFrameEvents(session: CDPSession) {
    let events = this.frameEvents.get(session);
    if (!events) {
      const original = this.receiver(session);
      events = {
        replaced: originalFrameEvent<[]>(
          (listener) => original.on('DOM.documentUpdated', listener),
          (listener) => original.off('DOM.documentUpdated', listener)
        ),
        axChanged: originalFrameEvent<[{ nodes: AXNode[] }]>(
          (listener) => original.on('Accessibility.nodesUpdated', listener),
          (listener) => original.off('Accessibility.nodesUpdated', listener)
        ),
        binding: originalFrameEvent<
          [{ name: string; executionContextId: number; payload: string }]
        >(
          (listener) => original.on('Runtime.bindingCalled', listener),
          (listener) => original.off('Runtime.bindingCalled', listener)
        ),
      };
      this.frameEvents.set(session, events);
    }
    return events;
  }
  private readonly starts: number[] = [];
  private readonly frameHistory = new Map<string, { frameId: string; generation: number }>();
  private readonly unsupported = new Map<string, string>();
  private frameLimited = false;
  private readonly leases = new Map<string, Lease>();
  private readonly observedScopes = new Map<string, number>();
  private editing?: {
    requestId: string;
    actor: string;
    grant: string;
    node: BoundNode;
    identity: SemanticIdentityV1;
    snapshot: SemanticSnapshotV1;
    observer: string;
    unexpected: boolean;
    phase: 'idle' | 'input' | 'selection';
  };
  private nodes = new Map<string, BoundNode>();
  private readonly nodeGroups = new Map<string, Set<CDPSession>>();
  private treeId = id();
  private revision = 0;
  private dirty = true;
  private closed = false;
  private pending?: Promise<SemanticSnapshotV1>;
  private resolving?: Promise<boolean>;
  private closing?: Promise<void>;
  private first?: { reason: unknown };
  private readonly originals = new Set<Promise<unknown>>();
  private readonly context: ReturnType<Page['context']>;
  private readonly acquire: ReturnType<Page['context']>['newCDPSession'];
  private readonly originalFrames: Page['frames'];
  private readonly originalClosed: Page['isClosed'];
  private readonly pageOff: Page['off'];
  constructor(private readonly page: Page) {
    this.context = page.context();
    this.acquire = this.context.newCDPSession.bind(this.context);
    this.originalFrames = page.frames.bind(page);
    this.originalClosed = page.isClosed.bind(page);
    this.pageOff = page.off.bind(page);
    this.removePageListeners = () => {
      for (const remove of this.listenerRemovers)
        try {
          remove();
        } catch (reason) {
          this.fail(reason);
        }
    };
  }
  private readonly removePageListeners: () => void;
  private readonly listenerRemovers: (() => void)[] = [];
  private started = false;
  private start(): void {
    if (this.started) return;
    this.started = true;
    const changed = () => {
      if (this.editing) this.editing.unexpected = true;
      for (const frame of this.frames.values()) frame.replaced = true;
      this.invalidate();
    };
    for (const receiver of [
      {
        listen: () => this.page.on('framenavigated', changed),
        remove: () => this.pageOff('framenavigated', changed),
      },
      {
        listen: () => this.page.on('frameattached', changed),
        remove: () => this.pageOff('frameattached', changed),
      },
      {
        listen: () => this.page.on('framedetached', changed),
        remove: () => this.pageOff('framedetached', changed),
      },
    ]) {
      this.listenerRemovers.push(receiver.remove);
      receiver.listen();
      if (this.closed) throw new SemanticRefusal('SEMANTIC_UNAVAILABLE');
    }
  }
  private fail(reason: unknown) {
    this.first ??= { reason };
  }
  private invalidate() {
    this.dirty = true;
    if (this.revision === Number.MAX_SAFE_INTEGER) this.closed = true;
    else this.revision++;
    this.leases.clear();
    for (const frame of this.frames.values()) frame.dirty = true;
  }
  private guard(end: number) {
    const gone = this.originalClosed(),
      time = performance.now();
    if (this.first) throw this.first.reason;
    if (this.closed || gone || time >= end) throw new SemanticRefusal('SEMANTIC_UNAVAILABLE');
  }
  private async own<T>(producer: () => Promise<T>): Promise<T> {
    let accept!: (value: T) => void, reject!: (reason: unknown) => void;
    const original = new Promise<T>((a, b) => {
      accept = a;
      reject = b;
    });
    this.originals.add(original);
    try {
      Promise.resolve(producer()).then(accept, reject);
    } catch (reason) {
      reject(reason);
    }
    try {
      return await original;
    } finally {
      this.originals.delete(original);
    }
  }
  /** Start one bounded extraction; deadline refusal retains every entered original until settlement. */
  read(
    identity: SemanticAdmissionIdentityV1,
    actor: string,
    grant: string
  ): Promise<SemanticSnapshotV1> {
    return this.run(identity, actor, grant, true);
  }
  private run(
    identity: SemanticAdmissionIdentityV1,
    actor: string,
    grant: string,
    issueLease: boolean
  ): Promise<SemanticSnapshotV1> {
    if (this.closed || this.pending || (issueLease && this.resolving))
      return Promise.reject(new SemanticRefusal('SEMANTIC_BUSY'));
    const time = performance.now();
    while (this.starts.length && this.starts[0]! <= time - 1000) this.starts.shift();
    if (this.starts.length >= 5) return Promise.reject(new SemanticRefusal('SEMANTIC_RATE'));
    const { treeId: _treeId, treeRevision: _treeRevision, ...binding } = identity;
    const context = JSON.stringify(binding);
    if (context !== this.admittedIdentity) {
      this.invalidate();
      this.admittedIdentity = context;
    }
    this.starts.push(time);
    const end = time + DEADLINE;
    // Preregister the completion before any native Page/session callback can reenter close.
    let accept!: (value: SemanticSnapshotV1) => void, reject!: (reason: unknown) => void;
    const original = new Promise<SemanticSnapshotV1>((a, b) => {
      accept = a;
      reject = b;
    });
    this.pending = original;
    void original.catch(() => {});
    void Promise.resolve()
      .then(async () => {
        this.start();
        for (let attempt = 0; attempt < 2; attempt++) {
          this.guard(end);
          try {
            const candidate = await this.extract(identity, actor, grant, end, issueLease);
            this.guard(end);
            if (!this.dirty && candidate.treeRevision === this.revision) return candidate;
            this.leases.delete(candidate.semanticLeaseId);
            throw new SemanticUnstable('SEMANTIC_UNSTABLE');
          } catch (reason) {
            if (!(reason instanceof SemanticUnstable) || attempt === 1) throw reason;
          }
        }
        throw new SemanticRefusal('SEMANTIC_UNSTABLE');
      })
      .then(accept, reject);
    void original.then(
      () => {
        if (this.pending === original) this.pending = undefined;
      },
      (reason) => {
        if (!(reason instanceof SemanticRefusal)) {
          this.fail(reason);
          this.closed = true;
          this.leases.clear();
        }
        if (this.pending === original) this.pending = undefined;
      }
    );
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      original,
      new Promise<never>((_a, b) => {
        timer = setTimeout(() => b(new SemanticRefusal('SEMANTIC_DEADLINE')), DEADLINE);
      }),
    ]).finally(() => clearTimeout(timer));
  }
  private async register(session: CDPSession, end: number): Promise<void> {
    this.sessions.add(session);
    this.guard(end);
    const tree = await this.own(() => this.receiver(session).send('Page.getFrameTree'));
    this.guard(end);
    const queue = [tree.frameTree];
    while (queue.length) {
      const item = queue.shift()!;
      if (this.frames.size + this.unsupported.size >= MAX_FRAMES) {
        this.frameLimited = true;
        break;
      }
      const nativeId = item.frame.id;
      // Target-local native frame identity, never URL/name/index matching.
      const key =
        (await this.own(() => this.receiver(session).send('Target.getTargetInfo'))).targetInfo
          .targetId +
        ':' +
        nativeId;
      this.guard(end);
      if (this.frames.has(key)) continue;
      const group = 'dork-semantic-' + id();
      this.nodeGroups.set(group, new Set([session]));
      const world = await this.own(() => isolatedWorld(this.receiver(session), nativeId, group));
      this.guard(end);
      const document = await this.own(() =>
        this.receiver(session).send('Runtime.evaluate', {
          expression: 'document',
          contextId: world.executionContextId,
          objectGroup: group,
          returnByValue: false,
        })
      );
      this.guard(end);
      if (!document.result.objectId || document.exceptionDetails)
        throw new SemanticRefusal('SEMANTIC_DOCUMENT');
      const prior = this.frameHistory.get(key);
      if (prior?.generation === Number.MAX_SAFE_INTEGER)
        throw new SemanticRefusal('SEMANTIC_GENERATION_EXHAUSTED');
      const frame: FrameRecord = {
        session,
        nativeId,
        frameId: prior?.frameId ?? id(),
        generation: prior ? prior.generation + 1 : 0,
        document: document.result.objectId,
        contextId: world.executionContextId,
        group,
        dirty: false,
        replaced: false,
        off: () => {},
      };
      const changed = () => {
        frame.dirty = true;
        this.invalidate();
      };
      const binding = (value: { name: string; executionContextId: number; payload: string }) => {
        if (value.name === '__dorkSemanticDirty' && value.executionContextId === frame.contextId) {
          const edit = this.editing;
          if (
            edit &&
            (edit.node.frame !== frame ||
              !(
                (value.payload === 'editInput' && edit.phase === 'input') ||
                (value.payload === 'editSelection' &&
                  (edit.phase === 'input' || edit.phase === 'selection'))
              ))
          )
            edit.unexpected = true;
          changed();
        }
      };
      const axChanged = (value: { nodes: AXNode[] }) => {
        const edit = this.editing;
        if (
          edit &&
          (edit.node.frame !== frame ||
            value.nodes.length > MAX_NODES ||
            value.nodes.some((entry) => entry.nodeId !== edit.node.axId))
        )
          edit.unexpected = true;
        changed();
      };
      const replaced = () => {
        if (this.editing) this.editing.unexpected = true;
        frame.replaced = true;
        changed();
      };
      const originalEvents = this.originalFrameEvents(session);
      frame.off = () => {
        let first: { reason: unknown } | undefined;
        for (const remove of [
          () => originalEvents.replaced.remove(replaced),
          () => originalEvents.axChanged.remove(axChanged),
          () => originalEvents.binding.remove(binding),
        ])
          try {
            remove();
          } catch (reason) {
            first ??= { reason };
          }
        if (first) throw first.reason;
      };
      this.frames.set(key, frame);
      for (const prior of this.unsupported.keys())
        if (prior.endsWith(':' + nativeId)) this.unsupported.delete(prior);
      originalEvents.replaced.add(replaced);
      this.guard(end);
      originalEvents.axChanged.add(axChanged);
      this.guard(end);
      originalEvents.binding.add(binding);
      this.guard(end);
      await this.own(() => this.receiver(session).send('DOM.enable'));
      this.guard(end);
      await this.own(() => this.receiver(session).send('Accessibility.enable'));
      this.guard(end);
      await this.own(() =>
        this.receiver(session).send('Runtime.addBinding', {
          name: '__dorkSemanticDirty',
          executionContextId: frame.contextId,
        })
      );
      this.guard(end);
      const observer = await this.own(() =>
        this.receiver(session).send('Runtime.evaluate', {
          expression: OBSERVE,
          contextId: frame.contextId,
          objectGroup: group,
          returnByValue: false,
        })
      );
      frame.observer = observer.result.objectId;
      this.guard(end);
      if (!frame.observer || observer.exceptionDetails)
        throw new SemanticRefusal('SEMANTIC_OBSERVER_UNAVAILABLE');
      const children = item.childFrames ?? [];
      if (children.length + queue.length > MAX_FRAMES) this.frameLimited = true;
      queue.push(...children.slice(0, Math.max(0, MAX_FRAMES - queue.length)));
    }
  }
  private async extract(
    identity: SemanticAdmissionIdentityV1,
    actor: string,
    grant: string,
    end: number,
    issueLease: boolean
  ): Promise<SemanticSnapshotV1> {
    // A dirty document retires old remote handles before a new reference cohort is issued.
    if ([...this.frames.values()].some((frame) => frame.replaced)) await this.releaseFrames();
    if (!this.sessions.size) {
      const frames = this.originalFrames();
      this.guard(end);
      const main = await this.own(() => this.acquire(this.page));
      this.sessions.add(main);
      this.originalRootSession = main;
      this.guard(end);
      await this.register(main, end);
      if (frames.length > MAX_FRAMES) this.frameLimited = true;
      for (const frame of frames.slice(0, MAX_FRAMES)) {
        if (frame === this.page.mainFrame() || frame.isDetached()) continue;
        // Public SDK refuses parent-session frames. Their IDs are already in the root target tree.
        // OOPIF sessions are registered only on genuine successful original acquisition.
        try {
          const session = await this.own(() => this.acquire(frame));
          this.sessions.add(session);
          this.originalFrameSlots.set(session, frames.indexOf(frame));
          this.guard(end);
          await this.register(session, end);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('part of the parent frame'))
            throw error;
        }
      }
    }
    this.dirty = false;
    const observedRevision = this.revision;
    const observations: SuppliedSemanticObservation[] = [],
      next = new Map<string, BoundNode>();
    let limited = this.frameLimited;
    for (const frameId of this.unsupported.values())
      observations.push({
        nodeRef: id(),
        frameId,
        frameNavigationGeneration: 0,
        parentRef: null,
        role: 'frame',
        name: '',
        sensitivity: 'ordinary',
        editKind: 'none',
        states: {},
        candidateActions: [],
      });
    const focusedCandidates: string[] = [];
    const objectGroup = 'dork-semantic-nodes-' + id();
    const groupSessions = new Set<CDPSession>();
    this.nodeGroups.set(objectGroup, groupSessions);
    for (const frame of this.frames.values()) {
      this.guard(end);
      const root = await this.own(() => axRoot(this.receiver(frame.session), frame.nativeId));
      this.guard(end);
      const stack: {
        node: AXNode;
        parent: string | null;
        depth: number;
        secret: boolean;
      }[] = [{ node: root, parent: null, depth: 0, secret: false }];
      const seen = new Set<string>();
      while (stack.length) {
        if (observations.length >= MAX_NODES) {
          limited = true;
          break;
        }
        const { node, parent, depth, secret } = stack.pop()!;
        if ((node.childIds?.length ?? 0) > MAX_NODES) {
          limited = true;
          break;
        }
        if (depth > MAX_DEPTH) {
          limited = true;
          continue;
        }
        if (seen.has(node.nodeId)) throw new SemanticRefusal('SEMANTIC_AX_CYCLE');
        seen.add(node.nodeId);
        let retainedParent = parent,
          secure = secret;
        if (!node.ignored && node.backendDOMNodeId) {
          groupSessions.add(frame.session);
          const resolved = await this.own(() =>
            this.receiver(frame.session).send('DOM.resolveNode', {
              backendNodeId: node.backendDOMNodeId,
              executionContextId: frame.contextId,
              objectGroup,
            })
          );
          this.guard(end);
          const object = resolved.object.objectId;
          if (!object) throw new SemanticRefusal('SEMANTIC_DOM');
          const inspection = await this.own(() =>
            this.receiver(frame.session).send('Runtime.callFunctionOn', {
              objectId: object,
              functionDeclaration: INSPECT,
              arguments: [{ objectId: frame.document }],
              returnByValue: true,
            })
          );
          this.guard(end);
          if (inspection.exceptionDetails) throw new SemanticRefusal('SEMANTIC_DOM');
          const native = inspected.parse(inspection.result.value);
          if (!native.connected) throw new SemanticRefusal('SEMANTIC_REPLACED');
          secure ||= native.kind === 'secret';
          const key = frame.frameId + ':' + node.nodeId,
            previous = this.nodes.get(key);
          let ref = id();
          if (previous && previous.frame === frame) {
            const same = await this.own(() =>
              this.receiver(frame.session).send('Runtime.callFunctionOn', {
                objectId: object,
                functionDeclaration: 'function(previous){return this===previous;}',
                arguments: [{ objectId: previous.object }],
                returnByValue: true,
              })
            );
            this.guard(end);
            if (same.result.value === true) ref = previous.ref;
          }
          const sensitivity = secure
            ? 'secret'
            : native.kind === 'file'
              ? 'file'
              : native.kind === 'unknownSensitive'
                ? 'unknownSensitive'
                : 'ordinary';
          const observation: SuppliedSemanticObservation = {
            nodeRef: ref,
            frameId: frame.frameId,
            frameNavigationGeneration: frame.generation,
            parentRef: retainedParent,
            role: role(node.role?.value),
            name: sensitivity === 'ordinary' ? String(node.name?.value ?? '') : '',
            sensitivity,
            editKind:
              native.kind === 'plainText' && !native.oversized
                ? 'plainText'
                : native.kind === 'none'
                  ? 'none'
                  : 'unsupported',
            states: { disabled: native.disabled, readonly: native.readonly },
            candidateActions:
              frame.session === this.originalRootSession ||
              this.originalFrameSlots.has(frame.session)
                ? ['focus', 'activate', 'toggle', 'insertText', 'replaceText', 'writeSecret', 'key']
                : [],
            ...(sensitivity === 'ordinary' && typeof node.description?.value === 'string'
              ? { description: node.description.value }
              : {}),
            ...(native.value === undefined ? {} : { value: native.value }),
          };
          // Sanitizer exposes only supported native roles and edit kinds; private fresh grants authorize every effect.
          if (
            native.focused &&
            node.properties?.some(
              (property) => property.name === 'focused' && property.value.value === true
            )
          )
            focusedCandidates.push(ref);
          observations.push(observation);
          next.set(key, {
            object,
            frame,
            backend: node.backendDOMNodeId,
            ref,
            fingerprint: '',
            observation,
            parentId: node.parentId,
            childIds: [...(node.childIds ?? [])],
            axId: node.nodeId,
          });
          retainedParent = ref;
        }
        if (!secure && node.childIds?.length) {
          const children = await this.own(() =>
            this.receiver(frame.session).send('Accessibility.getChildAXNodes', {
              id: node.nodeId,
              frameId: frame.nativeId,
            })
          );
          this.guard(end);
          if (children.nodes.length > MAX_NODES) {
            limited = true;
            break;
          }
          for (let index = children.nodes.length - 1; index >= 0; index--)
            stack.push({
              node: children.nodes[index]!,
              parent: retainedParent,
              depth: depth + 1,
              secret: secure,
            });
        }
      }
    }
    // The canonical sanitizer redacts before generating the fingerprint; never hash raw secure AX fields.
    if (this.dirty || this.revision !== observedRevision)
      throw new SemanticUnstable('SEMANTIC_UNSTABLE');
    const leaseId = id(),
      time = performance.now();
    for (const [key, lease] of this.leases) if (time >= lease.end) this.leases.delete(key);
    const leaseTime = performance.now();
    for (const [id, lease] of this.leases) if (leaseTime >= lease.end) this.leases.delete(id);
    if (issueLease && this.leases.size >= 8) throw new SemanticRefusal('SEMANTIC_LEASE_CAPACITY');
    let projected = projectSuppliedSemanticForest({
      identity: {
        ...identity,
        treeId: this.treeId,
        treeRevision: this.revision,
        semanticLeaseId: leaseId,
      },
      capturedAt: new Date().toISOString(),
      expiresInMs: Math.max(1, Math.min(2000, Math.floor(end - time + 1000))),
      focusRevision: this.revision,
      focusedRef: focusedCandidates.length === 1 ? focusedCandidates[0]! : null,
      observations,
    });
    const fingerprint = JSON.stringify([...projected.fingerprints]);
    if (fingerprint !== this.fingerprint) {
      this.revision++;
      this.leases.clear();
      this.fingerprint = fingerprint;
      projected = projectSuppliedSemanticForest({
        identity: {
          ...identity,
          treeId: this.treeId,
          treeRevision: this.revision,
          semanticLeaseId: leaseId,
        },
        capturedAt: new Date().toISOString(),
        expiresInMs: 2000,
        focusRevision: this.revision,
        focusedRef: focusedCandidates.length === 1 ? focusedCandidates[0]! : null,
        observations,
      });
    }
    for (const entry of next.values()) {
      const material = projected.fingerprints.get(entry.ref);
      const node = projected.snapshot.nodes.find((node) => node.nodeRef === entry.ref);
      if (!material || !node) continue;
      entry.fingerprint = JSON.stringify(material);
      entry.observation = {
        nodeRef: entry.ref,
        frameId: entry.frame.frameId,
        frameNavigationGeneration: entry.frame.generation,
        parentRef: node.parentRef,
        role: node.role,
        name: node.name,
        sensitivity: entry.observation.sensitivity,
        editKind:
          node.editKind === 'plainText'
            ? 'plainText'
            : node.editKind === 'none'
              ? 'none'
              : 'unsupported',
        states: { ...node.states },
        candidateActions: [],
      };
    }
    this.nodes = next;
    this.guard(end);
    const retainedKeys = new Set(this.frames.keys());
    for (const key of this.frameHistory.keys())
      if (!retainedKeys.has(key)) this.frameHistory.delete(key);
    let snapshot = projected.snapshot;
    if (focusedCandidates.length !== 1)
      snapshot = SemanticSnapshotV1Schema.parse({
        ...snapshot,
        focusState: 'unmapped',
      });
    if (this.unsupported.size && !limited)
      snapshot = SemanticSnapshotV1Schema.parse({
        ...snapshot,
        completeness: 'truncated',
        reason: 'unsupportedFrame',
        nodes: snapshot.nodes.map((node) => ({ ...node, actions: [] })),
      });
    if (limited)
      snapshot = SemanticSnapshotV1Schema.parse({
        ...snapshot,
        completeness: 'truncated',
        reason: 'limit',
        nodes: snapshot.nodes.map((node) => ({ ...node, actions: [] })),
      });
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 262144)
      throw new SemanticRefusal('SEMANTIC_OUTPUT_LIMIT');
    if (issueLease) {
      const scopeTime = performance.now();
      for (const [scope, end] of this.observedScopes)
        if (scopeTime >= end) this.observedScopes.delete(scope);
      const scope = JSON.stringify([actor, grant]);
      if (!this.observedScopes.has(scope) && this.observedScopes.size >= 8)
        throw new SemanticRefusal('SEMANTIC_SCOPE_CAPACITY');
      this.observedScopes.set(scope, scopeTime + 300000);
    }
    if (issueLease)
      this.leases.set(leaseId, {
        readonly: snapshot.completeness !== 'complete',
        identity: SemanticIdentityV1Schema.parse({
          ...identity,
          treeId: this.treeId,
          treeRevision: this.revision,
          semanticLeaseId: leaseId,
        }),
        actor,
        grant,
        end: performance.now() + Math.min(snapshot.expiresInMs, 2000),
        revision: this.revision,
        refs: new Set([...next.values()].map((node) => node.ref)),
        snapshot: SemanticSnapshotV1Schema.parse(snapshot),
      });
    for (const [group, targets] of this.nodeGroups)
      if (group.startsWith('dork-semantic-nodes-') && group !== objectGroup) {
        const results = await Promise.allSettled(
          [...targets].map((session) =>
            this.own(() =>
              this.receiver(session).send('Runtime.releaseObjectGroup', {
                objectGroup: group,
              })
            )
          )
        );
        for (const result of results)
          if (result.status === 'rejected') {
            this.fail(result.reason);
            throw result.reason;
          }
        this.nodeGroups.delete(group);
      }
    this.guard(end);
    return snapshot;
  }
  private fingerprint = '';
  private admittedIdentity = '';
  /** Revalidate the exact retained DOM object and sanitized fingerprint; no backend-id fallback. */
  resolve(leaseId: string, nodeRef: string, actor: string, grant: string): Promise<boolean> {
    if (this.closed || this.pending || this.resolving) return Promise.resolve(false);
    let accept!: (value: boolean) => void, reject!: (reason: unknown) => void;
    const original = new Promise<boolean>((a, b) => {
      accept = a;
      reject = b;
    });
    this.resolving = original;
    void original.catch(() => {});
    void Promise.resolve()
      .then(() => this.resolveOriginal(leaseId, nodeRef, actor, grant))
      .then(accept, (reason) => {
        if (reason instanceof SemanticRefusal) {
          accept(false);
          return;
        }
        this.fail(reason);
        this.closed = true;
        this.leases.clear();
        reject(reason);
      });
    void original.then(
      () => {
        if (this.resolving === original) this.resolving = undefined;
      },
      () => {
        if (this.resolving === original) this.resolving = undefined;
      }
    );
    return original;
  }
  /** A fresh private target result from the exact retained lease, never a caller native selector. */
  async target(leaseId: string, nodeRef: string, actor: string, grant: string) {
    const originalLease = this.leases.get(leaseId);
    if (!originalLease || !(await this.resolve(leaseId, nodeRef, actor, grant))) return null;
    const node = [...this.nodes.values()].find((entry) => entry.ref === nodeRef);
    const check = () => {
      if (
        this.closed ||
        this.dirty ||
        this.leases.get(leaseId) !== originalLease ||
        originalLease.actor !== actor ||
        originalLease.grant !== grant ||
        performance.now() >= originalLease.end ||
        !node ||
        node.frame.dirty ||
        node.frame.replaced
      )
        throw new SemanticRefusal('SEMANTIC_TARGET_REFUSED');
    };
    check();
    if (
      !node ||
      (node.frame.session !== this.originalRootSession &&
        !this.originalFrameSlots.has(node.frame.session))
    )
      return null;
    const port = this.receiver(node.frame.session);
    const document = await this.own(() =>
      port.send('DOM.describeNode', { objectId: node.frame.document })
    );
    check();
    const native = await this.own(() =>
      port.send('Runtime.callFunctionOn', {
        objectId: node.object,
        functionDeclaration: INSPECT,
        arguments: [{ objectId: node.frame.document }],
        returnByValue: true,
      })
    );
    check();
    if (native.exceptionDetails) return null;
    const observed = inspected.parse(native.result.value);
    if (!observed.connected || !['none', 'plainText', 'secret'].includes(observed.kind))
      return null;
    const metadata = await this.own(() => port.send('Target.getTargetInfo'));
    check();
    const frameSlot = this.originalFrameSlots.get(node.frame.session);
    if (metadata.targetInfo.type !== (frameSlot === undefined ? 'page' : 'iframe')) return null;
    return NativeSemanticTargetSchema.parse({
      identity: originalLease.identity,
      nodeRef,
      frameId: node.frame.frameId,
      frameNavigationGeneration: node.frame.generation,
      nativeFrameId: node.frame.nativeId,
      nativeTargetId: metadata.targetInfo.targetId,
      ...(frameSlot === undefined ? {} : { nativeFrameSlot: frameSlot }),
      backendNodeId: node.backend,
      documentBackendNodeId: document.node.backendNodeId,
      role: node.observation.role,
      name: node.observation.sensitivity === 'ordinary' ? node.observation.name : '',
      kind: observed.kind,
      disabled: observed.disabled,
      readonly: observed.readonly,
      focused: observed.focused,
      focusRevision: this.revision,
    });
  }
  /** Reserve one exact native field before arming its original isolated-world observer. */
  beginEdit(requestId: string, leaseId: string, nodeRef: string, actor: string, grant: string) {
    return this.own(async () => {
      if (this.closed || this.editing) throw new SemanticRefusal('SEMANTIC_EDIT_BUSY');
      const target = await this.target(leaseId, nodeRef, actor, grant);
      const lease = this.leases.get(leaseId),
        node = [...this.nodes.values()].find((entry) => entry.ref === nodeRef);
      if (
        this.closed ||
        this.editing ||
        !target ||
        !lease ||
        !node ||
        !target.focused ||
        !['plainText', 'secret'].includes(target.kind) ||
        target.disabled ||
        target.readonly ||
        !node.frame.observer
      )
        throw new SemanticRefusal('SEMANTIC_EDIT_REFUSED');
      const edit = {
        requestId,
        actor,
        grant,
        node,
        identity: lease.identity,
        snapshot: lease.snapshot,
        observer: node.frame.observer,
        unexpected: false,
        phase: 'idle' as 'idle' | 'input' | 'selection',
      };
      this.editing = edit;
      try {
        const result = await this.own(() =>
          this.receiver(node.frame.session).send('Runtime.callFunctionOn', {
            objectId: edit.observer,
            functionDeclaration: 'function(node){return this.arm(node)}',
            arguments: [{ objectId: node.object }],
            returnByValue: true,
          })
        );
        if (
          this.closed ||
          this.editing !== edit ||
          result.exceptionDetails ||
          result.result.value !== true
        )
          throw new SemanticRefusal('SEMANTIC_EDIT_REFUSED');
        return target;
      } catch (value) {
        edit.unexpected = true;
        throw value;
      }
    });
  }
  /** Original step admission brackets only actual owned input, never a caller event/timing claim. */
  editPhase(
    requestId: string,
    actor: string,
    grant: string,
    phase: 'idle' | 'input' | 'selection'
  ) {
    return this.own(async () => {
      const edit = this.editing;
      if (
        this.closed ||
        !edit ||
        edit.requestId !== requestId ||
        edit.actor !== actor ||
        edit.grant !== grant ||
        edit.unexpected
      )
        throw new SemanticRefusal('SEMANTIC_EDIT_REFUSED');
      edit.phase = phase;
      const result = await this.own(() =>
        this.receiver(edit.node.frame.session).send('Runtime.callFunctionOn', {
          objectId: edit.observer,
          functionDeclaration: 'function(value){return this.step(value)}',
          arguments: [{ value: phase }],
          returnByValue: true,
        })
      );
      if (
        this.closed ||
        this.editing !== edit ||
        result.exceptionDetails ||
        result.result.value !== true
      )
        throw new SemanticRefusal('SEMANTIC_EDIT_REFUSED');
    });
  }
  /** A continuation exists only after original trusted field events and whole fresh forest validation. */
  finishEdit(requestId: string, actor: string, grant: string) {
    return this.own(async () => {
      const edit = this.editing;
      if (
        this.closed ||
        !edit ||
        edit.requestId !== requestId ||
        edit.actor !== actor ||
        edit.grant !== grant
      )
        throw new SemanticRefusal('SEMANTIC_EDIT_REFUSED');
      try {
        const observed = await this.own(() =>
          this.receiver(edit.node.frame.session).send('Runtime.callFunctionOn', {
            objectId: edit.observer,
            functionDeclaration: 'function(){return this.finish()}',
            returnByValue: true,
          })
        );
        if (this.closed || this.editing !== edit || observed.exceptionDetails)
          throw new SemanticRefusal('SEMANTIC_EDIT_REFUSED');
        const flags = z
          .object({
            inputs: z.number().int().min(0).max(16),
            selections: z.number().int().min(0).max(32),
            unexpected: z.boolean(),
          })
          .strict()
          .parse(observed.result.value);
        edit.phase = 'idle';
        const { semanticLeaseId: _lease, ...admission } = edit.identity;
        const snapshot = await this.run(admission, actor, grant, true);
        if (this.closed || this.editing !== edit)
          throw new SemanticRefusal('SEMANTIC_EDIT_REFUSED');
        const sameForest = (value: SemanticSnapshotV1) =>
          JSON.stringify({
            rootRefs: value.rootRefs,
            nodes: value.nodes.map((entry) =>
              entry.nodeRef === edit.node.ref ? { ...entry, value: undefined } : entry
            ),
          });
        const identityKeys = [
          'browserId',
          'browserGeneration',
          'tabId',
          'navigationGeneration',
          'viewportVersion',
          'epoch',
          'inputGeneration',
          'grantRevision',
          'treeId',
        ] as const;
        const stable =
          identityKeys.every((key) => snapshot[key] === edit.identity[key]) &&
          snapshot.completeness === 'complete' &&
          snapshot.focusedRef === edit.node.ref &&
          snapshot.focusState === 'node' &&
          edit.snapshot.focusedRef === edit.node.ref &&
          snapshot.treeRevision > edit.identity.treeRevision &&
          sameForest(snapshot) === sameForest(edit.snapshot);
        const target = stable
          ? await this.target(snapshot.semanticLeaseId, edit.node.ref, actor, grant)
          : null;
        const correlated =
          !this.closed &&
          this.editing === edit &&
          !edit.unexpected &&
          !flags.unexpected &&
          flags.inputs === 1 &&
          !!target &&
          target.backendNodeId === edit.node.backend &&
          target.frameId === edit.node.frame.frameId &&
          target.frameNavigationGeneration === edit.node.frame.generation;
        return Object.freeze({
          snapshot,
          target: correlated ? target : null,
          correlated,
        });
      } finally {
        if (this.editing === edit) this.editing = undefined;
      }
    });
  }
  /** Serialized original observer state; sampling it never issues or revives a lease. */
  changes(actor: string, grant: string) {
    if (performance.now() >= (this.observedScopes.get(JSON.stringify([actor, grant])) ?? 0))
      throw new SemanticRefusal('SEMANTIC_SCOPE_REFUSED');
    if (this.closed || this.first)
      throw this.first ? this.first.reason : new SemanticRefusal('SEMANTIC_UNAVAILABLE');
    return NativeSemanticChangesSchema.parse({
      revision: this.revision,
      dirty: this.dirty,
    });
  }
  private async resolveOriginal(
    leaseId: string,
    nodeRef: string,
    actor: string,
    grant: string
  ): Promise<boolean> {
    const lease = this.leases.get(leaseId),
      node = [...this.nodes.values()].find((value) => value.ref === nodeRef);
    if (
      this.closed ||
      this.dirty ||
      !lease ||
      lease.readonly ||
      !node ||
      !lease.refs.has(nodeRef) ||
      lease.actor !== actor ||
      lease.grant !== grant ||
      performance.now() >= lease.end ||
      lease.revision !== this.revision
    )
      return false;
    const result = await this.own(() =>
      this.receiver(node.frame.session).send('Runtime.callFunctionOn', {
        objectId: node.object,
        functionDeclaration: INSPECT,
        arguments: [{ objectId: node.frame.document }],
        returnByValue: true,
      })
    );
    if (result.exceptionDetails) return false;
    const native = inspected.parse(result.result.value);
    if (!native.connected) return false;
    if (
      this.closed ||
      this.dirty ||
      this.leases.get(leaseId) !== lease ||
      performance.now() >= lease.end
    )
      return false;
    const current = await this.own(() =>
      this.receiver(node.frame.session).send('Accessibility.getPartialAXTree', {
        objectId: node.object,
        fetchRelatives: false,
      })
    );
    if (current.nodes.length !== 1 || (current.nodes[0]?.childIds?.length ?? 0) > MAX_NODES)
      return false;
    const ax = current.nodes[0]!;
    if (
      ax.backendDOMNodeId !== node.backend ||
      ax.parentId !== node.parentId ||
      JSON.stringify(ax.childIds ?? []) !== JSON.stringify(node.childIds)
    )
      return false;
    const sensitivity = node.observation.sensitivity;
    if (
      (sensitivity === 'secret' && native.kind !== 'secret') ||
      (sensitivity === 'ordinary' && ['secret', 'file', 'unknownSensitive'].includes(native.kind))
    )
      return false;
    const observed: SuppliedSemanticObservation = {
      ...node.observation,
      parentRef: null,
      role: role(ax.role?.value),
      name: sensitivity === 'ordinary' ? String(ax.name?.value ?? '') : '',
      states: { disabled: native.disabled, readonly: native.readonly },
      editKind:
        native.kind === 'plainText' && !native.oversized
          ? 'plainText'
          : native.kind === 'none'
            ? 'none'
            : 'unsupported',
    };
    const projection = projectSuppliedSemanticForest({
      identity: lease.identity,
      capturedAt: new Date().toISOString(),
      expiresInMs: 1,
      focusRevision: this.revision,
      focusedRef: native.focused ? nodeRef : null,
      observations: [observed],
    });
    const fresh = projection.fingerprints.get(nodeRef),
      retained = JSON.parse(node.fingerprint);
    if (
      !fresh ||
      fresh.role !== retained.role ||
      fresh.name !== retained.name ||
      JSON.stringify(fresh.states) !== JSON.stringify(retained.states) ||
      fresh.editKind !== retained.editKind
    )
      return false;
    const { semanticLeaseId: _lease, ...admission } = lease.identity;
    await this.run(admission, actor, grant, false);
    const time = performance.now();
    return !this.closed && !this.dirty && this.leases.get(leaseId) === lease && time < lease.end;
  }

  private async releaseFrames(): Promise<void> {
    this.frameHistory.clear();
    for (const [key, frame] of this.frames)
      this.frameHistory.set(key, {
        frameId: frame.frameId,
        generation: frame.generation,
      });
    const results = await Promise.allSettled(
      [...this.frames.values()].map(async (frame) => {
        try {
          frame.off();
        } catch (reason) {
          this.fail(reason);
        }
      })
    );
    const observers = await Promise.allSettled(
      [...this.frames.values()].map(async (frame) => {
        if (frame.observer)
          await this.own(() =>
            this.receiver(frame.session).send('Runtime.callFunctionOn', {
              objectId: frame.observer,
              functionDeclaration: 'function(){this.close();}',
              returnByValue: true,
            })
          );
      })
    );
    const disable = await Promise.allSettled(
      [...this.sessions].flatMap((session) => [
        this.own(() => this.receiver(session).send('Accessibility.disable')),
        this.own(() => this.receiver(session).send('DOM.disable')),
      ])
    );
    const groups = await Promise.allSettled(
      [...this.nodeGroups].flatMap(([objectGroup, targets]) =>
        [...targets].map((session) =>
          this.own(() =>
            this.receiver(session).send('Runtime.releaseObjectGroup', {
              objectGroup,
            })
          )
        )
      )
    );
    this.nodeGroups.clear();
    const detach = await Promise.allSettled(
      [...this.sessions].map((session) => this.own(() => this.receiver(session).detach()))
    );
    this.frames.clear();
    this.unsupported.clear();
    this.frameLimited = false;
    this.sessions.clear();
    this.originalRootSession = undefined;
    this.originalFrameSlots.clear();
    this.frameEvents.clear();
    this.ports.clear();
    this.nodes.clear();
    this.leases.clear();
    if (this.first) throw this.first.reason;
    for (const result of [...results, ...observers, ...disable, ...groups, ...detach])
      if (result.status === 'rejected') {
        this.fail(result.reason);
        throw result.reason;
      }
  }
  /** Fence admission immediately, join originals and release every captured target session independently. */
  close(): Promise<void> {
    this.closed = true;
    this.leases.clear();
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      try {
        this.removePageListeners();
      } catch (reason) {
        this.fail(reason);
      }
      await Promise.allSettled([this.pending, this.resolving, ...this.originals]);
      try {
        await this.releaseFrames();
      } catch (reason) {
        this.fail(reason);
      }
      if (this.first) throw this.first.reason;
    });
    return this.closing;
  }
}
