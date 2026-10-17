/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { WidgetDocument, WidgetNode } from '@dorkos/shared/ui-widget';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { readWidgetStatePath, resolveWidgetBindings } from '../lib/widget-bindings';
import type { WidgetChannelPort } from '../model/widget-channel';
import { WidgetRenderer } from '../ui/WidgetRenderer';

// Disable entrance/count animations so assertions observe the current display value.
vi.mock('../lib/widget-motion', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../lib/widget-motion')),
  useWidgetMotion: () => false,
}));

afterEach(cleanup);
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

const boundText: WidgetNode = {
  type: 'text',
  text: 'Old fallback',
  bind: { text: { path: '/message' } },
};

describe('literal state reads', () => {
  it('decodes escaped keys and canonical array indices, including empty object keys', () => {
    const state = { 'a/b': { '~name': ['first', 'second'] }, '': 'empty' };
    expect(readWidgetStatePath(state, '/a~1b/~0name/1')).toBe('second');
    expect(readWidgetStatePath(state, '/')).toBe('empty');
    expect(readWidgetStatePath(state, '')).toBe(state);
  });
  it('refuses an array as the state root and preserves ordinary nodes unchanged', () => {
    expect(() => readWidgetStatePath(['value'], '/0')).toThrow();
    const input: WidgetNode = { type: 'input', name: 'draft' };
    expect(resolveWidgetBindings(input, undefined).node).toBe(input);
  });
  it.each(['/list/01', '/list/-', '/list/1', '/list/1.0', '/list/+0', '/list/9007199254740993'])(
    'rejects invalid array index %s',
    (path) => {
      expect(() => readWidgetStatePath({ list: ['only'] }, path)).toThrow();
    }
  );
  it.each(['value', '$.value', '/bad~9', '/constructor', '/__proto__', '/prototype'])(
    'rejects unsafe path %s',
    (path) => {
      expect(() => readWidgetStatePath({}, path)).toThrow();
    }
  );
  it('never executes getters or walks inherited objects', () => {
    const getter = vi.fn(() => 'secret');
    const state = Object.defineProperty({}, 'message', { enumerable: true, get: getter });
    expect(resolveWidgetBindings(boundText, state).error).toBeDefined();
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      readWidgetStatePath(Object.create({ message: 'inherited' }), '/message')
    ).toThrow();
  });
});

