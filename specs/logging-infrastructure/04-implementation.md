# Implementation Summary: Logging Infrastructure

**Created:** 2026-02-16
**Last Updated:** 2026-02-16
**Spec:** specs/logging-infrastructure/02-specification.md

## Progress

**Status:** In Progress
**Tasks Completed:** 2 / 8

## Tasks Completed

### Session 1 - 2026-02-16

- Task #1: [P1] Add `logging.level` to config schema
- Task #2: [P1] Create logger singleton (`lib/logger.ts`)

## Files Modified/Created

**Source files:**

- `packages/shared/src/config-schema.ts` — Added LoggingConfigSchema, logging field, LOG_LEVEL_MAP
- `apps/server/src/lib/logger.ts` — New: logger singleton with consola, NDJSON file reporter, rotation
- `apps/server/package.json` — Added consola@^3.4.2

**Test files:**

- `packages/shared/src/__tests__/config-schema.test.ts` — Added 19 new tests for logging config + LOG_LEVEL_MAP
- `apps/server/src/lib/__tests__/logger.test.ts` — New: 16 tests for logger singleton

## Known Issues

_(None yet)_

## Implementation Notes

### Session 1

- `LOG_LEVEL_MAP` exported from `@dorkos/shared/config-schema` — can be imported by CLI and logger
- Logger uses `.js` extension in imports for NodeNext module resolution
- `LoggingConfigSchema.default({})` caused TS overload error; fixed with factory `.default(() => ({ level: 'info' as const }))`

### Session 2 - 2026-02-16

_(No tasks completed yet)_
