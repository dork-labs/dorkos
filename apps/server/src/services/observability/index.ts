/**
 * Local-first OpenTelemetry tracing for the DorkOS server.
 *
 * Off by default: no spans are exported and the OTel SDK is never loaded unless
 * the operator opts in. Two independent modes exist, both the operator's own
 * choice (nothing reaches DorkOS): `dorkos --debug-trace`
 * (`DORKOS_OTEL_DEBUG=true`) writes a sanitized JSONL trace under
 * `<dorkHome>/traces/`, and the standard `OTEL_EXPORTER_OTLP_ENDPOINT` ships
 * spans to the operator's own stack via a batched OTLP/HTTP exporter.
 * `OTEL_SDK_DISABLED` is a universal kill switch. The rest of the server
 * instruments through the helpers re-exported here; all `@opentelemetry/*`
 * imports are confined to this directory.
 *
 * @module services/observability
 */
export {
  initObservability,
  shutdownObservability,
  resolveObservabilityMode,
  isTracingEnabled,
  isOtlpExporting,
  getTraceFilePath,
  startSpan,
  withSpan,
  tracedGenerator,
  type DorkSpan,
  type ObservabilityEnv,
  type ObservabilityMode,
} from './otel.js';
export { traceRuntime } from './trace-runtime.js';
export { traceRelay } from './trace-relay.js';
export { SPAN, ATTR } from './attributes.js';
