---
id: 260901-135657
title: A message carries an image by reference, through a session attachment store
status: accepted
created: 2026-09-01
spec: null
superseded-by: null
amends: null
---

# 260901-135657. A message carries an image by reference, through a session attachment store

## Status

Accepted.

## Context

A person asked an image model for a picture, got no error, and never saw the image (DOR-1663). The model ran, produced 1,220 output tokens of image, and billed $0.035208. The bytes were dropped five times over: OpenRouter's provider maps generated images to AI SDK `file` stream parts, OpenCode's `processor.ts` has no `case "file"` and discards them (anomalyco/opencode#12859, fix PR #12871 closed unmerged, issue auto-closed by a stale bot, re-reported by us as #46600); DorkOS's OpenCode part mapper sent `file` parts to a `default:` arm labelled "turn bookkeeping"; its tool mapper read `state.output` and ignored `ToolStateCompleted.attachments`, which OpenCode populates today; and its history mapper returned `null` for a message with no mapped parts, so a turn whose only part was an image vanished from the transcript entirely rather than merely losing its picture.

Underneath all five was one absence: **`MessagePartSchema`, `StreamEventTypeSchema` and the `SessionEvent` union had no image member at all.** The transport could not move a picture, so every adapter's drop was structurally forced and none of them was a bug anyone could see. This is not an OpenCode problem. claude-code's `extractToolResultContent` filters tool results to `b.type === 'text'`, so reading a PNG is discarded on the default runtime; codex's `extractMcpResultText` does the same to MCP results (and `@openai/codex-sdk`'s `ThreadItem` union carries no image output item at all, so a generated image cannot reach it through that SDK regardless).

## Decision

We will carry an image as a **reference**, not a payload. `MessagePartSchema` gains an `image` member and the stream unions gain an `image_attachment` member, both carrying `{attachmentId, url, mediaType, size, alt?}` and never bytes. Bytes live behind a new `SessionAttachmentStore` port under `dorkHome`, served by `GET /api/sessions/:id/attachments/:file` with the `files/raw` posture; the URL the store answered is stored on the part verbatim rather than rebuilt, so the port is a real seam. Attachment ids are **derived deterministically** from the runtime's own identity for the image, which makes a history read idempotent with the live turn instead of writing a second copy. The seam is runtime-neutral: `RuntimeCapabilities.mediaOutput` is required, every runtime declares `'none'` or `'attachments'`, and the shared conformance suite holds each to its declaration. Only the OpenCode adapter adopts it here; claude-code and codex declare `'none'` and are visibly non-compliant until a follow-up teaches them.

Two subordinate decisions, both deviations from the nearest precedent, both deliberate:

**No database row.** Room attachments carry one because they are arbitrary uploads: an original filename, a declared type that may be a lie, a sniffed type that may disagree. A session attachment is machine-generated media on a four-format raster allowlist, so media type and file suffix are a bijection, the size is a `stat`, and the owning session is the directory — everything a row would hold is already on disk, and a second copy could only drift. SVG is refused at the door rather than served as `application/octet-stream`, because it is the one image format that executes and nothing legitimate emits it.

**A byte budget on the stream.** `RingBuffer` and `EventLog` capped events by COUNT, which bounded nothing once a part could stand for an image. Both now also cap by bytes, and a per-event guard replaces any oversized string with a stated omission that keeps the event's type and ids intact.

## Consequences

### Positive

- An image reaches the transcript, survives a reload, and survives a server restart — re-materialized from the runtime's own store under the same id.
- A picture that cannot be kept says so. Every refusal path on the live capture — too large, wrong type, unreadable source, no store wired — emits a typed `error` with a sentence, and a history read whose bytes cannot be re-materialized still projects a part so the reader gets an honest "not available" row instead of a missing turn. Silence is no longer how any of those end.
- The three runtimes stop looking identical from the outside. The conformance suite's media block reports claude-code and codex as known-non-compliant by name, so the follow-up cannot be forgotten.
- The replay path is bounded in bytes for the first time — a fix that outlives this feature.
- No migration, no new table, no second source of truth about what a stored image is.

