/**
 * Grouping "Needs You" by project (spec `flow-multiproject` §6.3, V2): the
 * heading hides below two projects, groups keep their most urgent item's
 * order, and items in no project come last with no heading.
 */
import { describe, it, expect } from 'vitest';
import { groupByProject } from '../group-by-project';

const A = { root: '/repos/a', name: 'a' };
const B = { root: '/repos/b', name: 'b' };

type Item = { id: string; project: typeof A | null };
const of = (item: Item) => item.project;

describe('groupByProject', () => {
  it('returns nothing for nothing', () => {
    expect(groupByProject<Item>([], of)).toEqual([]);
  });

  it('draws one headingless group, in the original order, below two projects', () => {
    const items: Item[] = [
      { id: '1', project: A },
      { id: '2', project: null },
      { id: '3', project: A },
    ];
    expect(groupByProject(items, of)).toEqual([{ project: null, items }]);
  });

  it('groups by project in first-seen order, with no-project items last', () => {
    const items: Item[] = [
      { id: '1', project: B },
      { id: '2', project: null },
      { id: '3', project: A },
      { id: '4', project: B },
    ];
    expect(groupByProject(items, of)).toEqual([
      { project: B, items: [items[0], items[3]] },
      { project: A, items: [items[2]] },
      { project: null, items: [items[1]] },
    ]);
  });
});
