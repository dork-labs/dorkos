---
number: 100
title: File Path Injection for Agent File Access
status: draft
created: 2026-03-09
spec: upload-files
superseded-by: null
---

# 0100. File Path Injection for Agent File Access

## Status

Draft (auto-extracted from spec: upload-files)

## Context

DorkOS needs to support file uploads in the chat interface. When a user uploads a file, the Claude Code agent must be able to access it. Three approaches were considered: (1) extending `Transport.sendMessage()` with an attachments parameter and rich content blocks, (2) uploading to the Anthropic Files API and referencing by `file_id`, or (3) saving files to the session's working directory and injecting file paths as plain text into the message.

## Decision

We inject uploaded file paths as plain text prepended to the user's message content. Files are saved to `{cwd}/.dork/.temp/uploads/` on the server, and the `transformContent` hook prepends relative paths (e.g. "Please read the following uploaded files:\n- .dork/.temp/uploads/report.pdf") before calling the existing `transport.sendMessage()`. No changes to the `sendMessage()` signature or the Transport interface's message flow are required. A separate `uploadFiles()` method handles the file transfer.

## Consequences

### Positive

- Zero changes to the core `sendMessage()` Transport interface — the most critical API surface remains stable
- Leverages Claude Code's existing filesystem tools (`Read`, `cat`, `bash`) — no new agent capabilities needed
- Files stay local on disk, aligned with DorkOS's local-first philosophy
- Simple to implement, test, and debug — it's just text prepended to a message
- Works identically across HttpTransport and DirectTransport

### Negative

- The agent sees file references as natural language, not structured metadata — it could misinterpret or ignore them
- No rich content blocks for images (the agent must use its `Read` tool rather than receiving inline base64)
- File paths are visible in the message history if inspected — they're infrastructure leaking into content
- If the agent's cwd differs from the upload cwd, relative paths may not resolve correctly
