import { expect, it } from 'vitest';
import { generateOpenAPISpec } from '../../../core/openapi-registry.js';

it('exports the mounted browser owner routes with bounded wire schemas and distinct viewer/input authority', () => {
  const paths = generateOpenAPISpec().paths ?? {};
  const expected = {
    '/runtime/status': 'get',
    '/runtime/enable': 'post',
    '/runtime/profiles': 'post',
    '/runtime/profiles/import': 'post',
    '/runtime/open': 'post',
    '/runtime/local-destination': 'post',
    '/diagnostics': 'post',
    '/files/grant': 'post',
    '/files/revoke': 'post',
    '/files/stage': 'post',
    '/files/upload': 'post',
    '/files/download': 'post',
    '/files/read': 'post',

    '/canvas/present': 'post',
    '/canvas/share': 'post',
    '/canvas/delivery': 'post',
    '/canvas/detach': 'post',
    '/runtime/navigate': 'post',
    '/workspaces/{workspaceId}/open': 'post',
    '/instances/close': 'post',
    '/navigate': 'post',
    '/control': 'post',
    '/{browserId}/tabs': 'get',
    '/profiles': 'get',
    '/profiles/{profileId}': 'get',
    '/instances': 'get',
    '/instances/{browserId}': 'get',
    '/viewers/issue': 'post',
    '/viewers/next': 'post',
    '/viewers/disconnect': 'post',
    '/input': 'post',
    '/copy-selection': 'post',
    ...Object.fromEntries(
      ['/semantic/', '/semantic/owner/'].flatMap((prefix) =>
        ['read', 'action', 'stream', 'next', 'close'].map(
          (kind) => [prefix + kind, 'post'] as const
        )
      )
    ),
  } as const;
  expect(
    Object.keys(paths)
      .filter((path) => path.startsWith('/api/browser/'))
      .sort()
  ).toEqual(
    Object.keys(expected)
      .map((path) => '/api/browser' + path)
      .sort()
  );
  for (const [path, method] of Object.entries(expected))
    expect(paths['/api/browser' + path]?.[method as 'get' | 'post']).toBeDefined();
  const next = paths['/api/browser/viewers/next']!.post!;
  expect(JSON.stringify(next.responses?.['200'])).toContain('application/vnd.dorkos.browser-frame');
  // Viewer tickets remain private bodies. API docs must not turn them into URL examples.
  expect(next.parameters ?? []).toEqual([]);
  const copy = paths['/api/browser/copy-selection']!.post!;
  expect(JSON.stringify(copy.requestBody)).toContain('controllerId');
  expect(JSON.stringify(copy.responses?.['200'])).toContain('secret');
  const input = JSON.stringify(paths['/api/browser/input']!.post!.requestBody);
  expect(input).toContain('controllerId');
  expect(input).toContain('command');
  expect(paths['/api/browser/viewers/issue']!.post!.description).toContain(
    'Viewer permission never grants input permission'
  );
  expect(paths['/api/browser/runtime/status']!.get!.description).toContain('not an open browser');
  expect(Object.keys(paths['/api/browser/runtime/enable']!.post!.responses!)).toEqual([
    '200',
    '403',
    '503',
  ]);
  expect(Object.keys(paths['/api/browser/input']!.post!.responses!)).toEqual([
    '200',
    '400',
    '403',
    '404',
    '503',
  ]);
  expect(Object.keys(next.responses!)).toEqual(['200', '400', '401', '404', '500', '503']);
  expect(paths['/api/browser/runtime/status']!.get!.responses!['403']).toMatchObject({
    description: 'The request host or origin was refused.',
  });
  for (const prefix of ['/semantic/', '/semantic/owner/'])
    for (const kind of ['read', 'action', 'stream', 'next', 'close'])
      expect(paths['/api/browser' + prefix + kind]?.post).toBeDefined();
  expect(JSON.stringify(paths['/api/browser/canvas/delivery']!.post!.requestBody)).toContain(
    'attachmentId'
  );
  expect(JSON.stringify(paths['/api/browser/semantic/owner/action']!.post!.requestBody)).toContain(
    'controllerId'
  );
  expect(
    JSON.stringify(paths['/api/browser/runtime/local-destination']!.post!.requestBody)
  ).toContain('ttlMilliseconds');
  expect(paths['/api/browser/runtime/open']!.post!.description).toContain('off by default');
});
