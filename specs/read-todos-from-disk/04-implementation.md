# Implementation Summary: Read Todos from Disk

**Created:** 2026-03-23
**Last Updated:** 2026-03-23
**Spec:** specs/read-todos-from-disk/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 4 / 4

## Tasks Completed

### Session 1 - 2026-03-23

- Task #9: Add readTodosFromFile(), getTodoFileETag(), and file-first readTasks() to TranscriptReader
- Task #10: Update getSessionETag() to combine transcript and todo file ETags
- Task #11: Unit tests for readTodosFromFile() and getTodoFileETag() (10 tests)
- Task #12: Integration tests for readTasks() fallback and getSessionETag() combination (6 tests)

## Files Modified/Created

**Source files:**

- `apps/server/src/services/runtimes/claude-code/transcript-reader.ts` — Added `readTodosFromFile()`, `getTodoFileETag()`, updated `readTasks()` for file-first fallback
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — Updated `getSessionETag()` to combine transcript + todo ETags

**Test files:**

- `apps/server/src/services/runtimes/claude-code/__tests__/transcript-reader-todos.test.ts` — New: 16 tests (unit + integration)
- `apps/server/src/services/session/__tests__/read-tasks.test.ts` — Updated: mocks adapted for file-first readTasks() flow

## Known Issues

_(None)_

## Implementation Notes

### Session 1

- All 1573 tests pass (90 test files), typecheck clean
- Pre-existing `read-tasks.test.ts` needed mock updates: `readTasks()` now calls `readTodosFromFile()` first (which uses `readFile`), so existing mocks needed to reject with proper ENOENT errors for the first call before providing JSONL content on the second call
- The `getSessionETag()` combination uses `Promise.all` for parallel ETag fetching
