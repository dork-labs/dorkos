/**
 * Private bounded supplied-observation projection, not AX acquisition.
 * The caller must own already-bounded plain data and native sensitivity classification.
 * Output remains untrusted page content and establishes no reference/lease authority.
 */
import {
  SemanticIdentityV1Schema,
  SemanticSnapshotV1Schema,
  SemanticNodeV1Schema,
  SemanticRoleV1Schema,
  type SemanticIdentityV1,
  type SemanticNodeV1,
  type SemanticSnapshotV1,
} from './browser-semantic-schemas.js';
import { browserUtf8Bytes } from './browser-schema-json.js';

/** Supplied classification is an upstream precondition, never host verification. */
export interface SuppliedSemanticObservation {
  nodeRef: string;
  frameId: string;
  frameNavigationGeneration: number;
  parentRef: string | null;
  role: string;
  name: string;
  description?: string;
  text?: string;
  value?: string;
  sensitivity: 'ordinary' | 'secret' | 'file' | 'unknownSensitive';
  editKind: 'none' | 'plainText' | 'unsupported';
  states: SemanticNodeV1['states'];
  candidateActions: SemanticNodeV1['actions'];
}
/** Structural fixture/caller fields do not issue a genuine snapshot or actor lease. */
export interface SuppliedSemanticForest {
  identity: SemanticIdentityV1;
  capturedAt: string;
  expiresInMs: number;
  focusRevision: number;
  focusedRef: string | null;
  observations: readonly SuppliedSemanticObservation[];
}
/** Projection material is sanitized before fingerprint construction; no field value is included. */
export interface SemanticFingerprintMaterial {
  role: SemanticNodeV1['role'];
  name: string;
  states: SemanticNodeV1['states'];
  editKind: SemanticNodeV1['editKind'];
  parentRef: string | null;
  childRefs: string[];
}
/** Untrusted projected content and sanitized private fingerprint inputs. */
export interface SuppliedSemanticProjection {
  snapshot: SemanticSnapshotV1;
  fingerprints: ReadonlyMap<string, SemanticFingerprintMaterial>;
}

