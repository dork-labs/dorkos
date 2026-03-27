---
number: 54
title: Invert Feature Flags to Enabled by Default
status: accepted
created: 2026-03-01
spec: first-time-user-experience
superseded-by: null
---

# 54. Invert Feature Flags to Enabled by Default

## Status

Accepted

## Context

DorkOS features (Pulse, Relay, Mesh) are currently disabled by default via runtime feature flags that initialize to `false`. Users must explicitly set environment variables (`DORKOS_PULSE_ENABLED=true`, etc.) or config values to enable core functionality. This creates a barrier where most users never discover the product's key capabilities, since the disabled-by-default pattern requires prior knowledge of what to enable.

The config schema (`UserConfigSchema`) already defaults these features to `enabled: true`, creating a mismatch with the runtime flag factory that defaults to `false`.

## Decision

We will invert the feature flag default from disabled to enabled. The `createFeatureFlag()` factory will initialize with `enabled: true`. Features will be active unless explicitly disabled via `=false` environment variables or `config.*.enabled: false`. The absence of configuration means enabled.

## Consequences

### Positive

- New users immediately see and can use Pulse, Relay, and Mesh without configuration
- Eliminates the runtime/config schema mismatch
- Aligns with the functional onboarding flow that assumes features are available

### Negative

- Existing users who relied on features being off-by-default may see unexpected behavior on upgrade
- Slightly higher resource usage at startup (Relay pub/sub, Mesh registry, Pulse scheduler all initialize)
- Users who want a minimal installation must now explicitly disable features