### Negative

- `mediaOutput` is resolved per instance for OpenCode (a runtime wired without a store honestly declares `'none'`), so capabilities are not purely static for that adapter.
- Adding a required field to `RuntimeCapabilities` and a member to two shared unions forced edits in every runtime's constants and in the assistant renderer. That breakage was the point, but it is breakage.
- The three replay modules moved into `services/session/replay/`. Forced, not chosen: `scripts/check-dir-size.sh` (`ERROR_THRESHOLD=25`, run as the `dir-size` pre-commit command) refuses any commit that adds a source file to a directory already at the cap, and `services/session/` stood at 36. The trio is genuinely one concept so the split is a real improvement, but it is scope this change carried rather than sought. Worth noting for the next person: that threshold is written down only in the script — not in `AGENTS.md`, `.claude/rules/` or `contributing/` — so it is invisible until it blocks you. DOR-1575 tracks another directory over the same cap.
- The 90-day sweep can delete a generated image that no runtime recorded — under OpenCode today, upstream discards those before storing them, so DorkOS's copy is the only one. The window is generous for exactly this reason, and it stops being a risk when #46600 lands.
- `http(s)` image sources are refused rather than fetched (SSRF), so a runtime that ever hands back a remote URL will show a sentence instead of a picture.
- User-attached images (the INPUT direction) are still not projected into history. The schema does not block it — `HistoryMessage.parts` accepts an `image` for either role — but no adapter fills it.
- **The seam ships with two of its three runtimes unfinished, and that deferral is tracked as DOR-1664** ("Claude Code and Codex silently drop non-text tool results"). Both drop sites are already located: `claude-code/sessions/transcript-parser.ts:112-119` (`extractToolResultContent`) and `codex/event-mapper.ts:405-415` (`extractMcpResultText`), each filtering tool-result content to `type === 'text'`. Both are fixable by calling into this seam — store the non-text block through `SessionAttachmentStore.put` under a `deriveSessionAttachmentId` of the runtime's own identity for it, and emit the same `image_attachment` — rather than by inventing a second one. Until that lands, the conformance suite reports both as a named gap on every run, which is the whole reason `mediaOutput` is a required declaration instead of an optional one.

## Amendment (DOR-1664, same release)

An ADR is a dated record and the text above stands as written. One fact in it
stopped being true before it ever shipped, and both changes ride the same
release, so a reader must not be left with the older half.

**claude-code and codex adopted this seam.** The deferral described in Context,
in Positive ("reports claude-code and codex as known-non-compliant by name") and
in the final Negative bullet is closed. Both drop sites named there now call into
this seam: `claude-code` reads image blocks on BOTH of its paths (the live SDK
stream and the JSONL transcript) via `tool-result-images.ts` +
`media-capture.ts`, and `codex` reads MCP `ImageContent` off
`McpToolCallItem.result.content`. Both derive attachment ids from their own
identity for the image exactly as this ADR requires — `tool_use_id` + block
index, and `item.id` + block index. The `it.skip` naming them is gone, and all
three adapters wire a `mediaTurn`.

Two things the follow-up established that this ADR could not have known:

- **`mediaOutput` is resolved per INSTANCE, not per runtime type.** All three
  adapters answer `'attachments'` only when the composition root handed them a
  `SessionAttachmentStore`, and `'none'` otherwise. The field is a promise about
  keeping a picture, and a runtime wired with nowhere to put one must not make
  it.
- **Codex has a real ceiling, and it is not an adapter gap.**
  `@openai/codex-sdk@0.147.0`'s `ThreadItem` union carries no image OUTPUT item
  at all (`local_image` appears only on `UserInput`, the input direction), so
  Codex cannot stream a generated picture however the adapter is written. An MCP
  tool result is its only media path. Nobody should go looking for the other one.
