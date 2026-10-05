import { CanvasChannelPointerSchema } from '@dorkos/shared/canvas-channel-schemas';
import type { WidgetNode } from '@dorkos/shared/ui-widget';

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const DISPLAY_FIELDS: Partial<Record<WidgetNode['type'], readonly string[]>> = {
  text: ['text'],
  stat: ['value'],
  progress: ['value', 'label'],
  table: ['rows'],
  chart: ['data'],
};
const MAX_ROWS = 100;
const MAX_COLUMNS = 50;
const MAX_TEXT = 16_384;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Read own data properties only. Accessors and inherited values are never evaluated. */
function ownValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !('value' in descriptor)) throw new Error('missing');
  return descriptor.value;
}

/** Resolve a literal pointer within a JSON object, with canonical array indices. */
export function readWidgetStatePath(state: unknown, path: string): unknown {
  if (!plainObject(state) || !CanvasChannelPointerSchema.safeParse(path).success)
    throw new Error('path');
  let value: unknown = state;
  if (path === '') return value;
  for (const encoded of path.slice(1).split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (UNSAFE_KEYS.has(key)) throw new Error('path');
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) throw new Error('index');
    } else if (!plainObject(value)) {
      throw new Error('object');
    }
    value = ownValue(value, key);
  }
  return value;
}

function text(value: unknown, maximum = MAX_TEXT): value is string {
  return typeof value === 'string' && value.length <= maximum;
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function cell(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'boolean' || finite(value) || text(value);
}

/** Copy bounded table/chart data after inspecting descriptors, before renderers read it. */
function displayValue(node: WidgetNode, field: string, value: unknown): unknown {
  if (node.type === 'text' && field === 'text' && text(value)) return value;
  if (node.type === 'stat' && field === 'value' && (text(value, 1024) || finite(value)))
    return value;
  if (node.type === 'progress') {
    if (field === 'label' && text(value, 1024)) return value;
    if (field === 'value' && finite(value) && value >= 0 && value <= 100) return value;
  }
  if (!Array.isArray(value) || value.length > MAX_ROWS) throw new Error('type');
  if (node.type === 'table' && field === 'rows') {
    if (node.columns.length > MAX_COLUMNS) throw new Error('columns');
    const columns = new Set(node.columns.map((column) => column.key));
    return Array.from({ length: value.length }, (_, index) => {
      const row = ownValue(value, String(index));
      if (!plainObject(row)) throw new Error('row');
      const keys = Object.keys(row);
      if (keys.length > MAX_COLUMNS) throw new Error('columns');
      const result: Record<string, string | number | boolean | null> = Object.create(null);
      for (const key of keys) {
        if (UNSAFE_KEYS.has(key) || !columns.has(key)) throw new Error('column');
        const entry = ownValue(row, key);
        if (!cell(entry)) throw new Error('cell');
        result[key] = entry;
      }
      return result;
    });
  }
  if (node.type === 'chart' && field === 'data') {
    return Array.from({ length: value.length }, (_, index) => {
      const row = ownValue(value, String(index));
      if (!plainObject(row) || Object.keys(row).some((key) => key !== 'label' && key !== 'value'))
        throw new Error('point');
      const label = ownValue(row, 'label');
      const amount = ownValue(row, 'value');
      if (!text(label, 1024) || !finite(amount) || amount < 0) throw new Error('point');
      return { label, value: amount };
    });
  }
  throw new Error('type');
}

/** A resolved display node or a local, readable binding error. */
export type WidgetBindingResult =
  { node: WidgetNode; error?: never } | { node?: never; error: string };

/** Bind only catalog display fields. Fail locally rather than displaying stale fallback data. */
export function resolveWidgetBindings(node: WidgetNode, state: unknown): WidgetBindingResult {
  if (!('bind' in node) || node.bind === undefined) return { node };
  const fields = DISPLAY_FIELDS[node.type];
  const bind = node.bind;
  if (!fields || !plainObject(bind))
    return { error: 'This element has an unsupported state binding.' };
  const keys = Object.keys(bind);
  if (keys.length === 0) return { node };
  const values: Record<string, unknown> = {};
  for (const field of keys) {
    try {
      if (!fields.includes(field)) throw new Error('field');
      const binding = ownValue(bind, field);
      if (
        !plainObject(binding) ||
        Object.keys(binding).length !== 1 ||
        !Object.hasOwn(binding, 'path')
      )
        throw new Error('binding');
      const path = ownValue(binding, 'path');
      if (typeof path !== 'string') throw new Error('path');
      const value = displayValue(node, field, readWidgetStatePath(state, path));
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65_536)
        throw new Error('size');
      values[field] = value;
    } catch {
      return { error: `Cannot show ${field}: its state value is missing or has the wrong type.` };
    }
  }
  return { node: { ...node, ...values } as WidgetNode };
}
