import { expect, it } from 'vitest';
import { uniqueSemanticTab } from '../semantic/owned-read.js';

it('correlates the original native target independently of identical URLs and numeric ordering', () => {
  expect(
    uniqueSemanticTab(
      [
        { tab: 42, url: 'https://same.test/', targetId: 'target_B' },
        { tab: 9, url: 'https://same.test/', targetId: 'target_A' },
      ],
      'target_A'
    )
  ).toBe(9);
});
it('refuses missing, duplicate target and duplicate numeric identities rather than selecting a page', () => {
  expect(() =>
    uniqueSemanticTab([{ tab: 9, url: 'https://same.test/', targetId: 'target_A' }], 'target_B')
  ).toThrow('SEMANTIC_PAGE_CORRELATION_REFUSED');
  expect(() =>
    uniqueSemanticTab(
      [
        { tab: 9, url: '', targetId: 'target_A' },
        { tab: 10, url: '', targetId: 'target_A' },
      ],
      'target_A'
    )
  ).toThrow('SEMANTIC_PAGE_CORRELATION_REFUSED');
  expect(() =>
    uniqueSemanticTab(
      [
        { tab: 9, url: '', targetId: 'target_A' },
        { tab: 9, url: '', targetId: 'target_B' },
      ],
      'target_A'
    )
  ).toThrow('SEMANTIC_PAGE_CORRELATION_REFUSED');
});
