/**
 * A local-only OpenTelemetry span processor that appends sanitized spans to a
 * newline-delimited JSON file — the `--debug-trace` deliverable a beta user can
 * send when reporting a bug ("run with `--debug-trace`, send me the file").
 *
 * This is the ONLY place spans reach disk, and it is the enforcement point for
 * the no-PII contract: {@link sanitizeSpan} keeps a fixed shape (name, ids,
 * timing, status code) and filters attributes through the
 * {@link ALLOWED_ATTRIBUTE_KEYS} allowlist. Span events, links, status
 * messages, and any off-allowlist attribute are dropped, so a trace file can
 * never carry prompts, paths, tokens, or session content. There is no network
 * or remote exporter by design (ADR 260711-*): the file never leaves the
 * machine unless the user sends it.
 *
 * @module services/observability/file-span-processor
 */
import fs from 'fs';
import type { Context, HrTime } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { ALLOWED_ATTRIBUTE_KEYS } from './attributes.js';

const NANOS_PER_MS = 1_000_000;
const MS_PER_SECOND = 1_000;

/** The sanitized, on-disk shape of a single span. Deliberately PII-free. */
interface SanitizedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startedAt: string;
  durationMs: number;
  status: 'unset' | 'ok' | 'error';
  attributes: Record<string, string | number | boolean>;
}

/** Convert an OTel {@link HrTime} (`[seconds, nanos]`) to whole milliseconds. */
function hrTimeToMs(time: HrTime): number {
  return time[0] * MS_PER_SECOND + Math.round(time[1] / NANOS_PER_MS);
}

/** Map an OTel status code (0 unset, 1 ok, 2 error) to a stable name. */
function statusName(code: number): SanitizedSpan['status'] {
  if (code === 1) return 'ok';
  if (code === 2) return 'error';
  return 'unset';
}

/**
 * Reduce a span to its PII-free projection: static name, opaque ids, timing,
 * status code, and only allowlisted primitive attributes. Anything not on the
 * allowlist — and every span event, link, and status message — is discarded.
 *
 * @param span - The completed span to project.
 * @returns The sanitized record written to the trace file.
 */
export function sanitizeSpan(span: ReadableSpan): SanitizedSpan {
  const ctx = span.spanContext();
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    if (!ALLOWED_ATTRIBUTE_KEYS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attributes[key] = value;
    }
  }
  return {
    name: span.name,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    startedAt: new Date(hrTimeToMs(span.startTime)).toISOString(),
    durationMs: hrTimeToMs(span.duration),
    status: statusName(span.status.code),
    attributes,
  };
}

/**
 * A {@link SpanProcessor} that appends each finished span to a local JSONL file.
 * Writes are synchronous so a span survives even a hard crash right after it
 * ends — the trace file is a debugging artifact, and durability beats
 * throughput in the opt-in debug mode this only ever runs in.
 */
export class FileSpanProcessor implements SpanProcessor {
  constructor(private readonly filePath: string) {}

  /** No-op: spans are recorded on end, not start. */
  onStart(_span: Span, _parentContext: Context): void {
    // intentionally empty
  }

  /** Append the sanitized span as one JSONL line. */
  onEnd(span: ReadableSpan): void {
    fs.appendFileSync(this.filePath, `${JSON.stringify(sanitizeSpan(span))}\n`);
  }

  /** Nothing is buffered — synchronous appends flush on each span. */
  async forceFlush(): Promise<void> {
    // intentionally empty
  }

  /** Nothing to release — the file is opened per append. */
  async shutdown(): Promise<void> {
    // intentionally empty
  }
}
