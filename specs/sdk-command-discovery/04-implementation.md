# Implementation Summary: SDK-Based Command Discovery

**Created:** 2026-03-15
**Last Updated:** 2026-07-16
**Spec:** specs/sdk-command-discovery/02-specification.md

## Progress

**Status:** Implemented
**Tasks Completed:** shipped

## Reconciliation note (2026-07-16, DOR-109 housekeeping)

This summary was left as a `0 / 5` "In Progress" stub while the feature itself
shipped. The SDK-based command discovery it describes is live: the claude-code
adapter drives `supportedCommands()` through the same non-blocking query pattern
as `supportedModels()` (`apps/server/src/services/runtimes/claude-code/`), the
palette receives built-in / user-level / skills commands, and `CommandEntry.aliases`
(DOR-108) carries the SDK's runtime-native aliases (e.g. `/cost`, `/stats`
folding into `/usage`). The global spec manifest already records this spec as
`implemented`; this file is reconciled to match.

DOR-109 (`universal-command-intents`) builds **on top of** this substrate — it
adds a runtime-neutral cross-agent alias registry and the two-seam
compact / clear / context intents — so this spec is superseded in spirit by
neither: it remains the shipped SDK-discovery foundation DOR-109 composes with.

## Files Modified/Created

See the shipped claude-code adapter command surface under
`apps/server/src/services/runtimes/claude-code/` (`sdk/`, `messaging/runtime-cache.ts`,
`messaging/message-sender.ts`) and `CommandEntry` in `packages/shared`.

## Known Issues

_(None.)_
