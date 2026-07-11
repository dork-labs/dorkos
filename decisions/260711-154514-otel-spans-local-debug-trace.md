---
id: 260711-154514
title: OpenTelemetry spans are off by default and only ever export to a local debug-trace file
status: accepted
created: 2026-07-11
spec: null
superseded-by: null
---

# 260711-154514. OpenTelemetry spans are off by default and only ever export to a local debug-trace file

## Status

Accepted

## Context

The GTM plan (`meta/positioning-202607/09-gtm-plan.md` §3.5) calls for instrumenting the server with OpenTelemetry so beta support has real numbers ("run with `--debug-trace`, send the file"), the fleet-report content engine gets turn latencies and run durations, and future performance work has a foundation. The hard constraints are the product's privacy posture: "nothing phones home" must stay true, spans must never carry prompts or session content, and there must be zero cost on the default path. Dashboards and any remote collector are explicitly post-launch.

DorkOS also just shipped an anonymous, opt-in telemetry consent namespace (`telemetry.*`, DOR-293). A debug trace is a different thing: it is a purely local artifact the operator turns on per invocation and never leaves the machine unless they choose to send the file. Routing it through the anonymous-telemetry consent would both misrepresent it and collide with the error-reporting work landing in parallel.

## Decision

Instrument four seams with the OpenTelemetry SDK, keep the exporter **off by default**, and gate the only exporter — a local file — purely on a CLI flag / env var, disjoint from the `telemetry.*` consent.

1. **Four span seams, instrumented once each, never scattered into business logic.**
   - `session.turn` — the detached interactive turn (`services/session/trigger-turn.ts`).
   - `runtime.send_message` — the AgentRuntime boundary, wrapped in one place (`RuntimeRegistry.register` applies a `traceRuntime` proxy over `sendMessage`), so every caller (interactive, task, embedded, UI action) and every runtime is covered without touching an adapter.
   - `relay.dispatch` — the server's `RelayCore.publish`, wrapped by a `traceRelay` proxy at construction.
   - `task.run` — the scheduler's `executeRun` (`services/tasks/task-scheduler-service.ts`).

2. **Off by default with zero overhead.** When debug tracing is off, `initObservability` returns before importing any OTel SDK module and registers no provider. The seam helpers short-circuit on a single boolean: `withSpan` calls the function directly, `startSpan` returns a shared no-op handle, and the `traceRuntime`/`traceRelay` proxies return the original object untouched. No spans are created, no file is opened, and the `traces/` directory is never made.

3. **The only exporter is a local file.** `dorkos --debug-trace` (or `DORKOS_OTEL_DEBUG=true`) registers a `NodeTracerProvider` whose sole span processor appends sanitized NDJSON to `<dorkHome>/traces/trace-<timestamp>.jsonl`. There is **no OTLP/network exporter, no collector, and no dashboard** — the file never leaves the machine. Writes are synchronous so spans survive a hard crash, which is the whole point of a bug-report artifact.

4. **The attribute allowlist is the no-PII guarantee.** `services/observability/attributes.ts` defines the complete set of permitted attribute keys (`dorkos.*`: runtime type, opaque session/run id, event/delivery counts, coarse enums like task trigger and subject bucket). The file span processor filters every exported span's attributes through this allowlist and additionally drops span events, links, and status messages, and the resource carries only `service.name`/`service.version` (the default resource detectors, which read hostname, username, pid, and command line, are deliberately not used). So even if instrumentation is later changed to set an off-list attribute — a prompt, a path, a token — it has no key to ride on and is dropped at the export seam. A unit test poisons a span with a prompt, a home path, a token, a hostname, and a username and asserts none survive; an end-to-end test streams secrets through a traced generator and asserts only the event count is recorded.

5. **Disjoint from `telemetry.*` consent, and no config field.** The debug trace is an explicit, per-invocation local opt-in, so it does not read or write the anonymous-telemetry consent. It is gated purely on the CLI flag / env var with no config-schema change — avoiding a collision with the error-reporting PR touching config in parallel, and keeping the "local, explicit, never sent" model legible.

6. **OTel imports are confined.** All `@opentelemetry/*` imports live in `services/observability/`, enforced by an ESLint `no-restricted-imports` ban mirroring the existing runtime-SDK confinement. The rest of the server instruments through the observability helpers.

## Consequences

### Positive

- The default path is provably inert: no SDK load, no spans, no file. The privacy claim holds by construction, not by policy.
- Beta support has a real artifact ("send me the trace file") without any server ever receiving data.
- One allowlist, tested, is the single security gate for the no-PII promise; a future contributor cannot leak content by adding a stray attribute.
- The four seams are wrapped at clean boundaries (registry, relay construction, turn orchestrator, task runner), so no span code pollutes runtime adapters or route handlers.

### Negative

- Spans are flat (not a nested trace tree): the file shows each seam's timing independently rather than a parent/child turn→runtime hierarchy. Sufficient for latency/duration debugging; a richer topology can come later if perf work needs it.
- `dorkos.session_id` (an opaque UUID / run id, never content) is recorded to correlate spans within a file. Judged non-identifying and consistent with DOR-293's anonymous `instanceId`; called out here as a deliberate choice.
- Synchronous per-span file appends trade throughput for crash-durability. Acceptable because this only runs in opt-in debug mode.

### Future

- A remote/OTLP exporter, if ever added, must go through the anonymous-telemetry consent (a network send is a different promise than a local file) and is out of scope here.
- Dashboards and the fleet-report aggregation consume the file format but are post-launch.
