/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { WidgetNodeView } from '../ui/WidgetNodeView';

const data = [
  { label: 'Mon', value: 4 },
  { label: 'Tue', value: 7 },
  { label: 'Wed', value: 5 },
];

/** Every bar's inline fill, in order. */
function barFills(node: WidgetNode): string[] {
  const html = renderToStaticMarkup(<WidgetNodeView node={node} />);
  return [...html.matchAll(/rounded-t-sm"[^>]*?background-color:([^;"]+)/g)].map((m) => m[1]!);
}

describe('ChartNode', () => {
  it('draws one series of bars in one muted colour', () => {
    const fills = barFills({ type: 'chart', kind: 'bar', data });
    expect(fills).toHaveLength(3);
    expect(new Set(fills).size).toBe(1);
    expect(fills[0]).toContain('--muted-foreground');
  });

  it('draws only the highlighted bar in the accent', () => {
    const fills = barFills({ type: 'chart', kind: 'bar', data, highlight: 'Tue' });
    expect(fills[1]).toContain('--chart-1');
    expect(fills[0]).toBe(fills[2]);
    expect(fills[0]).not.toContain('--chart-');
  });

  it('keeps the categorical palette for a pie, whose slices are different things', () => {
    const html = renderToStaticMarkup(
      <WidgetNodeView node={{ type: 'chart', kind: 'pie', data }} />
    );
    for (const token of ['--chart-1', '--chart-2', '--chart-3']) expect(html).toContain(token);
  });

  it('plots 160 pixels tall unless told otherwise', () => {
    const html = renderToStaticMarkup(
      <WidgetNodeView node={{ type: 'chart', kind: 'bar', data }} />
    );
    expect(html).toContain('height:160px');
  });
});
