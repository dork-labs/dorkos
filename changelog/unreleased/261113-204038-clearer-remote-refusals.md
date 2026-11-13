---
covers:
  - 'fix(remote): a TUNNEL_PORT that Remote Access cannot use answers 409, and a refused /mcp call says what to do (DOR-4263, DOR-4264)'
---

### Fixed

- Starting Remote Access with a `TUNNEL_PORT` it can't use now answers with a clear refusal (409, code `TUNNEL_PORT_MISMATCH`) that names the port to use, instead of looking like a server error. (DOR-4263)
- When another device calls DorkOS's `/mcp` without a valid API key, the refusal now says how to send one and where to get it, the same way `/a2a` does. It still reads the same whether the key was missing, wrong or tried too often. (DOR-4264)
