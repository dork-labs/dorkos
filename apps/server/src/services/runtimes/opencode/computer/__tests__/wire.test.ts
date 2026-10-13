import { describe, expect, it } from 'vitest';
import { ComputerWire } from '../wire.js';
const wire = new ComputerWire('/owned/anchor', '/home/agent/project');
describe('ComputerWire', () => {
  it('translates query/header/body directory and leaves prompt text unchanged', async () => {
    const req = await wire.request(
      new Request('http://127.0.0.1:9000/session?directory=%2Fowned%2Fanchor', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-opencode-directory': '/owned/anchor' },
        body: JSON.stringify({ directory: '/owned/anchor', text: '/owned/anchor' }),
      }),
      []
    );
    expect(new URL(req.url).searchParams.get('directory')).toBe('/home/agent/project');
    expect(req.headers.get('x-opencode-directory')).toBe('/home/agent/project');
    expect(await req.json()).toEqual({ directory: '/home/agent/project', text: '/owned/anchor' });
  });
  it('refuses foreign and ambiguous directories', async () => {
    await expect(
      wire.request(new Request('http://127.0.0.1/session?directory=/etc'), [])
    ).rejects.toThrow('DIRECTORY_REFUSED');
    await expect(
      wire.request(
        new Request('http://127.0.0.1/session?directory=/owned/anchor&directory=/etc'),
        []
      )
    ).rejects.toThrow();
    expect(() => wire.response('/session', [{ id: 'ses_foreign', directory: '/etc' }])).toThrow(
      'DIRECTORY_REFUSED'
    );
  });
  it('maps session/history/SSE structural fields but preserves tool output and prose', () => {
    expect(
      wire.response('/session', [
        { id: 'ses_one', directory: '/home/agent/project', title: '/home/agent/project' },
      ])
    ).toEqual([{ id: 'ses_one', directory: '/owned/anchor', title: '/home/agent/project' }]);
    const parts = [
      { type: 'tool', state: { output: '/home/agent/project', directory: '/home/agent/project' } },
    ];
    expect(
      wire.response('/session/ses_one/message', [
        { info: { path: { cwd: '/home/agent/project', root: '/home/agent/project' } }, parts },
      ])
    ).toEqual([{ info: { path: { cwd: '/owned/anchor', root: '/owned/anchor' } }, parts }]);
    expect(
      wire.event({
        directory: '/home/agent/project',
        payload: {
          type: 'session.updated',
          properties: {
            info: { directory: '/home/agent/project', title: '/home/agent/project' },
          },
        },
      })
    ).toEqual({
      directory: '/owned/anchor',
      payload: {
        type: 'session.updated',
        properties: {
          info: { directory: '/owned/anchor', title: '/home/agent/project' },
        },
      },
    });
  });
  it('refuses host/local MCP, config mutation, credentials and credits', async () => {
    const post = (path: string, value: unknown) =>
      new Request(`http://127.0.0.1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
    await expect(
      wire.request(post('/mcp', { config: { type: 'local', command: ['sh'] } }), [])
    ).rejects.toThrow('MCP_REFUSED');
    await expect(
      wire.request(
        post('/mcp', { config: { type: 'remote', url: 'http://localhost:4242/mcp' } }),
        []
      )
    ).rejects.toThrow('MCP_REFUSED');
    await expect(wire.request(post('/config', {}), [])).rejects.toThrow('CONFIG_REFUSED');
    await expect(wire.request(new Request('http://127.0.0.1/auth'), [])).rejects.toThrow(
      'AUTH_REFUSED'
    );
    await expect(
      wire.request(
        post('/session/s/prompt_async', { model: { providerID: 'dorkos-credits', modelID: 'x' } }),
        []
      )
    ).rejects.toThrow('CREDITS_REFUSED');
    const req = await wire.request(
      post('/mcp', { config: { type: 'remote', url: 'http://bridge.internal/mcp' } }),
      ['http://bridge.internal/mcp']
    );
    expect(req.headers.get('x-opencode-directory')).toBe('/home/agent/project');
  });
});

it('admits the non-git global-root sentinel only beside the exact guest cwd', () => {
  expect(wire.history({ info: { path: { cwd: '/home/agent/project', root: '/' } } })).toEqual({
    info: { path: { cwd: '/owned/anchor', root: '/owned/anchor' } },
  });
  expect(() => wire.history({ info: { path: { cwd: '/etc', root: '/' } } })).toThrow(
    'DIRECTORY_REFUSED'
  );
  expect(() => wire.history({ info: { path: { root: '/' } } })).toThrow('DIRECTORY_REFUSED');
  expect(() =>
    wire.history({ info: { path: { cwd: '/home/agent/project', root: '/etc' } } })
  ).toThrow('DIRECTORY_REFUSED');
});