const MAX_BYTES = 256 * 1024;
const MAX_NODES = 2000;
const MAX_DEPTH = 32;
const MAX_FRAMES = 32;
const roles = new Set<string>(SemanticRoleV1Schema.options);
const actionKinds = new Set([
  'focus',
  'activate',
  'toggle',
  'insertText',
  'replaceText',
  'writeSecret',
  'key',
]);
const stateKeys = new Set([
  'disabled',
  'readonly',
  'required',
  'checked',
  'expanded',
  'selected',
  'pressed',
  'invalid',
  'level',
  'focused',
]);

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 32) return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))
      return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function plainText(value: string): string {
  let result = '';
  for (const char of value.replace(/\r\n?/gu, '\n')) {
    const code = char.codePointAt(0)!;
    if (
      (code >= 0xd800 && code <= 0xdfff) ||
      code < 9 ||
      (code > 10 && code < 32) ||
      (code >= 127 && code <= 159) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      continue;
    result += char;
  }
  return result;
}
function boundedText(value: string, limit: number): { text: string; truncated: boolean } {
  const safe = plainText(value);
  let bytes = 0;
  let text = '';
  for (const char of safe) {
    const next = browserUtf8Bytes(char);
    if (bytes + next > limit) return { text, truncated: true };
    bytes += next;
    text += char;
  }
  return { text, truncated: false };
}
function states(value: unknown): SemanticNodeV1['states'] | null {
  const fields = plainRecord(value);
  if (!fields) return null;
  for (const [key, item] of Object.entries(fields)) {
    if (!stateKeys.has(key)) return null;
    if (key === 'level') {
      if (!Number.isSafeInteger(item) || (item as number) < 0) return null;
    } else if (key === 'checked' || key === 'pressed') {
      if (typeof item !== 'boolean' && item !== 'mixed') return null;
    } else if (typeof item !== 'boolean') return null;
  }
  return { ...fields } as SemanticNodeV1['states'];
}
function observation(value: unknown): SuppliedSemanticObservation | null {
  const item = plainRecord(value);
  if (
    !item ||
    typeof item.nodeRef !== 'string' ||
    typeof item.frameId !== 'string' ||
    !Number.isSafeInteger(item.frameNavigationGeneration) ||
    (item.frameNavigationGeneration as number) < 0 ||
    (item.parentRef !== null && typeof item.parentRef !== 'string') ||
    typeof item.role !== 'string' ||
    typeof item.name !== 'string' ||
    !['ordinary', 'secret', 'file', 'unknownSensitive'].includes(item.sensitivity as string) ||
    !['none', 'plainText', 'unsupported'].includes(item.editKind as string)
  )
    return null;
  for (const key of ['description', 'text', 'value'])
    if (item[key] !== undefined && typeof item[key] !== 'string') return null;
  if (
    !Array.isArray(item.candidateActions) ||
    item.candidateActions.length > 7 ||
    Object.getPrototypeOf(item.candidateActions) !== Array.prototype
  )
    return null;
  const actions: SemanticNodeV1['actions'] = [];
  for (let index = 0; index < item.candidateActions.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(item.candidateActions, String(index));
    if (
      !descriptor ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string' ||
      !actionKinds.has(descriptor.value)
    )
      return null;
    if (!actions.includes(descriptor.value as SemanticNodeV1['actions'][number]))
      actions.push(descriptor.value as SemanticNodeV1['actions'][number]);
  }
  const safeStates = states(item.states);
  if (!safeStates) return null;
  const ordinary = item.sensitivity === 'ordinary';
  return {
    nodeRef: item.nodeRef,
    frameId: item.frameId,
    frameNavigationGeneration: item.frameNavigationGeneration as number,
    parentRef: item.parentRef as string | null,
    role: item.role,
    name: ordinary
      ? item.name
      : item.sensitivity === 'secret'
        ? 'Password field'
        : 'Sensitive field',
    // Secure observations are redacted before insertion into retained graph maps.
    ...(ordinary && typeof item.description === 'string' ? { description: item.description } : {}),
    ...(ordinary && typeof item.text === 'string' ? { text: item.text } : {}),
    ...(ordinary && typeof item.value === 'string' ? { value: item.value } : {}),
    sensitivity: item.sensitivity as SuppliedSemanticObservation['sensitivity'],
    editKind: item.editKind as SuppliedSemanticObservation['editKind'],
    states: safeStates,
    candidateActions: actions,
  };
}
function project(item: SuppliedSemanticObservation): SemanticNodeV1 {
  const secure = item.sensitivity !== 'ordinary';
  const name = boundedText(
    secure ? (item.sensitivity === 'secret' ? 'Password field' : 'Sensitive field') : item.name,
    512
  );
  const text = !secure && item.text !== undefined ? boundedText(item.text, 2048) : undefined;
  const value =
    !secure && item.editKind === 'plainText' && item.value !== undefined
      ? boundedText(item.value, 2048)
      : undefined;
  // Markup-bearing descriptions are not copied into the projection.
  const description =
    !secure && item.description !== undefined && !/<[^>]*>/u.test(item.description)
      ? boundedText(item.description, 1024)
      : undefined;
  const truncated =
    name.truncated || !!text?.truncated || !!value?.truncated || !!description?.truncated;
  const role = roles.has(item.role) ? (item.role as SemanticNodeV1['role']) : 'unknown';
  const editKind =
    item.sensitivity === 'secret' ? 'secret' : secure || truncated ? 'unsupported' : item.editKind;
  const editable = !truncated && !item.states.disabled && !item.states.readonly;
  const actions = item.candidateActions.filter((kind) => {
    if (role === 'unknown') return false;
    if (secure)
      return item.sensitivity === 'secret' && editable && ['focus', 'writeSecret'].includes(kind);
    if (kind === 'writeSecret') return false;
    if (['insertText', 'replaceText'].includes(kind)) return editKind === 'plainText' && editable;
    if (kind === 'key' && editKind !== 'none') return editKind === 'plainText' && editable;
    if (kind === 'activate') return ['button', 'link'].includes(role) && editable;
    if (kind === 'toggle') return ['checkbox', 'radio', 'switch'].includes(role) && editable;
    return !truncated;
  });
  return {
    nodeRef: item.nodeRef,
    frameId: item.frameId,
    frameNavigationGeneration: item.frameNavigationGeneration,
    parentRef: item.parentRef,
    childRefs: [],
    role,
    name: name.text,
    states: { ...item.states },
    editKind,
    actions,
    redacted: secure,
    truncated,
    ...(description ? { description: description.text } : {}),
    ...(text ? { text: text.text } : {}),
    ...(value && !value.truncated && editKind === 'plainText' ? { value: value.text } : {}),
  };
}

/**
 * Consume one supplied plain batch. This cannot bound upstream materialization or verify native facts.
 * Structural identities pass through only after schema checking; they remain non-authoritative.
 */
export function projectSuppliedSemanticForest(
  input: SuppliedSemanticForest
): SuppliedSemanticProjection {
  const identity = SemanticIdentityV1Schema.parse(input.identity);
  const base = {
    ...identity,
    capturedAt: input.capturedAt,
    expiresInMs: input.expiresInMs,
    focusRevision: input.focusRevision,
  };
  const unavailable = (reason: 'unstable' | 'limit'): SuppliedSemanticProjection => ({
    snapshot: SemanticSnapshotV1Schema.parse({
      ...base,
      nodes: [],
      rootRefs: [],
      focusedRef: null,
      focusState: 'none',
      completeness: 'unavailable',
      reason,
    }),
    fingerprints: new Map(),
  });
  // Validate scalar metadata without treating a final schema byte rejection as prefix handling.
  unavailable('unstable');
  if (
    !Array.isArray(input.observations) ||
    Object.getPrototypeOf(input.observations) !== Array.prototype
  )
    return unavailable('unstable');
  // Oversized supplied batches are refused before retaining any per-node state.
  if (input.observations.length > MAX_NODES) return unavailable('limit');
  const all = new Map<string, SuppliedSemanticObservation>();
  const children = new Map<string | null, string[]>();
  for (let index = 0; index < input.observations.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input.observations, String(index));
    const item = descriptor && 'value' in descriptor ? observation(descriptor.value) : null;
    if (!item || all.has(item.nodeRef)) return unavailable('unstable');
    all.set(item.nodeRef, item);
    const group = children.get(item.parentRef) ?? [];
    group.push(item.nodeRef);
    children.set(item.parentRef, group);
  }
  if ([...all.values()].some((item) => item.parentRef !== null && !all.has(item.parentRef)))
    return unavailable('unstable');
  const stack = (children.get(null) ?? [])
    .slice()
    .reverse()
    .map((ref) => ({ ref, depth: 1 }));
  const seen = new Set<string>();
  const frames = new Map<string, number>();
  const nodes: SemanticNodeV1[] = [];
  let limited = false;
  while (stack.length) {
    const entry = stack.pop()!;
    const item = all.get(entry.ref)!;
    if (seen.has(entry.ref)) return unavailable('unstable');
    seen.add(entry.ref);
    if (entry.depth > MAX_DEPTH) {
      limited = true;
      continue;
    }
    if (frames.has(item.frameId) && frames.get(item.frameId) !== item.frameNavigationGeneration)
      return unavailable('unstable');
    if (!frames.has(item.frameId) && frames.size === MAX_FRAMES) {
      limited = true;
      continue;
    }
    frames.set(item.frameId, item.frameNavigationGeneration);
    const projected = SemanticNodeV1Schema.safeParse(project(item));
    if (!projected.success) return unavailable('unstable');
    nodes.push(projected.data);
    for (const ref of (children.get(entry.ref) ?? []).slice().reverse())
      stack.push({ ref, depth: entry.depth + 1 });
  }
  if (!limited && seen.size !== all.size) return unavailable('unstable');
  const retained = new Set(nodes.map((item) => item.nodeRef));
  for (const item of nodes)
    item.childRefs = (children.get(item.nodeRef) ?? []).filter((ref) => retained.has(ref));
  // An omitted ancestor never leaves a floating actionable descendant.
  const roots = nodes.filter((item) => item.parentRef === null).map((item) => item.nodeRef);
  const make = (): SemanticSnapshotV1 => ({
    ...base,
    nodes,
    rootRefs: roots,
    focusedRef: nodes.some((item) => item.nodeRef === input.focusedRef) ? input.focusedRef : null,
    focusState: nodes.some((item) => item.nodeRef === input.focusedRef) ? 'node' : 'none',
    completeness: limited ? 'truncated' : 'complete',
    ...(limited ? { reason: 'limit' } : {}),
  });
  for (const item of nodes) {
    item.states.focused = item.nodeRef === input.focusedRef;
    if (item.truncated) limited = true;
  }
  // Count the entire encoded envelope, including punctuation, escaped strings and identities.
  let encodedBytes = browserUtf8Bytes(JSON.stringify(make()));
  while (encodedBytes > MAX_BYTES && nodes.length) {
    limited = true;
    const removeCount = Math.max(
      1,
      Math.ceil((nodes.length * (encodedBytes - MAX_BYTES)) / encodedBytes)
    );
    const removed = new Set(
      nodes.splice(Math.max(0, nodes.length - removeCount)).map((item) => item.nodeRef)
    );
    for (let index = roots.length - 1; index >= 0; index--)
      if (removed.has(roots[index])) roots.splice(index, 1);
    for (const item of nodes) item.childRefs = item.childRefs.filter((ref) => !removed.has(ref));
    encodedBytes = browserUtf8Bytes(JSON.stringify(make()));
  }
  if (browserUtf8Bytes(JSON.stringify(make())) > MAX_BYTES) return unavailable('limit');
  if (limited) for (const item of nodes) item.actions = [];
  // Graph construction and checked scalar/node fields provide shape; whole-byte enforcement
  // is this leaf's responsibility and remains independently observable in its tests.
  const snapshot = make();
  const fingerprints = new Map<string, SemanticFingerprintMaterial>();
  for (const item of snapshot.nodes)
    fingerprints.set(item.nodeRef, {
      role: item.role,
      name: item.name,
      states: { ...item.states },
      editKind: item.editKind,
      parentRef: item.parentRef,
      childRefs: [...item.childRefs],
    });
  return { snapshot, fingerprints };
}
