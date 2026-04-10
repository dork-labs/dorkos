---
number: 242
title: Universal Model Capability Schema for Multi-Runtime Future
status: draft
created: 2026-04-10
spec: runtime-model-discovery
superseded-by: null
---

# 0242. Universal Model Capability Schema for Multi-Runtime Future

## Status

Draft (auto-extracted from spec: runtime-model-discovery)

## Context

DorkOS currently supports only the Claude Code runtime, but the architecture is designed for multiple runtimes. The `ModelOption` type only captures 5 fields from the Claude Agent SDK, discarding `supportsAdaptiveThinking`, `supportsFastMode`, and `supportsAutoMode`. Research across 8 providers (Anthropic, OpenAI, Gemini, DeepSeek, Mistral, xAI, OpenRouter, LiteLLM) revealed a common set of capabilities that all model selectors need. The current schema needs to expand without breaking existing code.

## Decision

Expand `ModelOptionSchema` with optional fields covering: reasoning capabilities (effort levels as a superset enum across providers), speed variants, context window, provider metadata, capability flags, and lifecycle indicators. All new fields are optional — the current schema is a strict subset. The effort level enum expands from `low|medium|high|max` to `none|minimal|low|medium|high|max|xhigh` to cover all surveyed providers. Provider-specific extensions are deferred to a future spec.

## Consequences

### Positive

- Full SDK passthrough — no model metadata is discarded
- Schema is ready for OpenAI, Gemini, and other runtimes without breaking changes
- Research-backed design — informed by real-world schemas from OpenRouter, LiteLLM, and 6 providers
- Backward compatible — existing code referencing `ModelOption` continues to work unchanged

### Negative

- Many optional fields may feel over-designed for a single-runtime system
- The superset effort enum includes values (`none`, `minimal`, `xhigh`) that Claude doesn't use
- Provider-specific capability extensions are deferred, so the schema is "universal" in theory but Claude-only in practice for now
