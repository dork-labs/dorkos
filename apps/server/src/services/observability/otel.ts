/**
 * OpenTelemetry tracing for the DorkOS server — local-first and off by default.
 *
 * Spans mark the paths that matter (session turns, runtime calls, relay
 * dispatch, task runs) with durations, counts, opaque ids, and coarse enums.
 * By default NOTHING is exported: no tracer provider is registered, so the
 * seam helpers here short-circuit on a single boolean and the OpenTelemetry
 * SDK is never even imported.
 *
 * Two independent activation modes exist, both opt-in and both the operator's
 * own choice (nothing here ever reaches DorkOS):
 *
 * - **File (debug)**: `dorkos --debug-trace` (or `DORKOS_OTEL_DEBUG=true`)
 *   registers a {@link FileSpanProcessor} writing a sanitized JSONL trace under
 *   `<dorkHome>/traces/`. The file never leaves the machine unless the user
 *   sends it. See ADR 260711-* and the `--debug-trace` flag in `packages/cli`.
 * - **OTLP (bring-your-own observability)**: setting the standard
 *   `OTEL_EXPORTER_OTLP_ENDPOINT` registers a batched OTLP/HTTP trace exporter,
 *   so the operator pipes spans into their own stack (Jaeger, Tempo, Honeycomb,
 *   ...). The exporter reads the standard `OTEL_EXPORTER_OTLP_*` vars natively.
 *   See ADR 260713-143958 (Plane 2) and `docs/self-hosting/observability.mdx`.
 *
 * Both may run at once (debug→file, endpoint→OTLP, both→both). The universal
 * `OTEL_SDK_DISABLED` kill switch overrides everything and keeps tracing off.
 *
 * All `@opentelemetry/*` imports are confined to this directory (an ESLint
 * confinement rule mirroring the runtime-SDK ban's posture); the rest of the
 * server instruments through the helpers exported here.
 *
 * @module services/observability/otel
 */
