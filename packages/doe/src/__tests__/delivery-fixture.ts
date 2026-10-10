import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
export interface Stage {
  tool?: string;
  args?: unknown;
  text?: string;
}
/** Offline host fixture. Its fetch boundary fails before any unapproved destination is contacted. */
export async function deliveryFixture() {
  const originalFetch = globalThis.fetch;
  const servers: ReturnType<typeof createServer>[] = [];
  const origins = new Set<string>();
  const destinations: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const rpc: string[] = [];
  let explicitMcpCredentialSeen = false;
  const stages: Stage[] = [];
  async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
    const server = createServer((req, res) => {
      void handler(req, res).catch((error) => {
        res.destroy(error);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    origins.add(origin);
    return origin;
  }
  async function body(req: IncomingMessage) {
    let text = '';
    for await (const chunk of req) text += chunk;
    return JSON.parse(text);
  }
  globalThis.fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    if (!origins.has(url.origin)) throw new Error(`Outside fixture destination: ${url.origin}`);
    destinations.push(url.origin);
    return originalFetch(input, init);
  };
  const mcpOrigin = await listen(async (req, res) => {
    if (req.method === 'DELETE') {
      res.end();
      return;
    }
    const request = await body(req);
    explicitMcpCredentialSeen ||= req.headers.authorization === 'Bearer mcp-delivery-secret';
    rpc.push(request.method);
    if (!('id' in request)) {
      res.writeHead(202);
      res.end();
      return;
    }
    let result;
    if (request.method === 'initialize') {
      res.setHeader('mcp-session-id', 'delivery');
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'delivery', version: '1' },
      };
    } else if (request.method === 'tools/list') {
      result = {
        tools: [
          {
            name: 'invoice',
            description: 'invoice status',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      };
    } else if (request.method === 'tools/call') {
      result = {
        content: [{ type: 'text', text: 'Invoice paid' }],
        structuredContent: { paid: true },
      };
    } else throw new Error(`Unexpected RPC: ${request.method}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  const modelOrigin = await listen(async (req, res) => {
    bodies.push(await body(req));
    const stage = stages[bodies.length - 1];
    if (!stage) throw new Error('Unexpected additional model request');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: unknown, finish_reason: string | null = null, usage?: unknown) =>
      res.write(
        `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`
      );
    send({ role: 'assistant' });
    send({ reasoning_content: 'opaque signed history' });
    send({ content: 'activity fixture-delivery-secret ' });
    if (stage.tool)
      send({
        tool_calls: [
          {
            index: 0,
            id: `call_${bodies.length}`,
            type: 'function',
            function: { name: stage.tool, arguments: JSON.stringify(stage.args ?? {}) },
          },
        ],
      });
    else send({ content: stage.text });
    send({}, stage.tool ? 'tool_calls' : 'stop', {
      prompt_tokens: 20,
      completion_tokens: 5,
      total_tokens: 25,
    });
    res.end('data: [DONE]\n\n');
  });
  return {
    bodies,
    rpc,
    credentialReceived: () => explicitMcpCredentialSeen,
    stages,
    destinations,
    origins,
    modelEndpoint: modelOrigin + '/v1',
    mcpEndpoint: mcpOrigin + '/mcp',
    close: async () => {
      globalThis.fetch = originalFetch;
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}
