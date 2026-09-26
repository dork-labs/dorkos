---
id: 260925-004559
title: Templates and marketplace agents are checked before they land in an agent's folder
status: draft
created: 2026-09-25
spec: agent-template-creation
superseded-by: null
---

# 260925-004559. Templates and marketplace agents are checked before they land in an agent's folder

## Status

Draft (auto-extracted from spec: agent-template-creation)

## Context

Creating an agent from a template cloned it straight into the agent's folder, where its sessions run, with no check. The app created marketplace agents that way too, which skipped every package check. Any caller could do it, an agent included.

## Decision

- A marketplace agent is created through the marketplace installer: staged once, validated, held to the disclosure and content hash the person saw, and created from the staged copy.
- A raw template is cloned into a staging folder and inspected there. The inspection covers the same agent-workspace check DOR-2314 applies to packages, plus what its skills run. Only then does it land, through a gate `createAgentWorkspace` requires:
  - a person is shown what a template brings and creates it knowingly;
  - anyone else gets an approval card bound to the template's bytes.

## Consequences

### Positive

- No path creates an agent from a template without someone seeing what it brings.
- Marketplace agents made in the app become real installed packages, so they update.

### Negative

- A marketplace agent lives in its package's folder; the app no longer lets a person pick another folder for one.
- A person's template that brings settings takes one extra step.
- A template's `.git` history no longer lands in the agent's folder.
