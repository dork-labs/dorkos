import { describe, it, expect } from 'vitest';
import {
  DOC_EMBED_CATALOG,
  DOC_EMBED_NAMES,
  decodeDocEmbed,
  isDocEmbedName,
  validateDocEmbed,
  type DocEmbedName,
} from '../doc-embeds.js';
import { WidgetNodeSchema } from '../ui-widget.js';

/** Decode, failing the test with the issues when it does not decode. */
function decoded(name: string, attributes: Record<string, string>) {
  const result = decodeDocEmbed(name, attributes);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.node;
}

/** The issues, failing the test when the attributes decode. */
function issuesOf(name: string, attributes: Record<string, string>) {
  const result = decodeDocEmbed(name, attributes);
  if (result.ok) throw new Error(`expected issues, decoded ${JSON.stringify(result.node)}`);
  return result.issues;
}

describe('DOC_EMBED_CATALOG', () => {
  it('lists exactly the names it exports, each a widget node type', () => {
    expect(Object.keys(DOC_EMBED_CATALOG)).toEqual([...DOC_EMBED_NAMES]);
  });

  it.each(DOC_EMBED_NAMES)('%s: its slash-menu starter decodes to a valid node', (name) => {
    const node = decoded(name, { ...DOC_EMBED_CATALOG[name].example });
    expect(node.type).toBe(name);
    // The decoded node is exactly what the dorkos-ui fence schema accepts.
    expect(WidgetNodeSchema.safeParse(node).success).toBe(true);
  });

  it('leaves out every node that needs an agent round-trip', () => {
    for (const type of ['button', 'form', 'input', 'select', 'board', 'reveal', 'checklist']) {
      expect(isDocEmbedName(type)).toBe(false);
    }
  });
});

describe('decodeDocEmbed codecs', () => {
  it('parses number attributes and leaves non-numbers for the schema to report', () => {
    expect(decoded('progress', { value: '72' })).toEqual({ type: 'progress', value: 72 });
    expect(decoded('rating', { value: '4.5', count: '1e2' })).toEqual({
      type: 'rating',
      value: 4.5,
      count: 100,
    });
    expect(issuesOf('chart', { kind: 'bar', data: '[]', height: 'tall' })[0]?.path).toEqual([
      'height',
    ]);
  });

  it('keeps text attributes as written, numeric-looking or not', () => {
    expect(decoded('stat', { label: 'Year', value: '2026' })).toEqual({
      type: 'stat',
      label: 'Year',
      value: '2026',
    });
  });

  it('reads a scalar delta as a number when it is one, so its sign sets the direction', () => {
    expect(decoded('stat', { label: 'Temp', value: '64', delta: '-3' })).toMatchObject({
      delta: { value: -3, direction: 'down' },
    });
    expect(decoded('stat', { label: 'Temp', value: '64', delta: '+2°' })).toMatchObject({
      delta: { value: '+2°', direction: 'flat' },
    });
  });

  it('pairs delta with an explicit direction', () => {
    expect(
      decoded('stat', { label: 'Revenue', value: '$12k', delta: '+8%', direction: 'increase' })
    ).toMatchObject({ delta: { value: '+8%', direction: 'up' } });
    // A direction alone points at the delta it is missing.
    expect(issuesOf('stat', { label: 'x', value: '1', direction: 'up' })[0]?.path).toEqual([
      'delta',
    ]);
  });

  it('parses one JSON attribute into structured data', () => {
    const node = decoded('chart', { kind: 'line', data: '[{"label":"Q1","value":"3"}]' });
    expect(node).toEqual({ type: 'chart', kind: 'line', data: [{ label: 'Q1', value: 3 }] });
  });

  it('reports JSON that does not parse on the attribute, with how to write it', () => {
    const [issue] = issuesOf('table', { columns: '[{key:"a"}]', rows: '[]' });
    expect(issue?.path).toEqual(['columns']);
    expect(issue?.message).toMatch(/valid JSON/);
  });
});

describe('decodeDocEmbed validation', () => {
  it('points widget-schema issues at the attribute and the place inside it', () => {
    const issues = issuesOf('chart', { kind: 'bar', data: '[{"label":"a","value":-1}]' });
    expect(issues[0]?.path).toEqual(['data', 0, 'value']);
  });

  it('reports a missing required field', () => {
    expect(issuesOf('chart', { kind: 'bar' })[0]?.path).toEqual(['data']);
  });

  it('refuses an attribute the embed does not take, naming the ones it does', () => {
    const [issue] = issuesOf('badge', { text: 'ok', colour: 'green' });
    expect(issue).toEqual({ path: ['colour'], message: expect.stringContaining('text, tone') });
  });

  it('refuses list actions, which have nobody to go to in a doc', () => {
    const items = JSON.stringify([
      { title: 'Open', actions: [{ kind: 'url', href: 'https://example.com' }] },
    ]);
    expect(issuesOf('list', { items })[0]?.path).toEqual(['items', 0, 'actions']);
  });

  it('refuses names outside the catalog, prototype keys included', () => {
    for (const name of ['button', 'constructor', 'toString', '__proto__']) {
      expect(isDocEmbedName(name)).toBe(false);
      expect(decodeDocEmbed(name, {}).ok).toBe(false);
    }
  });

  it('answers in the plain-function validator shape Blintz reads', () => {
    expect(validateDocEmbed('badge', { text: 'ok' })).toEqual({});
    expect(validateDocEmbed('badge', {}).issues?.length).toBeGreaterThan(0);
  });

  it.each(DOC_EMBED_NAMES)('%s: an empty directive reports issues, never throws', (name) => {
    const result = decodeDocEmbed(name as DocEmbedName, {});
    // Every embed has at least one required field.
    expect(result.ok).toBe(false);
  });
});
