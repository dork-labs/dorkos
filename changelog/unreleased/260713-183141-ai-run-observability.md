### Added

- See AI run details in your own traces (DOR-319). When tracing is on, every agent turn's
  span now carries standard OpenTelemetry `gen_ai.*` metadata: which model ran, the token
  counts, and the cost. Any tool that reads LLM traces picks it up automatically, and it
  stays your data going to your own tools. See the
  [observability guide](https://dorkos.ai/docs/self-hosting/observability).
- New opt-in setting to share AI run metadata with DorkOS (DOR-319). Turn on **Share AI run
  metadata** in the Privacy & Data tab (off by default) and DorkOS sends a small summary of
  each agent turn: the model, the runtime, token counts, timing, and cost. Never your
  prompts, your code, or your conversations. See the
  [telemetry page](https://dorkos.ai/docs/self-hosting/telemetry).