describe('display catalog types and bounds', () => {
  it('updates all five supported node types without coercing values', () => {
    const nodes: WidgetNode[] = [
      boundText,
      { type: 'stat', label: 'Total', value: 0, bind: { value: { path: '/count' } } },
      {
        type: 'progress',
        value: 0,
        bind: { value: { path: '/percent' }, label: { path: '/label' } },
      },
      {
        type: 'table',
        columns: [{ key: 'name', label: 'Name' }],
        rows: [],
        bind: { rows: { path: '/rows' } },
      },
      { type: 'chart', kind: 'line', data: [], bind: { data: { path: '/points' } } },
    ];
    const state = {
      message: 'Current',
      count: 4,
      percent: 80,
      label: 'Working',
      rows: [{ name: 'Ada' }],
      points: [{ label: 'Now', value: 3 }],
    };
    const results = nodes.map((node) => resolveWidgetBindings(node, state));
    expect(results.every((result) => result.error === undefined)).toBe(true);
    expect(results.map((result) => result.node)).toEqual(
      nodes.map((node) => ({
        ...node,
        ...(node.type === 'text'
          ? { text: 'Current' }
          : node.type === 'stat'
            ? { value: 4 }
            : node.type === 'progress'
              ? { value: 80, label: 'Working' }
              : node.type === 'table'
                ? { rows: state.rows }
                : { data: state.points }),
      }))
    );
  });
  it.each([undefined, {}, { message: 4 }, { message: 'x'.repeat(16_385) }])(
    'shows a local error rather than a stale fallback',
    (state) => {
      expect(resolveWidgetBindings(boundText, state)).toEqual({
        error: 'Cannot show text: its state value is missing or has the wrong type.',
      });
    }
  );
  it('rejects extra table keys, nested cells, oversized data and chart accessors without invoking them', () => {
    const table: WidgetNode = {
      type: 'table',
      columns: [{ key: 'name', label: 'Name' }],
      rows: [],
      bind: { rows: { path: '/rows' } },
    };
    for (const rows of [
      [{ other: 'wrong' }],
      [{ name: {} }],
      Array.from({ length: 101 }, () => ({ name: 'x' })),
      Array.from({ length: 100 }, () => ({ name: 'x'.repeat(1024) })),
    ]) {
      expect(resolveWidgetBindings(table, { rows }).error).toBeDefined();
    }
    const getter = vi.fn(() => 1);
    const point = Object.defineProperty({ label: 'Now' }, 'value', {
      enumerable: true,
      get: getter,
    });
    const chart: WidgetNode = {
      type: 'chart',
      kind: 'bar',
      data: [],
      bind: { data: { path: '/points' } },
    };
    expect(resolveWidgetBindings(chart, { points: [point] }).error).toBeDefined();
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(['80', -1, 101, Infinity])(
    'refuses nonnumeric or out-of-range progress %s',
    (percent) => {
      expect(
        resolveWidgetBindings(
          { type: 'progress', value: 0, bind: { value: { path: '/percent' } } },
          { percent }
        ).error
      ).toBeDefined();
    }
  );
});

function channel(
  state: NonNullable<WidgetChannelPort['snapshot']>['state'],
  stateRev = 1
): WidgetChannelPort {
  return {
    documentId: 'document',
    enabled: false,
    destinationLabel: 'This document',
    approvedEventTypes: [],
    snapshot: {
      state,
      stateRev,
      receipts: [],
      retentionFloor: 0,
      receiptRetentionFloor: 0,
      resetRequired: false,
    },
    submit: vi.fn(),
    inspect: vi.fn(),
  };
}

describe('real renderer replay updates', () => {
  it('renders an empty bind inline without a channel snapshot', () => {
    const document: WidgetDocument = {
      version: 1,
      root: { type: 'text', text: 'Inline text', bind: {} },
    };
    render(
      <TransportProvider transport={createMockTransport()}>
        <WidgetRenderer document={document} />
      </TransportProvider>
    );
    expect(screen.getByText('Inline text')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('renders missing prototype-named table cells as empty while preserving ordinary bound cells', () => {
    const document: WidgetDocument = {
      version: 1,
      root: {
        type: 'table',
        columns: [
          { key: 'constructor', label: 'Constructor' },
          { key: 'toString', label: 'To string' },
          { key: 'name', label: 'Name' },
        ],
        rows: [],
        bind: { rows: { path: '/rows' } },
      },
    };
    const port = channel({ rows: [{ name: 'Ada' }] });
    render(
      <TransportProvider transport={createMockTransport()}>
        <WidgetRenderer document={document} channel={port} />
      </TransportProvider>
    );
    const table = screen.getByRole('table');
    const cells = within(table).getAllByRole('cell');
    expect(cells.map((cell) => cell.textContent)).toEqual(['—', '—', 'Ada']);
    expect(table.textContent).not.toContain('function');
    const result = resolveWidgetBindings(document.root, port.snapshot?.state);
    expect(result.error).toBeUndefined();
    if (result.node?.type !== 'table') throw new Error('Expected bound table');
    expect(Object.getPrototypeOf(result.node.rows[0])).toBeNull();
    expect(Object.hasOwn(result.node.rows[0], 'constructor')).toBe(false);
    expect(Object.hasOwn(result.node.rows[0], 'toString')).toBe(false);
  });
  it('keeps native draft, DOM identity, caret, focus and scroll across state and receipt updates', () => {
    const document: WidgetDocument = {
      version: 1,
      root: {
        type: 'form',
        children: [{ type: 'input', name: 'note', label: 'Note' }, boundText],
        submit: { label: 'Send', action: { kind: 'agent', id: 'send' } },
      },
    };
    const transport = createMockTransport();
    const view = (port: WidgetChannelPort) => (
      <TransportProvider transport={transport}>
        <WidgetRenderer document={document} channel={port} />
      </TransportProvider>
    );
    const { rerender, container } = render(view(channel({ message: 'First' })));
    const input = screen.getByRole('textbox', { name: 'Note' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'my draft' } });
    input.focus();
    input.setSelectionRange(2, 5);
    container.scrollTop = 45;
    rerender(view(channel({ message: 'Updated' }, 2)));
    expect(screen.getByText('Updated')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Note' })).toBe(input);
    expect(input.value).toBe('my draft');
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
    expect(container.scrollTop).toBe(45);
    rerender(
      view({
        ...channel({ message: 'Updated' }, 2),
        snapshot: { ...channel({ message: 'Updated' }, 2).snapshot!, receiptRetentionFloor: 3 },
      })
    );
    expect(screen.getByRole('textbox', { name: 'Note' })).toBe(input);
    expect(input).toHaveFocus();
    expect(input.value).toBe('my draft');
    rerender(view(channel({}, 3)));
    expect(screen.getByRole('status')).toHaveTextContent('Cannot show text');
    expect(screen.getByRole('textbox', { name: 'Note' })).toBe(input);
    expect(input).toHaveFocus();
    expect(input.value).toBe('my draft');
    rerender(view(channel({ message: 'Reset snapshot' }, 1)));
    expect(screen.getByText('Reset snapshot')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Note' })).toBe(input);
  });
});
