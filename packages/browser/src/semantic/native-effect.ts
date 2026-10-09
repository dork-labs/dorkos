import type { CDPSession } from 'playwright-core';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { NativeSemanticTarget } from './native-target.js';

const stateSchema = z
  .object({
    connected: z.boolean(),
    focused: z.boolean(),
    disabled: z.boolean(),
    readonly: z.boolean(),
    kind: z.enum(['none', 'plainText', 'secret', 'unsupported']),
    selectedAll: z.boolean(),
  })
  .strict();
export type NativeSemanticState = z.infer<typeof stateSchema>;
// Fixed isolated-world inspection. Password values, lengths and selection are never accessed.
const INSPECT_TARGET = `function(doc) {
 if(doc!==globalThis.document||this.ownerDocument!==doc||!this.isConnected)return {connected:false,focused:false,disabled:false,readonly:false,kind:'unsupported',selectedAll:false};
 const tag=this.localName;let kind='none';
 if(tag==='input')kind=this.type==='password'?'secret':['text','search','email','tel','url'].includes(this.type)?'plainText':['checkbox','radio','button','submit','reset'].includes(this.type)?'none':'unsupported';
 else if(tag==='textarea')kind='plainText';else if(this.isContentEditable)kind='unsupported';
 let active=doc.activeElement;for(let i=0;i<32&&active?.shadowRoot?.activeElement;i++)active=active.shadowRoot.activeElement;
 const focused=active===this&&doc.hasFocus();let selectedAll=false;
 if(kind==='plainText')selectedAll=this.selectionStart===0&&this.selectionEnd===this.value.length;
 return {connected:true,focused,disabled:this.disabled===true,readonly:this.readOnly===true,kind,selectedAll};
}`;
const mapRole = (value: unknown) => {
  const key = String(value).toLowerCase();
  return key === 'textfield'
    ? 'textbox'
    : ['rootwebarea', 'webarea'].includes(key)
      ? 'document'
      : key;
};

/** Exact retained original input CDP session only. Native IDs were privately resolved from the actor's current lease. */
export async function semanticNativeEffect(
  session: CDPSession,
  target: NativeSemanticTarget,
  guard: () => void,
  focus: boolean
): Promise<NativeSemanticState> {
  const send = session.send.bind(session);
  guard();
  const group = `dork-semantic-action-${randomBytes(12).toString('hex')}`;
  let first: Readonly<{ value: unknown }> | undefined;
  let result: NativeSemanticState | undefined;
  let groupEntered = false;
  const fail = (value: unknown) => {
    first ??= Object.freeze({ value });
  };
  try {
    guard();
    const metadata = await send('Target.getTargetInfo');
    guard();
    if (
      metadata.targetInfo.type !== (target.nativeFrameSlot === undefined ? 'page' : 'iframe') ||
      metadata.targetInfo.targetId !== target.nativeTargetId
    )
      throw new Error('SEMANTIC_TARGET_REFUSED');
    const world = await send('Page.createIsolatedWorld', {
      frameId: target.nativeFrameId,
      worldName: 'dork-semantic-actions',
      grantUniveralAccess: false,
    });
    guard();
    groupEntered = true;
    const doc = await send('DOM.resolveNode', {
      backendNodeId: target.documentBackendNodeId,
      executionContextId: world.executionContextId,
      objectGroup: group,
    });
    guard();
    const node = await send('DOM.resolveNode', {
      backendNodeId: target.backendNodeId,
      executionContextId: world.executionContextId,
      objectGroup: group,
    });
    guard();
    if (!doc.object.objectId || !node.object.objectId) throw new Error('SEMANTIC_TARGET_REFUSED');
    const observe = async () => {
      guard();
      const inspected = await send('Runtime.callFunctionOn', {
        objectId: node.object.objectId,
        functionDeclaration: INSPECT_TARGET,
        arguments: [{ objectId: doc.object.objectId }],
        returnByValue: true,
      });
      guard();
      if (inspected.exceptionDetails) throw new Error('SEMANTIC_TARGET_REFUSED');
      const state = stateSchema.parse(inspected.result.value);
      if (
        !state.connected ||
        state.kind !== target.kind ||
        state.disabled !== target.disabled ||
        state.readonly !== target.readonly
      )
        throw new Error('SEMANTIC_TARGET_REFUSED');
      const ax = await send('Accessibility.getPartialAXTree', {
        objectId: node.object.objectId,
        fetchRelatives: false,
      });
      guard();
      if (
        ax.nodes.length !== 1 ||
        ax.nodes[0]?.backendDOMNodeId !== target.backendNodeId ||
        mapRole(ax.nodes[0]?.role?.value) !== target.role ||
        (target.kind !== 'secret' && String(ax.nodes[0]?.name?.value ?? '') !== target.name)
      )
        throw new Error('SEMANTIC_TARGET_REFUSED');
      return state;
    };
    result = await observe();
    if (focus) {
      if (result.disabled) throw new Error('SEMANTIC_TARGET_REFUSED');
      guard();
      await send('DOM.focus', { backendNodeId: target.backendNodeId });
      guard();
      result = await observe();
      if (!result.focused) throw new Error('SEMANTIC_FOCUS_REFUSED');
    }
  } catch (value) {
    fail(value);
  }
  // Original group release is an independent duty; it remains entered after authority is revoked.
  if (groupEntered)
    try {
      await send('Runtime.releaseObjectGroup', { objectGroup: group });
    } catch (value) {
      fail(value);
    }
  if (first) throw first.value;
  if (!result) throw new Error('SEMANTIC_TARGET_REFUSED');
  return Object.freeze(result);
}
