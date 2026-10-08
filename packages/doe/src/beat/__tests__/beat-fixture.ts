import { createServer } from 'node:http';
/** Offline OpenAI-compatible stream with explicit tool batches and counted requests. */
export async function beatFixture(batches: readonly { name: string; args: unknown }[][]) {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let input = '';
    for await (const chunk of req) input += chunk;
    bodies.push(JSON.parse(input));
    const calls = batches[bodies.length - 1] ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish_reason: string | null = null, usage?: unknown) =>
      res.write(
        `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`
      );
    chunk({ role: 'assistant' });
    chunk({ reasoning_content: 'opaque thinking' });
    chunk({ content: 'beat activity' });
    for (const [index, call] of calls.entries())
      chunk({
        tool_calls: [
          {
            index,
            id: `call${bodies.length}_${index}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      });
    chunk({}, calls.length ? 'tool_calls' : 'stop', {
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
    });
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
