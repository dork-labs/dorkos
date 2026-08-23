---
covers:
  - "fix(server,shared): GET /messages resolves a known session's cwd instead of a silent empty 200 (DOR-1322)"
  - 'fix(server,client,shared,test-utils): DOR-1322 review round — guard the fallback probe, mirror the fix in DirectTransport, add conformance coverage'
  - 'fix(server,client,test-utils): DOR-1322 CI break — scope the cwd-verification fallback to runtimes that actually track a live binding'
---

### Fixed

- Asking DorkOS for a chat's messages now works without knowing the chat's folder — and when a chat truly can't be found, it says so instead of answering with an empty list.
