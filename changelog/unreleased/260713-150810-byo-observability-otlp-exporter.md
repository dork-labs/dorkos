### Added

- Send DorkOS traces to your own observability stack (DOR-313). Set the standard
  `OTEL_EXPORTER_OTLP_ENDPOINT` and DorkOS ships its session, runtime, relay, and task
  spans to your own Jaeger, Grafana Tempo, Honeycomb, or any OTLP-compatible tool. The
  spans stay sanitized (durations and counts, never prompts, code, or file paths), and
  nothing goes to DorkOS: it is your data going to your tools. `OTEL_SDK_DISABLED=1`
  turns all tracing off. See the new [observability guide](https://dorkos.ai/docs/self-hosting/observability).
