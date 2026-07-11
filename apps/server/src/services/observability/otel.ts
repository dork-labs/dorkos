/**
 * OpenTelemetry tracing for the DorkOS server — local-first and off by default.
 *
 * Spans mark the paths that matter (session turns, runtime calls, relay
 * dispatch, task runs) with durations, counts, opaque ids, and coarse enums.
 * By default NOTHING is exported: no tracer provider is registered, so the
 * seam helpers here short-circuit on a single boolean and the OpenTelemetry
 * SDK is never even imported. Tracing only turns on when the operator opts in
 * with `dorkos --debug-trace` (or `DORKOS_OTEL_DEBUG=true`), which registers a
 * {@link FileSpanProcessor} writing a sanitized JSONL trace under
 * `<dorkHome>/traces/`. There is no network or OTLP exporter — the file never
 * leaves the machine unless the user sends it. See ADR 260711-* and the
 * `--debug-trace` flag in `packages/cli`.
 *
 * All `@opentelemetry/*` imports are confined to this directory (ESLint Hard
 * Rule #2 mirror); the rest of the server instruments through the helpers
 * exported here.
 *
 * @module services/observability/otel
 */
import path from 'path';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { Attributes, AttributeValue } from '@opentelemetry/api';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR } from './attributes.js';

const TRACER_NAME = 'dorkos-server';
const SERVICE_NAME = 'dorkos-server';

/** Whether a real tracer provider is registered (i.e. debug tracing is on). */
let enabled = false;
/** The registered provider, kept for graceful shutdown. */
let provider: NodeTracerProvider | undefined;
/** Absolute path of the active trace file, or undefined when off. */
let traceFilePath: string | undefined;

/**
 * Whether debug tracing is active. Seam helpers check this first so the
 * off-path is a single branch with zero span or file cost.
 */
export function isTracingEnabled(): boolean {
  return enabled;
}

/** The absolute path of the active trace file, or undefined when tracing is off. */
export function getTraceFilePath(): string | undefined {
  return traceFilePath;
}

/**
 * Initialize observability. A no-op unless `debug` is true — in the default
 * (off) case no provider is registered, no SDK module is loaded, and no file is
 * created. When on, registers a Node tracer provider whose only processor
 * appends sanitized spans to `<dorkHome>/traces/trace-<timestamp>.jsonl`.
 *
 * The resource carries only `service.name`/`service.version` — the default
 * resource detectors (which read hostname, username, pid, and command line)
 * are deliberately NOT used, so no host identity reaches the trace file.
 *
 * @param opts - `debug` gate, resolved `dorkHome`, and the server `version`.
 * @returns The trace file path when enabled, otherwise undefined.
 */
export async function initObservability(opts: {
  debug: boolean;
  dorkHome: string;
  version: string;
}): Promise<string | undefined> {
  if (!opts.debug || enabled) return traceFilePath;

  const { NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');
  const { resourceFromAttributes } = await import('@opentelemetry/resources');
  const { FileSpanProcessor } = await import('./file-span-processor.js');
  const { mkdirSync } = await import('fs');

  const dir = path.join(opts.dorkHome, 'traces');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  traceFilePath = path.join(dir, `trace-${stamp}.jsonl`);

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': SERVICE_NAME,
      'service.version': opts.version,
    }),
    spanProcessors: [new FileSpanProcessor(traceFilePath)],
  });
  provider.register();
  enabled = true;
  return traceFilePath;
}

/**
 * Flush and tear down the tracer provider. Safe to call when tracing is off.
 */
export async function shutdownObservability(): Promise<void> {
  if (!provider) return;
  await provider.shutdown();
  // Clear the global provider registration so a later init (e.g. across tests)
  // registers cleanly and getTracer falls back to the no-op provider.
  trace.disable();
  provider = undefined;
  enabled = false;
  traceFilePath = undefined;
}

/**
 * A minimal span handle. When tracing is off, {@link startSpan} returns a shared
 * no-op instance so callers pay nothing beyond the calls themselves.
 */
export interface DorkSpan {
  /** Set one allowlisted attribute (ignored when tracing is off). */
  setAttr(key: string, value: AttributeValue): void;
  /** Mark the span as failed (records an error status, never an error message). */
  markError(): void;
  /** End the span. */
  end(): void;
}

const NOOP_SPAN: DorkSpan = {
  setAttr() {
    /* no-op */
  },
  markError() {
    /* no-op */
  },
  end() {
    /* no-op */
  },
};

/**
 * Start a span at an instrumented seam. Returns a no-op handle when tracing is
 * off — the caller does not branch. Only allowlisted, non-content attributes
 * should ever be passed.
 *
 * @param name - A stable span name from `SPAN`.
 * @param attributes - Allowlisted attributes to seed the span with.
 */
export function startSpan(name: string, attributes?: Attributes): DorkSpan {
  if (!enabled) return NOOP_SPAN;
  const span = trace
    .getTracer(TRACER_NAME)
    .startSpan(name, attributes ? { attributes } : undefined);
  return {
    setAttr(key, value) {
      span.setAttribute(key, value);
    },
    markError() {
      // Status code only — an error message could carry PII, so it is omitted.
      span.setStatus({ code: SpanStatusCode.ERROR });
    },
    end() {
      span.end();
    },
  };
}

/**
 * Run an async operation inside a span, ending it on completion and marking it
 * failed (status only) on throw. Off-path is a direct call to `fn` with a no-op
 * span, so there is no measurable overhead when tracing is disabled.
 *
 * @param name - A stable span name from `SPAN`.
 * @param attributes - Allowlisted attributes to seed the span with.
 * @param fn - The operation; receives the span so it can add allowlisted attrs.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: DorkSpan) => Promise<T>
): Promise<T> {
  if (!enabled) return fn(NOOP_SPAN);
  const span = startSpan(name, attributes);
  try {
    return await fn(span);
  } catch (err) {
    span.markError();
    throw err;
  } finally {
    span.end();
  }
}

/**
 * Wrap an async generator in a span that counts yielded items and records the
 * count (as `dorkos.event_count`) when the generator settles. Used at the
 * runtime `sendMessage` seam, whose turn is a stream of events. Only invoked
 * when tracing is enabled (the runtime proxy guards it), but stays correct if
 * called while off.
 *
 * @param name - A stable span name from `SPAN`.
 * @param attributes - Allowlisted attributes to seed the span with.
 * @param source - The generator to observe; items pass through untouched.
 */
export async function* tracedGenerator<T>(
  name: string,
  attributes: Attributes,
  source: AsyncGenerator<T>
): AsyncGenerator<T> {
  const span = startSpan(name, attributes);
  let count = 0;
  try {
    for await (const item of source) {
      count++;
      yield item;
    }
  } catch (err) {
    span.markError();
    throw err;
  } finally {
    span.setAttr(ATTR.EVENT_COUNT, count);
    span.end();
  }
}
