---
id: 260903-023414
title: Registering an agent adopts the manifest it finds, and never writes over one
status: accepted
created: 2026-09-03
spec: null
superseded-by: null
amends: null
---

# 260903-023414. Registering an agent adopts the manifest it finds, and never writes over one

## Status

Accepted.

## Context

`POST /api/mesh/agents` minted a fresh ULID and wrote it straight through whatever `.dork/agent.json` the target directory already held; unregistering then deleted that file outright. Mesh registration is file-first write-through (ADR-0043), so both writes land on disk immediately. Pointing either at a repository checkout therefore rewrote, and then destroyed, a file that repository owns — which is exactly what happened to this repo's own committed manifest during DOR-973's browser verification. Only a person reading `git status` got it back.

The seam was inconsistent with every neighbour that had already met this question. `POST /api/agents` refuses a directory that already has a manifest (`409`, "Agent already exists at this path"). `createAgentWorkspace` refuses one that has a `.dork/` at all, telling the person to "use Import instead". `MeshCore.syncFromDisk` — the path both of those use afterwards — adopts the id on disk. Mesh registration was the only door that answered "overwrite", and it was the door labelled Import.

## Decision

We will make registration **adopt**. A directory that already holds a readable `.dork/agent.json` is registered as the agent that manifest describes: the file is not written at all, the id on disk wins, and the caller's `name`/`runtime`/other overrides are ignored rather than merged — merging means writing, and writing is what destroyed the file. Adoption runs through `upsertAutoImported`, the same pipeline a discovery scan uses for a manifest it finds, so the registry row, the Relay endpoint and the duplicate-identity guard (ADR 260801-003050) behave exactly as they do for a scanned-in agent. The guard sits in `@dorkos/mesh`, not in the HTTP route, so the route, the `mesh_register` MCP tool and every internal caller answer identically.

Two states refuse instead of adopting, both naming the file: a manifest that is present but **unreadable** (the same errno discipline `probeManifest` exists for — overwriting it would erase the only copy of what it says), and one naming an id another directory still holds. `name` and `runtime` are consequently required only when there is nothing to adopt, checked in the seam rather than in the type, because the caller re-registering a folder has nothing to name.

We will also stop **unregistration** from deleting a manifest git tracks. Deletion remains the default, and the reason ADR-0043 gives still stands — an unregistered agent whose file survives is adopted again by the next scan, and the reconciler runs one every five minutes. So when the file has to stay, the directory is **denied** instead, which keeps both halves true: the repository is untouched and the agent still does not come back. Registering that directory again clears the denial, and the unregister response reports `blockedFromDiscovery` so a person is told about the second effect rather than discovering it later. `DELETE /api/mesh/agents/:id/data` removes the whole `.dork/` directory outside that path, so it refuses with a `409` rather than half-deleting around the tracked file.

"Tracked" is one `git ls-files --error-unmatch` read as **three** answers, not two: tracked, untracked, and _git could not be asked_. Exit 128 with "not a git repository (or any of the parent directories)" is a definite answer — it is what every agent under `{dorkHome}/agents` gives — while a dubious-ownership refusal, a missing binary or a broken `.git` pointer is not. The last falls back to looking for a `.git` above the directory and keeps the file when there is one, because not knowing must never mean deleting.

## Consequences

### Positive

- A repository's committed agent manifest survives both registration and unregistration. The incident that motivated this is now a test over a real `git init`ed repo, asserting the bytes are identical afterwards.
- Registration is idempotent per directory. Calling it twice — including on a directory the first call wrote — converges on one agent instead of minting a second identity over the first, which is why `mesh_register`'s external MCP annotation moved to `idempotentHint: true`.
- The Import door finally imports, so `createAgentWorkspace`'s "use Import instead" is now advice that works.
- An agent that arrives with a history (a manifest cloned from another machine, or committed for teammates) keeps its identity, its persona and its settings instead of being reborn as a stranger.

### Negative

- The response can differ from the request: a caller who asks to register "verification-agent" may get back "ana". The name is disclosed in the route's OpenAPI description, the MCP tool description and the always-loaded mesh instruction block, because an agent that assumes otherwise would act on an identity it does not have.
- A person who genuinely wants to re-point a directory at a new identity now has to delete or edit the manifest first. That is the intended cost, and the escape hatch is explicit rather than accidental.
- Unregistering an agent whose manifest git tracks leaves a denial behind. It is visible in the denied list with its reason and cleared by re-registering, but it is state a person did not ask for by name.
- The guard shells out to `git` on unregister and on delete-with-data. One process per action on a path a person just clicked, never in a loop, with a 5s timeout — but it is process spawning inside `@dorkos/mesh`, which had none before.
- A `.dork/agent.json` that a person keeps committed _and_ wants deleted on unregister cannot be. The refusal is the default the issue asked for; an explicit override is a follow-up rather than a weakening of it.
