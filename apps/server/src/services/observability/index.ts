/**
 * Local-first OpenTelemetry tracing for the DorkOS server.
 *
 * Off by default: no spans are exported and the OTel SDK is never loaded unless
 * the operator opts in with `dorkos --debug-trace` (or `DORKOS_OTEL_DEBUG=true`),
 * which writes a sanitized JSONL trace under `<dorkHome>/traces/`. There is no
 * network or OTLP exporter. The rest of the server instruments through the
 * helpers re-exported here; all `@opentelemetry/*` imports are confined to this
 * directory.
 *
 * @module services/observability
 */
export {
  initObservability,
  shutdownObservability,
  isTracingEnabled,
  getTraceFilePath,
  startSpan,
  withSpan,
  tracedGenerator,
  type DorkSpan,
} from './otel.js';
export { traceRuntime } from './trace-runtime.js';
export { traceRelay } from './trace-relay.js';
export { SPAN, ATTR } from './attributes.js';
