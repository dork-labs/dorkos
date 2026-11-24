---
name: reading-session-transcripts
description: Resolves DorkOS session URLs (`/session?session=` and `/r/dork:chat:` links) to JSONL transcript files on disk and reads them. Use when the user shares a session URL or chat link, mentions "read this transcript", "read this chat", or references a DorkOS session they want analyzed.
---

# Reading Session Transcripts

## Overview

DorkOS sessions from the **claude-code runtime** are backed by Claude SDK JSONL transcript files on disk. When a user shares a session URL or asks you to read a transcript/chat, resolve the URL to the file path and read it directly.

**Caveat:** session storage is runtime-owned (ADR-0310). This resolution logic only applies to claude-code sessions — sessions from the codex or opencode runtimes live in their own runtime's store, not in `~/.claude/projects/`.

## When to Use

- User shares a URL like `http://localhost:*/session?session=...&dir=...`
- User shares a chat link like `http://localhost:*/r/dork:chat:<id>` or `[Chat title](/r/dork:chat:<id>)`, the form agents write (also `dorkos://r/dork:chat:<id>` from the desktop app)
- User says "read this transcript", "read this chat", "look at this session", or similar
- User pastes one or more session URLs inline with other instructions
- User references a session ID and directory path

## URL Resolution

Given a URL like:

```
http://localhost:6241/session?session=05da5015-ed83-491c-a07b-10b21379c3e4&dir=%2FUsers%2Fjane%2FMy+Project
```

### Step 1: Extract Parameters

- **Session ID**: from `session` query param → `05da5015-ed83-491c-a07b-10b21379c3e4`
- **Directory**: from `dir` query param, URL-decoded → `/Users/jane/My Project`

A `/r/dork:chat:<id>` link carries the session ID after `dork:chat:` (percent-decode it once if the `:` arrived as `%3A`) and no directory. Skip Steps 2 and 3 and find the file by id: `ls ~/.claude/projects/*/<id>.jsonl`. A link copied in a chat's first seconds can hold the id the chat had before its runtime renamed it; if nothing matches and the server is running, `GET /api/links/target?uri=dork:chat:<id>` answers the id the chat has now (`sessionId`). A `/r/` link of any other kind (`dork:room:`, `dork:entry:`, `dork:agent:`) is not a transcript.

### Step 2: Slugify the Directory

Replace all non-alphanumeric, non-dash characters with dashes:

```
/Users/jane/My Project → -Users-jane-My-Project
```

This matches the SDK's `getProjectSlug()` in `apps/server/src/services/runtimes/claude-code/sessions/transcript-reader.ts`.

### Step 3: Construct the File Path

```
~/.claude/projects/{slug}/{sessionId}.jsonl
```

Full example:

```
/Users/doriancollier/.claude/projects/-Users-jane-My-Project/05da5015-ed83-491c-a07b-10b21379c3e4.jsonl
```

### Step 4: Read the File

Use the Read tool on the resolved path. The file contains one JSON object per line — the full conversation transcript including messages, tool calls, and results.

## Multiple Transcripts

When the user provides multiple URLs, resolve and read each one. They may want comparison, analysis, or context from several sessions.

## Edge Cases

- **URL uses a non-standard port**: The port doesn't matter — only `session` and `dir` query params (or the `/r/dork:chat:` id) are needed
- **Spaces in directory**: URL-encode as `+` or `%20` — both decode correctly
- **File not found**: The session may have been deleted, the directory path may be wrong, or — likely — the session belongs to another runtime (codex or opencode, ADR-0310), whose transcripts don't live in `~/.claude/projects/`. Never fail silently: report the resolved path and say the session may belong to a non-claude-code runtime.
- **Session ID without URL**: If the user provides just a session ID, ask for the directory (or check the current working directory slug).