import path from 'path';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { Attributes, AttributeValue } from '@opentelemetry/api';
import type { NodeTracerProvider, SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { env } from '../../env.js';
import { ATTR } from './attributes.js';

const TRACER_NAME = 'dorkos-server';
const SERVICE_NAME = 'dorkos-server';

/** Whether a real tracer provider is registered (either mode active). */
let enabled = false;
/** Whether the OTLP exporter is part of the active pipeline. */
let otlpExporting = false;
/** The registered provider, kept for graceful shutdown. */
let provider: NodeTracerProvider | undefined;
/** Absolute path of the active trace file, or undefined when file mode is off. */
let traceFilePath: string | undefined;

/** The subset of env `resolveObservabilityMode` reads. */
export interface ObservabilityEnv {
  /** Standard OTLP endpoint. When set (and not disabled), OTLP export turns on. */
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  /** Universal OTel kill switch. When truthy, ALL tracing stays off. */
  OTEL_SDK_DISABLED?: string;
}

/** Which export pipelines a given config activates. */
export interface ObservabilityMode {
  /** Write the sanitized local JSONL trace file (the `--debug-trace` deliverable). */
  file: boolean;
  /** Ship spans to the operator's OTLP endpoint. */
  otlp: boolean;
  /** The kill switch is engaged — nothing is registered regardless of the above. */
  disabled: boolean;
}

/**
 * Interpret a standard OTel boolean env var. The spec only blesses `'true'`, but
 * operators reach for `1`/`yes`/`on` too, so we accept those forms
 * (case-insensitive, trimmed). Anything else — including unset — is false.
 */
function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/**
 * Decide which export pipelines to activate from env + the debug flag. Pure and
 * side-effect-free so every combination is unit-testable.
 *
 * `OTEL_SDK_DISABLED` wins over everything: when truthy, the result is fully off
 * even if the debug flag is on or an OTLP endpoint is set. Otherwise the two
 * modes are independent — the debug flag drives the file, the OTLP endpoint
 * drives the exporter, and both can be on at once.
 *
 * @param observabilityEnv - The OTLP endpoint and kill-switch env values.
 * @param debugFlag - Whether `--debug-trace` / `DORKOS_OTEL_DEBUG` is set.
 * @returns The resolved {@link ObservabilityMode}.
 */
export function resolveObservabilityMode(
  observabilityEnv: ObservabilityEnv,
  debugFlag: boolean
): ObservabilityMode {
  if (isEnvTruthy(observabilityEnv.OTEL_SDK_DISABLED)) {
    return { file: false, otlp: false, disabled: true };
  }
  return {
    file: debugFlag,
    otlp: Boolean(observabilityEnv.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()),
    disabled: false,
  };
}

/**
 * Whether any tracer provider is registered (file or OTLP). Seam helpers check
 * this first so the off-path is a single branch with zero span cost.
 */
export function isTracingEnabled(): boolean {
  return enabled;
}

/** Whether spans are being shipped to an OTLP endpoint (bring-your-own mode). */
export function isOtlpExporting(): boolean {
  return otlpExporting;
}

/** The absolute path of the active trace file, or undefined when file mode is off. */
export function getTraceFilePath(): string | undefined {
  return traceFilePath;
}

/**
 * Initialize observability. A no-op in the default (off) case — no provider is
 * registered, no SDK module is loaded, and no file is created. Activation is
 * resolved from the standard OTel env vars plus the `debug` flag by
 * {@link resolveObservabilityMode}: `debug` writes a sanitized JSONL trace under
 * `<dorkHome>/traces/`, an `OTEL_EXPORTER_OTLP_ENDPOINT` registers a batched
 * OTLP/HTTP exporter, and `OTEL_SDK_DISABLED` keeps everything off. The two
 * modes are independent and may both be on.
 *
 * The OTLP exporter reads the standard `OTEL_EXPORTER_OTLP_*` env vars natively
 * (endpoint, headers, timeout); DorkOS does not re-plumb them. The resource
 * carries only `service.name`/`service.version` — the default resource detectors
 * (which read hostname, username, pid, and command line) are deliberately NOT
 * used, so no host identity rides along. `OTEL_SERVICE_NAME` overrides the
 * default `service.name` ('dorkos-server').
 *
 * @param opts - `debug` gate, resolved `dorkHome`, and the server `version`.
 * @returns The trace file path when file mode is on, otherwise undefined.
 */
export async function initObservability(opts: {
  debug: boolean;
  dorkHome: string;
  version: string;
}): Promise<string | undefined> {
  if (enabled) return traceFilePath;

  const mode = resolveObservabilityMode(env, opts.debug);
  if (mode.disabled || (!mode.file && !mode.otlp)) return traceFilePath;

  const { NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');
  const { resourceFromAttributes } = await import('@opentelemetry/resources');

  const spanProcessors: SpanProcessor[] = [];

  if (mode.file) {
    const { FileSpanProcessor } = await import('./file-span-processor.js');
    const { mkdirSync } = await import('fs');
    const dir = path.join(opts.dorkHome, 'traces');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    traceFilePath = path.join(dir, `trace-${stamp}.jsonl`);
    spanProcessors.push(new FileSpanProcessor(traceFilePath));
  }

  if (mode.otlp) {
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-node');
    // No-arg constructor: endpoint/headers/timeout come from the standard
    // OTEL_EXPORTER_OTLP_* env vars the exporter reads on its own.
    spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
    otlpExporting = true;
  }

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': env.OTEL_SERVICE_NAME?.trim() || SERVICE_NAME,
      'service.version': opts.version,
    }),
    spanProcessors,
  });
  provider.register();
  enabled = true;
  return traceFilePath;
}

/**
 * Flush and tear down the tracer provider, flushing both the file and OTLP
 * processors. Safe to call when tracing is off.
 */
export async function shutdownObservability(): Promise<void> {
  if (!provider) return;
  await provider.shutdown();
  // Clear the global provider registration so a later init (e.g. across tests)
  // registers cleanly and getTracer falls back to the no-op provider.
  trace.disable();
  provider = undefined;
  enabled = false;
  otlpExporting = false;
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
