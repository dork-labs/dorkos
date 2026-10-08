import { createServer } from 'node:http';
import type { ModelDescriptor } from '../contracts.js';
/** Local wire server uses actual SDK protocols without a vendor or credentials. */
export async function protocolFixture(
  protocol: ModelDescriptor['protocol'],
  options: {
    tool?: string;
    toolArguments?: Record<string, unknown>;
    textChunks?: string[];
    thinkingChunks?: string[];
    usage?: boolean;
    status?: number;
    statuses?: number[];
    holdFirst?: boolean;
    errorMessage?: string;
    thinking?: boolean;
    hang?: boolean;
    afterTextError?: boolean;
  } = {}
) {
  const bodies: Record<string, unknown>[] = [];
  const paths: string[] = [];
  let requests = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer(async (req, res) => {
    requests++;
    paths.push(req.url ?? '');
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    bodies.push(parsed);
    if (options.holdFirst && requests === 1) await held;
    if (options.hang) return;
    const status = options.statuses?.[requests - 1] ?? options.status;
    if (status && status !== 200) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message:
              options.errorMessage ??
              (status === 429
                ? 'quota exhausted'
                : status === 401
                  ? 'authentication failed'
                  : 'transient unavailable'),
            type: status === 401 ? 'authentication_error' : 'server_error',
          },
        })
      );
      return;
    }
    const tool = options.tool && requests === 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event: Record<string, unknown>) =>
      res.write(
        `${protocol === 'anthropic-messages' ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`
      );
    if (protocol === 'openai-completions') {
      const chunk = (
        delta: Record<string, unknown>,
        finish_reason: string | null = null,
        usage?: Record<string, number>
      ) =>
        send({
          id: 'completion',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'local',
          choices: [{ index: 0, delta, finish_reason }],
          ...(usage ? { usage } : {}),
        });
      chunk({ role: 'assistant' });
      if (options.thinking || options.thinkingChunks)
        for (const reasoning_content of options.thinkingChunks ?? ['reason'])
          chunk({ reasoning_content });
      if (tool)
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call1',
              type: 'function',
              function: {
                name: options.tool,
                arguments: JSON.stringify(options.toolArguments ?? {}),
              },
            },
          ],
        });
      else for (const content of options.textChunks ?? ['hello']) chunk({ content });
      if (options.afterTextError) {
        setTimeout(() => res.destroy(), 20);
        return;
      }
      chunk(
        {},
        tool ? 'tool_calls' : 'stop',
        options.usage === false
          ? undefined
          : { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }
      );
      res.end('data: [DONE]\n\n');
    } else if (protocol === 'anthropic-messages') {
      send({
        type: 'message_start',
        message: {
          id: 'message',
          type: 'message',
          role: 'assistant',
          model: 'local',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          ...(options.usage === false ? {} : { usage: { input_tokens: 12, output_tokens: 0 } }),
        },
      });
      let index = 0;
      if (options.thinking) {
        send({
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        });
        send({
          type: 'content_block_delta',
          index,
          delta: { type: 'thinking_delta', thinking: 'reason' },
        });
        send({
          type: 'content_block_delta',
          index,
          delta: { type: 'signature_delta', signature: 'opaque-signature' },
        });
        send({ type: 'content_block_stop', index });
        index++;
      }
      if (tool) {
        send({
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: 'call1', name: options.tool, input: {} },
        });
        send({
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(options.toolArguments ?? {}),
          },
        });
      } else {
        send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        for (const text of options.textChunks ?? ['hello'])
          send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
      }
      send({ type: 'content_block_stop', index });
      send({
        type: 'message_delta',
        delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
        ...(options.usage === false ? {} : { usage: { output_tokens: 3 } }),
      });
      send({ type: 'message_stop' });
      res.end();
    } else {
      const response = {
        id: 'response',
        object: 'response',
        created_at: 1,
        status: 'in_progress',
        model: 'local',
        output: [],
      };
      send({ type: 'response.created', response });
      let index = 0;
      if (options.thinking) {
        const item = {
          type: 'reasoning',
          id: 'reason1',
          summary: [],
          encrypted_content: 'opaque-encrypted',
        };
        send({ type: 'response.output_item.added', output_index: index, item });
        send({
          type: 'response.reasoning_summary_text.delta',
          item_id: 'reason1',
          output_index: index,
          summary_index: 0,
          delta: 'reason',
        });
        send({
          type: 'response.output_item.done',
          output_index: index,
          item: { ...item, summary: [{ type: 'summary_text', text: 'reason' }] },
        });
        index++;
      }
      if (tool) {
        const item = {
          type: 'function_call',
          id: 'fc1',
          call_id: 'call1',
          name: options.tool,
          arguments: '',
        };
        send({ type: 'response.output_item.added', output_index: index, item });
        send({
          type: 'response.function_call_arguments.delta',
          item_id: 'fc1',
          output_index: index,
          delta: '{}',
        });
        send({
          type: 'response.output_item.done',
          output_index: index,
          item: { ...item, arguments: JSON.stringify(options.toolArguments ?? {}) },
        });
      } else {
        const item = { type: 'message', id: 'out1', role: 'assistant', content: [] };
        send({ type: 'response.output_item.added', output_index: index, item });
        send({
          type: 'response.content_part.added',
          item_id: 'out1',
          output_index: index,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
        for (const delta of options.textChunks ?? ['hello'])
          send({
            type: 'response.output_text.delta',
            item_id: 'out1',
            output_index: index,
            content_index: 0,
            delta,
          });
        send({
          type: 'response.output_item.done',
          output_index: index,
          item: {
            ...item,
            content: [
              {
                type: 'output_text',
                text: (options.textChunks ?? ['hello']).join(''),
                annotations: [],
              },
            ],
          },
        });
      }
      send({
        type: 'response.completed',
        response: {
          ...response,
          status: 'completed',
          ...(options.usage === false
            ? {}
            : {
                usage: {
                  input_tokens: 12,
                  output_tokens: 3,
                  total_tokens: 15,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 1 },
                },
              }),
        },
      });
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    bodies,
    paths,
    release,
    requests: () => requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
