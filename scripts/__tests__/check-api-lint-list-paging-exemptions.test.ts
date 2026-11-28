import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSpec } from '../api-lint/document.ts';
import {
  LIST_PAGING_EXEMPTION_CATEGORIES,
  LIST_PAGING_EXEMPTIONS,
  staleExemptions,
  withoutExemptLists,
  type ListPagingExemption,
} from '../api-lint/list-paging-exemptions.ts';
import { listPagingItems } from '../api-lint/rules.ts';
import {
  INTERNAL_PART_PATH,
  PUBLISHED_DOCUMENT_PATH,
  mergeInternalPart,
} from '../../packages/api-client/scripts/api-document.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => parseSpec(readFileSync(join(ROOT, path), 'utf8'), path);

const exempt = (path: string): ListPagingExemption => ({
  method: 'GET',
  path,
  category: 'small-fixed',
  reason: 'test',
});

describe('list-paging exemptions', () => {
  it('drops exempt lists, and a group they empty, and keeps the rest', () => {
    const items = { a: ['GET /api/a'], b: ['GET /api/b', 'GET /api/b/c'] };
    const exemptions = [exempt('/api/a'), exempt('/api/b')];
    expect(withoutExemptLists(items, exemptions)).toEqual({ b: ['GET /api/b/c'] });
  });

  it('names an exemption that matches no unpaged list as stale', () => {
    const items = { a: ['GET /api/a'] };
    expect(staleExemptions(items, [exempt('/api/a'), exempt('/api/gone')])).toEqual([
      'GET /api/gone',
    ]);
  });

  it('gives every entry a known category and a real reason, once each', () => {
    const labels = LIST_PAGING_EXEMPTIONS.map((x) => `${x.method} ${x.path}`);
    expect(new Set(labels).size).toBe(labels.length);
    for (const x of LIST_PAGING_EXEMPTIONS) {
      expect(LIST_PAGING_EXEMPTION_CATEGORIES, x.path).toContain(x.category);
      expect(x.reason.trim().length, `${x.path} needs a reason`).toBeGreaterThan(10);
    }
  });

  it('matches only unpaged lists in the committed document: drop an entry once its list pages, moves or goes', () => {
    const doc = mergeInternalPart(read(PUBLISHED_DOCUMENT_PATH), read(INTERNAL_PART_PATH));
    expect(staleExemptions(listPagingItems(doc))).toEqual([]);
  });
});
