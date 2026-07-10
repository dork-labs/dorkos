---
id: 260708-185522
title: First-party mime→viewer registry with config-choosable defaults; third-party viewers route to MCP Apps
status: accepted
created: 2026-07-08
spec: right-panel-workbench
superseded-by: null
---

# 260708-185522. First-party mime→viewer registry with config-choosable defaults; third-party viewers route to MCP Apps

## Status

Accepted

## Context

v1 of the workbench ships six first-party viewers (text/code, image, PDF, 3D, CSV, markdown) plus a browser and a terminal. The spec needs an extensibility seam for choosing which viewer opens a given file type, without introducing a second, unsandboxed extension-loading mechanism alongside the existing client-extension loader.

## Decision

Resolve viewers via a mime/extension → canvas-content-type registry (in `packages/shared` or a `workbench` feature), with a `workbench.defaultViewers` config field that lets the default mapping be overridden (Zod schema + semver migration, per the `adding-config-fields` skill). Third-party viewer extensibility is not built on the current unsandboxed client-extension loader; it routes instead to MCP Apps (Tier 2, per ADR 260708-111459), which already renders sandboxed third-party UI in the canvas' fullscreen surface. Terminal and browser stay first-party only in v1 and are not third-party-swappable (spec D7).

## Consequences

### Positive

- One config surface (`workbench.defaultViewers`) covers "open CSVs in a different viewer" without touching code, and it's resolved through the same registry that dispatches the agent's `open_file` action.
- Third-party rich viewers get the already-sandboxed MCP Apps path instead of a second, unsandboxed extension mechanism — no new attack surface for marketplace-installed viewers.

### Negative

- A third-party package cannot yet override which viewer opens for a given mime/extension — it can only offer an MCP App the user opens explicitly, not silently take over a file type.
- Terminal and browser stay fixed implementations in v1, deferring any request for alternate implementations (e.g., a different terminal emulator) past v1.
