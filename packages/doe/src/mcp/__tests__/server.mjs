import process from 'node:process';
import console from 'node:console';
import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const m = JSON.parse(line);
  if (!('id' in m)) return;
  if (process.env.MODE === 'connect_hang' && m.method === 'initialize') return;
  let result;
  if (m.method === 'initialize')
    result = {
      protocolVersion: m.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1' },
    };
  if (m.method === 'tools/list')
    result = m.params?.cursor
      ? { tools: [{ name: 'env', description: 'environment', inputSchema: { type: 'object' } }] }
      : {
          tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
          nextCursor: 'two',
        };
  if (m.method === 'tools/call') {
    if (m.params._meta?.progressToken !== undefined)
      console.log(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: {
            progressToken: m.params._meta.progressToken,
            progress: 1,
            total: 2,
            message: 'working',
          },
        })
      );
    if (m.params.arguments?.mode === 'hang') return;
    if (m.params.arguments?.mode === 'error') {
      console.log(
        JSON.stringify({
          jsonrpc: '2.0',
          id: m.id,
          error: { code: -32603, message: 'fixture error' },
        })
      );
      return;
    }
    result =
      m.params.name === 'env'
        ? { content: [{ type: 'text', text: JSON.stringify(process.env) }] }
        : {
            content: [
              { type: 'text', text: 'hello' },
              { type: 'image', data: 'YWJj', mimeType: 'image/png' },
            ],
            structuredContent: { ok: true },
            isError: m.params.arguments?.mode === 'tool_error',
          };
  }
  console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
});
