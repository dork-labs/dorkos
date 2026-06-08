---
name: reading-session-transcripts
description: Resolves DorkOS session URLs to JSONL transcript files on disk and reads them. Use when the user shares a session URL, mentions "read this transcript", "read this chat", or references a DorkOS session they want analyzed.
---

# Reading Session Transcripts

## Overview

DorkOS sessions are backed by Claude SDK JSONL transcript files on disk. When a user shares a session URL or asks you to read a transcript/chat, resolve the URL to the file path and read it directly.

## When to Use

- User shares a URL like `http://localhost:*/session?session=...&dir=...`
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

- **URL uses a non-standard port**: The port doesn't matter — only `session` and `dir` query params are needed
- **Spaces in directory**: URL-encode as `+` or `%20` — both decode correctly
- **File not found**: The session may have been deleted or the directory path may be wrong. Report the resolved path so the user can verify.
- **Session ID without URL**: If the user provides just a session ID, ask for the directory (or check the current working directory slug).
