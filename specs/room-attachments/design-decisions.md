# Design Decisions — file attachments in rooms

Visual companion session: `.dork/visual-companion/81863-1786054606/` (2026-08-06, with Dorian)

## 1. Composer affordance

Settled by the composer-parity decision (see `specs/composer-parity/04-design-decisions.md`): the room composer uses **chat's exact attach treatment** — 📎 action + file chip bar above the input, drag-and-drop and paste capture — via the shared compound composer components. No room-specific attach UI.

## 2. Timeline rendering

**Screen:** `room-attachments-timeline.html`
**Options:** A) inline previews (images as thumbnails, other files as chips) · B) uniform calm chips for everything · C) hybrid chips with embedded thumbnails
**Chosen:** **A — "inline previews when possible."** Images (and other previewable types as they become supportable) render as inline thumbnails, click to open; everything else falls back to a compact chip (icon + name + size).

## Open items for SPECIFY (recommendations, not yet decided)

- **Agent context:** recommend room agents automatically receive attachment file paths in their context, same as any other entry content. Dorian has not confirmed — surface at spec review.
- **Limits:** max size, count per entry, type restrictions — spec-level.
- **Access model:** recommended upload-then-reference with room-membership-scoped reads (see `01-ideation.md` §5).

## Final Design Summary

Files enter through the shared composer chip bar exactly as in chat, ride room entries as structured attachment references (never body text — mention-span offsets must stay untouched), and render in the timeline as inline previews when the type supports it, calm chips otherwise. Attachment rendering lands as its own module beside the split `RoomEntryRow` (DOR-956), not inside it.
