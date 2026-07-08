import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { McpToolDeps } from './types.js';
import { jsonContent, structuredJsonContent } from './types.js';

/** Guard that returns an error response when TraceStore is not available. */
function requireTraceStore(deps: McpToolDeps) {
  if (!deps.traceStore) {
    return jsonContent({ error: 'Relay tracing is not enabled', code: 'TRACING_DISABLED' }, true);
  }
  return null;
}

/** Get the full trace for a message by its ID. */
export function createRelayGetTraceHandler(deps: McpToolDeps) {
  return async (args: { messageId: string }) => {
    const err = requireTraceStore(deps);
    if (err) return err;
    const span = deps.traceStore!.getSpanByMessageId(args.messageId);
    if (!span) {
      return jsonContent({ error: 'Trace not found', messageId: args.messageId }, true);
    }
    const spans = deps.traceStore!.getTrace(span.traceId);
    return jsonContent({ traceId: span.traceId, spans });
  };
}

/** Get aggregate delivery metrics from the TraceStore. */
export function createRelayGetMetricsHandler(deps: McpToolDeps) {
  return async () => {
    const err = requireTraceStore(deps);
    if (err) return err;
    const metrics = deps.traceStore!.getMetrics();
    return structuredJsonContent(metrics);
  };
}

/** Returns the trace tool definitions — only when traceStore is provided. */
export function getTraceTools(deps: McpToolDeps) {
  if (!deps.traceStore) return [];

  return [
    tool(
      'relay_get_trace',
      'Get the full delivery trace for a Relay message. Returns all spans in the trace chain.',
      { messageId: z.string().describe('Message ID to look up the trace for') },
      createRelayGetTraceHandler(deps)
    ),
    tool(
      'relay_get_metrics',
      'Get aggregate delivery metrics for the Relay message bus. Includes counts, latency stats, and budget rejections.',
      {},
      createRelayGetMetricsHandler(deps)
    ),
  ];
}
