/** Literal JSON-pointer patches over private channel state, never editable document content. */
import {
  CanvasChannelStateSchema,
  CanvasChannelStateOperationSchema,
  type CanvasChannelJsonValue,
  type CanvasChannelPatchStateRequest,
} from '@dorkos/shared/canvas-channel-schemas';

type JsonObject = Record<string, CanvasChannelJsonValue>;
function indexOf(segment: string, length: number, append: boolean): number {
  if (append && segment === '-') return length;
  if (!/^(0|[1-9][0-9]*)$/u.test(segment)) throw new Error('INVALID_STATE_POINTER');
  const index = Number(segment);
  if (!Number.isSafeInteger(index) || index >= length) throw new Error('INVALID_STATE_POINTER');
  return index;
}
function container(value: CanvasChannelJsonValue): JsonObject | CanvasChannelJsonValue[] {
  if (value === null || typeof value !== 'object') throw new Error('INVALID_STATE_POINTER');
  return value;
}
/** Apply validated operations to a detached state object and enforce the exact final state bound. */
export function patchDocState(
  state: JsonObject,
  operations: CanvasChannelPatchStateRequest['operations']
): JsonObject {
  let next = structuredClone(state);
  for (const raw of operations) {
    const operation = CanvasChannelStateOperationSchema.parse(raw);
    if (operation.path === '') {
      if (operation.op === 'remove') throw new Error('INVALID_STATE_POINTER');
      next = CanvasChannelStateSchema.parse(structuredClone(operation.value));
      continue;
    }
    const segments = operation.path
      .slice(1)
      .split('/')
      .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    let parent: JsonObject | CanvasChannelJsonValue[] = next;
    for (const segment of segments.slice(0, -1)) {
      const key = Array.isArray(parent) ? indexOf(segment, parent.length, false) : segment;
      if (!Object.hasOwn(parent, key)) throw new Error('INVALID_STATE_POINTER');
      parent = container((parent as JsonObject)[key]!);
    }
    const segment = segments.at(-1)!;
    if (Array.isArray(parent)) {
      const index = indexOf(segment, parent.length, operation.op === 'set');
      if (operation.op === 'remove') parent.splice(index, 1);
      else parent[index] = structuredClone(operation.value);
    } else if (operation.op === 'remove') {
      if (!Object.hasOwn(parent, segment)) throw new Error('INVALID_STATE_POINTER');
      delete parent[segment];
    } else parent[segment] = structuredClone(operation.value);
  }
  return CanvasChannelStateSchema.parse(next);
}
