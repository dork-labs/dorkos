/**
 * An agent building a page can read back why DorkOS served it without its frame
 * scripts (DOR-3131): `read_canvas_document` on a browser document carries the
 * decision the serving path recorded.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const documents = new Map<string, { id: string; content: { type: string; url: string } }>();
vi.mock('../../../canvas/index.js', () => ({
  sessionScope: (sessionId: string) => `session:${sessionId}`,
  canvasSourcePath: () => null,
  peekCanvasService: () => ({
    get: (_scope: string, id: string) => {
      const document = documents.get(id);
      return document
        ? {
            ...document,
            contentType: document.content.type,
            title: 'Page',
            authorId: 'agent',
            pinned: false,
            openedAt: 1,
            lastTouchedAt: 1,
          }
        : undefined;
    },
    resolvedTreeOf: () => null,
  }),
}));

import { initBoundary } from '../../../../lib/boundary.js';
import {
  frameBridgeLedger,
  previewPageKey,
  servedFileKey,
} from '../../../workbench-serve/bridge-ledger.js';
import { readSessionCanvasDocument } from '../read-canvas-document.js';

let root: string;

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-canvas-bridge-')));
  await fs.writeFile(path.join(root, 'index.html'), '<div>no head</div>');
  await initBoundary(root);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

afterEach(() => {
  documents.clear();
  frameBridgeLedger.clear();
});

describe('read_canvas_document on a browser document', () => {
  it('says why a dev server page has no frame scripts, with a stable code', async () => {
    documents.set('doc-1', {
      id: 'doc-1',
      content: { type: 'browser', url: 'http://localhost:5173/app?x=1' },
    });
    frameBridgeLedger.record(previewPageKey(5173, '/app'), 'csp');
    const result = (await readSessionCanvasDocument('doc-1', { sessionId: 's1' })) as {
      bridge?: { status: string; reason: string; note: string };
    };
    expect(result.bridge).toMatchObject({ status: 'refused', reason: 'csp' });
    expect(result.bridge?.note).toContain('Content-Security-Policy');
  });

  it('resolves a local file against the calling session’s folder', async () => {
    documents.set('doc-2', { id: 'doc-2', content: { type: 'url', url: 'index.html' } });
    frameBridgeLedger.record(servedFileKey(path.join(root, 'index.html')), 'no-head');
    const result = (await readSessionCanvasDocument('doc-2', { sessionId: 's1', cwd: root })) as {
      bridge?: { reason: string };
    };
    expect(result.bridge?.reason).toBe('no-head');
  });

  it('says the scripts went in, and says nothing about a page it never served', async () => {
    documents.set('doc-3', {
      id: 'doc-3',
      content: { type: 'browser', url: 'http://127.0.0.1:3000/' },
    });
    documents.set('doc-4', {
      id: 'doc-4',
      content: { type: 'browser', url: 'https://example.com/' },
    });
    frameBridgeLedger.record(previewPageKey(3000, '/'), null);
    const added = (await readSessionCanvasDocument('doc-3', { sessionId: 's1' })) as {
      bridge?: unknown;
    };
    const external = (await readSessionCanvasDocument('doc-4', { sessionId: 's1' })) as {
      bridge?: unknown;
    };
    expect(added.bridge).toEqual({ status: 'added' });
    expect(external).not.toHaveProperty('bridge');
  });
});
