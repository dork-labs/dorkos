import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type RequestListener } from 'node:http';
import { LocalResources } from '../resources/resources.js';
import { CanonicalPaths } from '../resources/paths.js';
import { createLocalTools, createSkillTool } from '../tools/local.js';
import { createWebFetchTool } from '../tools/web-fetch.js';
import type { ToolContext, ToolDescriptor } from '../contracts.js';
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'doe-resource-'));
  dirs.push(root);
  return root;
}
function context(cwd: string, signal = new AbortController().signal): ToolContext {
  return { sessionId: 'test', scope: 'main', workingDirectory: cwd, signal, emit: () => {} };
}
function tool(tools: readonly ToolDescriptor[], name: string) {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(name);
  return found;
}
async function http(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port');
  return `http://127.0.0.1:${address.port}`;
}
it('rejects canonical escapes for existing and new targets, dangling links, prefix collisions and link/.. traversal', async () => {
  const base = await fixture();
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'secret'), 'secret');
  await symlink(outside, join(root, 'link'));
  await symlink(join(outside, 'missing'), join(root, 'dangling'));
  await mkdir(join(base, 'root-other'));
  const paths = new CanonicalPaths({ readRoots: [root], writeRoots: [root] }, root);
  for (const p of ['link/secret', 'link/new', 'dangling', 'link/../escaped', '../root-other/new'])
    await expect(paths.resolve(p, 'write')).rejects.toThrow(/grant|denied/i);
  await expect(paths.resolve('new/deep.txt', 'write')).resolves.toBe(
    join(await paths.resolve('.', 'read'), 'new/deep.txt')
  );
  await expect(paths.resolve('\0', 'read')).rejects.toThrow(/path/i);
});
it('orders ancestors and agent resources, preserves supplied context and loads only applicable nested instructions', async () => {
  const root = await fixture();
  const project = join(root, 'project');
  const nested = join(project, 'nested');
  const agent = join(root, 'agent');
  await mkdir(nested, { recursive: true });
  await mkdir(agent);
  await mkdir(join(project, 'unrelated'));
  for (const [p, text] of [
    [join(root, 'AGENTS.md'), 'outer'],
    [join(project, 'AGENTS.md'), 'project'],
    [join(nested, 'AGENTS.md'), 'nested-rule'],
    [join(project, 'unrelated/AGENTS.md'), 'unrelated'],
    [join(agent, 'AGENTS.md'), 'agent-rule'],
    [join(agent, 'SOUL.md'), 'soul-rule'],
  ] as const)
    await writeFile(p, text);
  const resources = new LocalResources(
    {
      ancestorDirectories: [root, project],
      agentDirectory: agent,
      skillRoots: [],
      memory: 'memory-exact',
      context: 'context-exact',
    },
    { readRoots: [root], writeRoots: [project] },
    project
  );
  const initial = await resources.load();
  expect(initial.indexOf('outer')).toBeLessThan(initial.indexOf('project'));
  expect(initial.indexOf('project')).toBeLessThan(initial.indexOf('agent-rule'));
  expect(initial).toContain('soul-rule');
  expect(initial).toContain('memory-exact');
  expect(initial).toContain('context-exact');
  expect(initial).not.toContain('nested-rule');
  expect(await resources.beforeFile(join(nested, 'new.txt'), context(project).signal)).toContain(
    'nested-rule'
  );
  await resources.load();
  expect(await resources.beforeFile(join(nested, 'new.txt'), context(project).signal)).toBe('');
  expect(await resources.load()).toContain('nested-rule');
  expect(await resources.load()).not.toContain('unrelated');
});
it('returns retry-required instructions before unseen nested mutations, then writes, and keeps grants independent', async () => {
  const root = await fixture();
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested/AGENTS.md'), 'Use approved format');
  const resources = new LocalResources(
    { ancestorDirectories: [root], skillRoots: [] },
    { readRoots: [root], writeRoots: [root] },
    root
  );
  const tools = createLocalTools({
    resources,
    pathPolicy: { readRoots: [root], writeRoots: [root] },
    workingDirectory: root,
  });
  const write = tool(tools, 'write');
  const first = await write.execute({ path: 'nested/new.txt', content: 'hello' }, context(root));
  expect(first.structuredContent).toMatchObject({ retryRequired: true });
  expect(first.isError).toBe(true);
  await expect(readFile(join(root, 'nested/new.txt'))).rejects.toThrow();
  await resources.load();
  expect(
    (await write.execute({ path: 'nested/new.txt', content: 'hello' }, context(root))).isError
  ).not.toBe(true);
  expect(await readFile(join(root, 'nested/new.txt'), 'utf8')).toBe('hello');
  expect(
    (await write.execute({ path: '../outside', content: 'escape' }, context(root))).isError
  ).toBe(true);
});
it('bounds read/write/search and allows unique exact edits only in builder tools', async () => {
  const root = await fixture();
  await writeFile(join(root, 'file.txt'), 'hello hello');
  const resources = new LocalResources(
    { ancestorDirectories: [root], skillRoots: [] },
    { readRoots: [root], writeRoots: [root] },
    root
  );
  const options = {
    resources,
    pathPolicy: { readRoots: [root], writeRoots: [root] },
    workingDirectory: root,
    maxOutputBytes: 8,
    maxFileBytes: 64,
    maxSearchFiles: 3,
  };
  const business = createLocalTools(options);
  expect(business.map((t) => t.name)).toEqual(['read', 'write']);
  const builder = createLocalTools({ ...options, builder: true });
  expect(
    (await tool(builder, 'read').execute({ path: 'file.txt' }, context(root))).structuredContent
  ).toMatchObject({ truncated: true });
  const edit = tool(builder, 'edit');
  expect(
    (await edit.execute({ path: 'file.txt', oldText: 'hello', newText: 'bye' }, context(root)))
      .isError
  ).toBe(true);
  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('hello hello');
  expect(
    (
      await edit.execute(
        { path: 'file.txt', oldText: 'hello hello', newText: 'unique' },
        context(root)
      )
    ).isError
  ).not.toBe(true);
  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('unique');
  await writeFile(join(root, 'overlap'), 'aaa');
  expect(
    (await edit.execute({ path: 'overlap', oldText: 'aa', newText: 'x' }, context(root))).isError
  ).toBe(true);
  expect(
    (
      await tool(builder, 'write').execute(
        { path: 'large', content: 'x'.repeat(65) },
        context(root)
      )
    ).isError
  ).toBe(true);
  expect(
    (await tool(builder, 'search').execute({ path: '.', query: 'unique' }, context(root)))
      .structuredContent
  ).toMatchObject({ truncated: true });
  expect((await tool(builder, 'read').execute({ path: 1 }, context(root))).isError).toBe(true);
});
it('discovers metadata deterministically with explicit root priority, namespaces, canonical deduplication and cycles', async () => {
  const root = await fixture();
  const high = join(root, 'high');
  const low = join(root, 'low');
  await mkdir(join(high, 'skill'), { recursive: true });
  await mkdir(join(low, 'skill'), { recursive: true });
  await writeFile(
    join(high, 'skill/SKILL.md'),
    '---\nname: report\ndescription: Higher priority\n---\nSECRET BODY\n'
  );
  await writeFile(
    join(low, 'skill/SKILL.md'),
    '---\nname: report\ndescription: Lower priority\n---\nLOW BODY\n'
  );
  await symlink(high, join(high, 'cycle'));
  await symlink(join(high, 'skill'), join(low, 'duplicate'));
  const resources = new LocalResources(
    {
      ancestorDirectories: [],
      skillRoots: [
        { path: high, namespace: 'team' },
        { path: low, namespace: 'team' },
        { path: low, namespace: 'other' },
      ],
    },
    { readRoots: [root], writeRoots: [] },
    root
  );
  const metadata = await resources.skills();
  expect(metadata.map((x) => x.name)).toEqual(['team:report']);
  expect(metadata[0]?.description).toBe('Higher priority');
  expect(JSON.stringify(metadata)).not.toContain('SECRET BODY');
  expect(await resources.load()).not.toContain('SECRET BODY');
  expect(await resources.loadSkill('team:report', context(root).signal)).toContain('SECRET BODY');
  await expect(resources.resolveSkillPath('team:report', 'scripts/run.js')).resolves.toBe(
    join(
      await new CanonicalPaths({ readRoots: [root], writeRoots: [] }, root).resolve(high, 'read'),
      'skill/scripts/run.js'
    )
  );
});
it('prevents automatic disabled skill invocation, forbids relative-resource escapes and performs no discovery network', async () => {
  const root = await fixture();
  await mkdir(join(root, 'skill'));
  await writeFile(
    join(root, 'skill/SKILL.md'),
    '---\nname: manual\ndescription: Manual only\ndisable-model-invocation: true\n---\nBODY'
  );
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected request'));
  const resources = new LocalResources(
    { ancestorDirectories: [], skillRoots: [{ path: root }] },
    { readRoots: [root], writeRoots: [] },
    root
  );
  expect(await resources.skills()).toHaveLength(1);
  expect(await resources.load()).not.toContain('<name>manual</name>');
  expect(
    (await createSkillTool(resources).execute({ name: 'manual' }, context(root))).isError
  ).toBe(true);
  await expect(resources.resolveSkillPath('manual', '../../../escape')).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it('loads instructions before read, rejects instruction symlink escapes and cancels file tools', async () => {
  const root = await fixture();
  const outside = await fixture();
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested/data'), 'data');
  await writeFile(join(outside, 'instructions'), 'outside');
  await symlink(join(outside, 'instructions'), join(root, 'nested/AGENTS.md'));
  const resources = new LocalResources(
    { ancestorDirectories: [root], skillRoots: [] },
    { readRoots: [root], writeRoots: [root] },
    root
  );
  const read = tool(
    createLocalTools({
      resources,
      pathPolicy: { readRoots: [root], writeRoots: [root] },
      workingDirectory: root,
    }),
    'read'
  );
  expect((await read.execute({ path: 'nested/data' }, context(root))).isError).toBe(true);
  const controller = new AbortController();
  controller.abort();
  expect(
    (await read.execute({ path: 'nested/data' }, context(root, controller.signal))).isError
  ).toBe(true);
});
it('validates policy at every redirect and enforces bounded HTTP response/output without external destinations', async () => {
  const base = await http((_req, res) => {
    if (_req.url === '/redirect') {
      res.writeHead(302, { Location: '/blocked' });
      res.end();
    } else {
      res.end('x'.repeat(40));
    }
  });
  const seen: string[] = [];
  const fetch = createWebFetchTool({
    allowUrl: (url) => {
      seen.push(url.pathname);
      return url.origin === base && url.pathname !== '/blocked';
    },
    maxResponseBytes: 32,
    maxOutputBytes: 8,
  });
  expect((await fetch.execute({ url: `${base}/redirect` }, context('/'))).isError).toBe(true);
  expect(seen).toEqual(['/redirect', '/blocked']);
  expect((await fetch.execute({ url: `${base}/large` }, context('/'))).isError).toBe(true);
  const bounded = createWebFetchTool({
    allowUrl: (url) => url.origin === base,
    maxResponseBytes: 64,
    maxOutputBytes: 8,
  });
  expect((await bounded.execute({ url: base }, context('/'))).structuredContent).toMatchObject({
    truncated: true,
  });
  expect((await bounded.execute({ url: 'file:///secret' }, context('/'))).isError).toBe(true);
});
it('cancels a local pending HTTP fetch', async () => {
  const base = await http((_req, _res) => {});
  const controller = new AbortController();
  const fetch = createWebFetchTool({ allowUrl: (url) => url.origin === base });
  const pending = fetch.execute({ url: base }, context('/', controller.signal));
  setTimeout(() => controller.abort(), 20);
  expect((await pending).isError).toBe(true);
});
it('keeps namespaced distinct skills, rejects malformed metadata and resolves script symlink escapes', async () => {
  const root = await fixture();
  const other = await fixture();
  await mkdir(join(root, 'a'));
  await mkdir(join(root, 'b'));
  for (const directory of ['a', 'b'])
    await writeFile(
      join(root, directory, 'SKILL.md'),
      `---\nname: report\ndescription: ${directory}\n---\n${directory}`
    );
  const resources = new LocalResources(
    {
      ancestorDirectories: [],
      skillRoots: [
        { path: join(root, 'a'), namespace: 'one' },
        { path: join(root, 'b'), namespace: 'two' },
      ],
    },
    { readRoots: [root], writeRoots: [] },
    root
  );
  expect((await resources.skills()).map((s) => s.name)).toEqual(['one:report', 'two:report']);
  await symlink(other, join(root, 'a/scripts'));
  await expect(resources.resolveSkillPath('one:report', 'scripts/new')).rejects.toThrow(/denied/i);
  await writeFile(join(root, 'b/SKILL.md'), '---\nname: bad name\ndescription: bad\n---\n');
  const invalid = new LocalResources(
    { ancestorDirectories: [], skillRoots: [{ path: join(root, 'b') }] },
    { readRoots: [root], writeRoots: [] },
    root
  );
  await expect(invalid.skills()).rejects.toThrow(/metadata/i);
});
it('handles Unicode output bounds, rejects oversized reads and never invokes a shell', async () => {
  const root = await fixture();
  await writeFile(join(root, 'unicode'), 'ééé');
  await writeFile(join(root, 'large'), 'x'.repeat(65));
  const resources = new LocalResources(
    { ancestorDirectories: [root], skillRoots: [] },
    { readRoots: [root], writeRoots: [root] },
    root
  );
  const tools = createLocalTools({
    resources,
    pathPolicy: { readRoots: [root], writeRoots: [root] },
    workingDirectory: root,
    maxOutputBytes: 3,
    maxFileBytes: 64,
  });
  const result = await tool(tools, 'read').execute({ path: 'unicode' }, context(root));
  expect(result.content).toEqual([{ type: 'text', text: 'é' }]);
  expect((await tool(tools, 'read').execute({ path: 'large' }, context(root))).isError).toBe(true);
  expect(tools.some((t) => t.name === 'shell')).toBe(false);
});
it('returns instruction retry before an exact edit and includes newly loaded read instructions', async () => {
  const root = await fixture();
  await mkdir(join(root, 'edit'));
  await mkdir(join(root, 'read'));
  for (const directory of ['edit', 'read']) {
    await writeFile(join(root, directory, 'AGENTS.md'), `${directory}-rule`);
    await writeFile(join(root, directory, 'data'), 'before');
  }
  const resources = new LocalResources(
    { ancestorDirectories: [root], skillRoots: [] },
    { readRoots: [root], writeRoots: [root] },
    root
  );
  const tools = createLocalTools({
    resources,
    pathPolicy: { readRoots: [root], writeRoots: [root] },
    workingDirectory: root,
    builder: true,
  });
  const edit = tool(tools, 'edit');
  expect(
    (await edit.execute({ path: 'edit/data', oldText: 'before', newText: 'after' }, context(root)))
      .structuredContent
  ).toMatchObject({ retryRequired: true, mutated: false });
  expect(await readFile(join(root, 'edit/data'), 'utf8')).toBe('before');
  await resources.load();
  expect(
    (await edit.execute({ path: 'edit/data', oldText: 'before', newText: 'after' }, context(root)))
      .isError
  ).not.toBe(true);
  expect(
    (await tool(tools, 'read').execute({ path: 'read/data' }, context(root))).structuredContent
  ).toMatchObject({ instructions: expect.stringContaining('read-rule') });
});
it('caps HTTP redirects, chunked responses and rejects initial URLs before requests', async () => {
  let requests = 0;
  const base = await http((req, res) => {
    requests++;
    if (req.url === '/loop') {
      res.writeHead(302, { Location: '/loop' });
      res.end();
    } else {
      res.write('x'.repeat(20));
      res.end('y'.repeat(20));
    }
  });
  const fetch = createWebFetchTool({
    allowUrl: (u) => u.origin === base,
    maxRedirects: 2,
    maxResponseBytes: 32,
  });
  expect((await fetch.execute({ url: 'https://example.invalid' }, context('/'))).isError).toBe(
    true
  );
  expect(requests).toBe(0);
  expect((await fetch.execute({ url: `${base}/loop` }, context('/'))).isError).toBe(true);
  expect(requests).toBe(3);
  expect((await fetch.execute({ url: `${base}/chunked` }, context('/'))).isError).toBe(true);
});
it('bounds search traversal independently of matches and avoids cyclic symlink recursion', async () => {
  const root = await fixture();
  for (let i = 0; i < 8; i++) await writeFile(join(root, `${i}.txt`), 'no match');
  await symlink(root, join(root, 'cycle'));
  const resources = new LocalResources(
    { ancestorDirectories: [root], skillRoots: [] },
    { readRoots: [root], writeRoots: [root] },
    root
  );
  const search = tool(
    createLocalTools({
      resources,
      pathPolicy: { readRoots: [root], writeRoots: [root] },
      workingDirectory: root,
      builder: true,
      maxSearchFiles: 2,
    }),
    'search'
  );
  const result = await search.execute({ path: '.', query: 'absent' }, context(root));
  expect(result.structuredContent).toMatchObject({ filesSearched: 2, truncated: true });
  expect(result.isError).not.toBe(true);
});
it('holds mutations behind a context refresh even when a read already discovered instructions in the same tool batch', async () => {
  const root = await fixture();
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested/AGENTS.md'), 'new-rule');
  await writeFile(join(root, 'nested/data'), 'before');
  const resources = new LocalResources(
    { ancestorDirectories: [root], skillRoots: [] },
    { readRoots: [root], writeRoots: [root] },
    root
  );
  await resources.load();
  const tools = createLocalTools({
    resources,
    pathPolicy: { readRoots: [root], writeRoots: [root] },
    workingDirectory: root,
  });
  await tool(tools, 'read').execute({ path: 'nested/data' }, context(root));
  const write = tool(tools, 'write');
  expect(
    (await write.execute({ path: 'nested/data', content: 'after' }, context(root)))
      .structuredContent
  ).toMatchObject({ retryRequired: true });
  expect(await readFile(join(root, 'nested/data'), 'utf8')).toBe('before');
  await resources.load();
  expect(
    (await write.execute({ path: 'nested/data', content: 'after' }, context(root))).isError
  ).not.toBe(true);
});
it('revalidates a read target after the instruction hook before opening it', async () => {
  const root = await fixture();
  const outside = await fixture();
  await writeFile(join(root, 'data'), 'safe');
  await writeFile(join(outside, 'secret'), 'secret');
  let moved = false;
  const resources = {
    load: async () => '',
    skills: async () => [],
    loadSkill: async () => '',
    beforeFile: async () => {
      if (!moved) {
        moved = true;
        await rm(join(root, 'data'));
        await symlink(join(outside, 'secret'), join(root, 'data'));
      }
      return '';
    },
  };
  const read = tool(
    createLocalTools({
      resources,
      pathPolicy: { readRoots: [root], writeRoots: [root] },
      workingDirectory: root,
    }),
    'read'
  );
  const result = await read.execute({ path: 'data' }, context(root));
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain('secret');
});
it('honors a write-only grant when no readable instructions exist, without granting read access', async () => {
  const root = await fixture();
  const resources = new LocalResources(
    { ancestorDirectories: [root], skillRoots: [] },
    { readRoots: [], writeRoots: [root] },
    root
  );
  const tools = createLocalTools({
    resources,
    pathPolicy: { readRoots: [], writeRoots: [root] },
    workingDirectory: root,
  });
  expect(
    (await tool(tools, 'write').execute({ path: 'new', content: 'allowed' }, context(root))).isError
  ).not.toBe(true);
  expect(await readFile(join(root, 'new'), 'utf8')).toBe('allowed');
  expect((await tool(tools, 'read').execute({ path: 'new' }, context(root))).isError).toBe(true);
});
it('settles cancellation while an asynchronous URL policy is still waiting, without making a request', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not request'));
  const controller = new AbortController();
  const fetch = createWebFetchTool({
    allowUrl: () => new Promise<boolean>(() => {}),
    timeoutMs: 100,
  });
  const pending = fetch.execute(
    { url: 'https://example.invalid' },
    context('/', controller.signal)
  );
  setTimeout(() => controller.abort(), 10);
  const result = await Promise.race([
    pending,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('policy cancellation hung')), 200)
    ),
  ]);
  expect(result.isError).toBe(true);
  expect(spy).not.toHaveBeenCalled();
});
it('normalizes reversed ancestor input to outer-before-inner instruction order', async () => {
  const root = await fixture();
  await mkdir(join(root, 'project'));
  await writeFile(join(root, 'AGENTS.md'), 'OUTER-TEXT');
  await writeFile(join(root, 'project/AGENTS.md'), 'INNER-TEXT');
  const resources = new LocalResources(
    { ancestorDirectories: [join(root, 'project'), root], skillRoots: [] },
    { readRoots: [root], writeRoots: [] },
    root
  );
  const result = await resources.load();
  expect(result.indexOf('OUTER-TEXT')).toBeLessThan(result.indexOf('INNER-TEXT'));
});
it('resolves relative grants against the supplied working directory rather than process cwd', async () => {
  const root = await fixture();
  await mkdir(join(root, 'allowed'));
  const paths = new CanonicalPaths({ readRoots: ['allowed'], writeRoots: ['allowed'] }, root);
  await expect(paths.resolve('allowed/new', 'write')).resolves.toBe(
    join(
      await new CanonicalPaths({ readRoots: [root], writeRoots: [root] }, root).resolve(
        root,
        'read'
      ),
      'allowed/new'
    )
  );
});
it('deduplicates pending search instructions across files in the same nested directory', async () => {
  const root = await fixture();
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested/AGENTS.md'), 'ONLY-ONE-RULE');
  for (const file of ['a', 'b']) await writeFile(join(root, 'nested', file), 'match');
  const resources = new LocalResources(
    { ancestorDirectories: [root], skillRoots: [] },
    { readRoots: [root], writeRoots: [] },
    root
  );
  await resources.load();
  const search = tool(
    createLocalTools({
      resources,
      pathPolicy: { readRoots: [root], writeRoots: [] },
      workingDirectory: root,
      builder: true,
    }),
    'search'
  );
  const result = await search.execute({ path: '.', query: 'match' }, context(root));
  const instructions = (result.structuredContent as { instructions: string }).instructions;
  expect(instructions.split('ONLY-ONE-RULE')).toHaveLength(2);
});
it('refuses oversized instruction results before mutating instead of silently truncating policy', async () => {
  const root = await fixture();
  const resources = {
    load: async () => '',
    skills: async () => [],
    loadSkill: async () => '',
    beforeFile: async () => 'x'.repeat(65),
  };
  const write = tool(
    createLocalTools({
      resources,
      pathPolicy: { readRoots: [root], writeRoots: [root] },
      workingDirectory: root,
      maxInstructionBytes: 64,
    }),
    'write'
  );
  const result = await write.execute({ path: 'new', content: 'data' }, context(root));
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('Instructions exceed byte limit');
  expect(result.structuredContent).toBeUndefined();
  await expect(readFile(join(root, 'new'))).rejects.toThrow();
});
it('refuses lossy edits of invalid UTF-8 files and skips binary files during text search', async () => {
  const root = await fixture();
  const binary = Buffer.from([0xff, 0x61]);
  await writeFile(join(root, 'a.bin'), binary);
  await writeFile(join(root, 'text'), 'find-me');
  const resources = new LocalResources(
    { ancestorDirectories: [root], skillRoots: [] },
    { readRoots: [root], writeRoots: [root] },
    root
  );
  const tools = createLocalTools({
    resources,
    pathPolicy: { readRoots: [root], writeRoots: [root] },
    workingDirectory: root,
    builder: true,
  });
  expect(
    (
      await tool(tools, 'edit').execute(
        { path: 'a.bin', oldText: 'a', newText: 'b' },
        context(root)
      )
    ).isError
  ).toBe(true);
  expect(await readFile(join(root, 'a.bin'))).toEqual(binary);
  const result = await tool(tools, 'search').execute(
    { path: '.', query: 'find-me' },
    context(root)
  );
  expect(result.isError).not.toBe(true);
  expect(JSON.stringify(result.content)).toContain('find-me');
});
it('allows a host to disable redirects with a zero redirect budget', async () => {
  let requests = 0;
  const base = await http((_req, res) => {
    requests++;
    res.writeHead(302, { Location: '/again' });
    res.end();
  });
  const fetch = createWebFetchTool({ allowUrl: (url) => url.origin === base, maxRedirects: 0 });
  expect((await fetch.execute({ url: base }, context('/'))).isError).toBe(true);
  expect(requests).toBe(1);
});
it.skipIf(process.platform === 'win32')(
  'rejects FIFO read/write without blocking and never truncates special files',
  async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { open } = await import('node:fs/promises');
    const { constants } = await import('node:fs');
    const root = await fixture();
    const fifo = join(root, 'fifo');
    await promisify(execFile)('mkfifo', [fifo]);
    const resources = new LocalResources(
      { ancestorDirectories: [root], skillRoots: [] },
      { readRoots: [root], writeRoots: [root] },
      root
    );
    const tools = createLocalTools({
      resources,
      pathPolicy: { readRoots: [root], writeRoots: [root] },
      workingDirectory: root,
    });
    for (const name of ['read', 'write']) {
      const controller = new AbortController();
      const pending = tool(tools, name).execute(
        name === 'read' ? { path: 'fifo' } : { path: 'fifo', content: 'never-write' },
        context(root, controller.signal)
      );
      let unblock: Awaited<ReturnType<typeof open>> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          pending,
          new Promise<never>(
            (_, reject) =>
              (deadline = setTimeout(() => {
                controller.abort();
                reject(new Error('special-file operation blocked'));
              }, 3000))
          ),
        ]);
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toMatch(/regular file/);
      } finally {
        clearTimeout(deadline);
        unblock = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
        await pending;
        await unblock.close();
      }
    }
  }
);
it.skipIf(process.platform === 'win32')(
  'rejects FIFO instruction and skill files without blocking resource discovery',
  async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { open } = await import('node:fs/promises');
    const { constants } = await import('node:fs');
    for (const filename of ['AGENTS.md', 'SKILL.md']) {
      const root = await fixture();
      const fifo = join(root, filename);
      await promisify(execFile)('mkfifo', [fifo]);
      const resources = new LocalResources(
        {
          ancestorDirectories: filename === 'AGENTS.md' ? [root] : [],
          skillRoots: filename === 'SKILL.md' ? [{ path: root }] : [],
        },
        { readRoots: [root], writeRoots: [] },
        root
      );
      const pending = resources.load();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(
          Promise.race([
            pending,
            new Promise<never>(
              (_, reject) =>
                (deadline = setTimeout(
                  () => reject(new Error('resource special-file open blocked')),
                  3000
                ))
            ),
          ])
        ).rejects.toThrow(/regular file/);
      } finally {
        clearTimeout(deadline);
        const unblock = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
        await unblock.writeFile('x');
        await pending.catch(() => {});
        await unblock.close();
      }
    }
  }
);
