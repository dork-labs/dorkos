import { describe, expect, it } from 'vitest';
import type { Root } from 'fumadocs-core/page-tree';
import { docsSectionTrail } from '../docs-breadcrumb';

// A minimal docs tree mirroring the real shape: a "Getting Started" folder with
// an index page and a child, a folder whose meta title differs from its slug,
// and a top-level page directly under /docs.
const tree: Root = {
  name: 'Documentation',
  children: [
    {
      type: 'folder',
      name: 'Getting Started',
      index: { type: 'page', name: 'Getting Started', url: '/docs/getting-started' },
      children: [{ type: 'page', name: 'Quickstart', url: '/docs/getting-started/quickstart' }],
    },
    {
      type: 'folder',
      name: 'Self-Hosting',
      index: { type: 'page', name: 'Self-Hosting', url: '/docs/self-hosting' },
      children: [{ type: 'page', name: 'Docker', url: '/docs/self-hosting/docker' }],
    },
    { type: 'page', name: 'Glossary', url: '/docs/glossary' },
  ],
};

describe('docsSectionTrail', () => {
  it('returns the section folder for a nested page, using the folder meta title', () => {
    const trail = docsSectionTrail(
      { url: '/docs/getting-started/quickstart', slugs: ['getting-started', 'quickstart'] },
      tree
    );
    expect(trail).toEqual([{ name: 'Getting Started', url: '/docs/getting-started' }]);
  });

  it('preserves a folder title that differs from the title-cased slug', () => {
    const trail = docsSectionTrail(
      { url: '/docs/self-hosting/docker', slugs: ['self-hosting', 'docker'] },
      tree
    );
    expect(trail).toEqual([{ name: 'Self-Hosting', url: '/docs/self-hosting' }]);
  });

  it('returns an empty trail for a top-level page under /docs', () => {
    const trail = docsSectionTrail({ url: '/docs/glossary', slugs: ['glossary'] }, tree);
    expect(trail).toEqual([]);
  });

  it('returns an empty trail for the docs index', () => {
    const trail = docsSectionTrail({ url: '/docs', slugs: [] }, tree);
    expect(trail).toEqual([]);
  });

  it('names a folder from its meta title even without an index page (no url)', () => {
    const treeNoIndex: Root = {
      name: 'Documentation',
      children: [
        {
          type: 'folder',
          name: 'Self-Hosting',
          children: [{ type: 'page', name: 'Docker', url: '/docs/self-hosting/docker' }],
        },
      ],
    };
    const trail = docsSectionTrail(
      { url: '/docs/self-hosting/docker', slugs: ['self-hosting', 'docker'] },
      treeNoIndex
    );
    expect(trail).toEqual([{ name: 'Self-Hosting', url: '/docs/self-hosting' }]);
  });

  it('title-cases the slug when the page is absent from the tree', () => {
    const trail = docsSectionTrail(
      { url: '/docs/getting-started/quickstart', slugs: ['getting-started', 'quickstart'] },
      { name: 'Documentation', children: [] }
    );
    expect(trail).toEqual([{ name: 'Getting Started', url: '/docs/getting-started' }]);
  });

  it('orders a 2-level nested trail root-to-leaf, pairing each name and url by position', () => {
    const nestedTree: Root = {
      name: 'Documentation',
      children: [
        {
          type: 'folder',
          name: 'Integrations',
          index: { type: 'page', name: 'Integrations', url: '/docs/integrations' },
          children: [
            {
              type: 'folder',
              name: 'Relay Adapters',
              index: {
                type: 'page',
                name: 'Relay Adapters',
                url: '/docs/integrations/relay-adapters',
              },
              children: [
                {
                  type: 'page',
                  name: 'Some Page',
                  url: '/docs/integrations/relay-adapters/some-page',
                },
              ],
            },
          ],
        },
      ],
    };
    const trail = docsSectionTrail(
      {
        url: '/docs/integrations/relay-adapters/some-page',
        slugs: ['integrations', 'relay-adapters', 'some-page'],
      },
      nestedTree
    );
    expect(trail).toEqual([
      { name: 'Integrations', url: '/docs/integrations' },
      { name: 'Relay Adapters', url: '/docs/integrations/relay-adapters' },
    ]);
  });
});
