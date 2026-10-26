---
covers:
  - 'fix(mcp): bound tool input validation and HTTP request bodies'
  - 'fix(test): type the partial MCP server mock explicitly'
---

### Security

- Reject oversized tool inputs before they can use excessive server memory.
