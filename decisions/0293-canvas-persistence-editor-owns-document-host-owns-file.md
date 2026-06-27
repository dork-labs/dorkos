---
number: 293
title: 'Canvas Persistence: the Editor Owns the Document, the Host Owns the File'
status: accepted
created: 2026-06-26
spec: canvas-markdown-editing
superseded-by: null
---

# 293. Canvas Persistence: the Editor Owns the Document, the Host Owns the File

## Status

Accepted (extracted from spec: canvas-markdown-editing)

## Context

The canvas was a one-way display: the agent authored a snapshot that rendered read-only,
and any user edit lived only in client state (Zustand plus localStorage). It never reached
disk, so when the agent re-read the file it saw the original bytes (a silent split-brain).
Making the canvas editable (ADR-0290) forces a question the original design left unanswered:
who writes the file, and how do the editor and the on-disk file stay in sync without lying
to the user about what is saved? Concretely, should the editor library (Blintz) own disk
I/O and change detection, or should the host (DorkOS) own them?

## Decision

The editor owns the document; the host owns the file. Blintz stays pure: it renders and
round-trips markdown and offers a read-only/editable mode (ADR-0291), and never touches
disk, change detection, or persistence. DorkOS owns everything about the file:

- **Provenance.** A `sourcePath` on the markdown canvas variant marks a document as
  file-backed (editable and savable) versus generated or path-less (read-only, so the
  pencil never lies). The agent supplies it through the `control_ui` tool.
- **File I/O.** `PUT /api/files/content` writes within the session working directory
  (`validateBoundary`), requires the file to already exist (404 otherwise, so a save can
  never silently create a file), and guards every write with SHA-256 optimistic
  concurrency (409 plus the current bytes on mismatch). The write itself is atomic
  (temp file plus rename).
- **Transport seam.** `writeFile` is part of the Transport port as a result union,
  implemented for the HTTP, Direct (Obsidian / node fs), and mock adapters, so file
  persistence is adapter-agnostic.
- **Frontmatter.** Handled host-side: split the YAML block off before the editor sees it
  (Blintz normalizes frontmatter lossily) and re-glue the exact original bytes on save.
  This is a documented seam, not a permanent home: native Blintz frontmatter support would
  let DorkOS drop it (the ADR-0291 seam test applies).
- **Hashing is server-side.** The client sends baseline content on the first save and the
  server returns the hash for subsequent saves, so no browser crypto is required on
  insecure-origin LAN setups, without weakening first-save conflict protection.
- **Save UX.** A `useCanvasFileSave` hook drives dirty-only autosave with honest status
  (idle / saving / saved / error) and a Reload-or-Overwrite conflict banner.

This decision is about disk persistence and editor-versus-external-process conflicts. It
complements ADR-0292, which guards the in-app writers (agent versus editor on the canvas
store); together they cover both the in-memory and the on-disk source of truth.

## Consequences

### Positive

- One source of truth: the agent and the user read and write the same file, so the
  original split-brain is gone.
- Blintz stays a focused editor library; persistence policy (auth, conflict UX, storage
  backends) lives in the host, where it can evolve without touching the editor.
- The write path is safe by construction: confinement blocks path escape, the existence
  check blocks accidental creation, and optimistic concurrency blocks blind clobbering.

### Negative

- Frontmatter strip-and-reattach is a host-side workaround until Blintz round-trips
  frontmatter natively; it carries a small risk of drift if Blintz changes its body
  serialization, which the round-trip fidelity test in the Blintz repo is there to catch.
- Optimistic concurrency surfaces conflicts to the user (Reload or Overwrite) rather than
  auto-merging. That fits whole-document canvas edits but is not a CRDT.
- Generated or path-less markdown is read-only in v1; a "Save as" affordance is deferred.
