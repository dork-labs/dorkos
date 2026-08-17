---
covers:
  - 'fix(server): agents are taught DorkOS tools by the names they can actually call (DOR-1292)'
---

### Fixed

- Agents are now told the real name of every DorkOS tool. Claude Code hands your agent these tools under longer names than the ones DorkOS registers them with, and the instructions it reads were using the short ones — so an agent that followed them exactly got "no such tool" and gave up. Smarter models worked around it; cheaper, faster ones did not. Asked to just acknowledge a message, an agent now leaves the ✅ on the first try instead of failing three times and typing a reply nobody asked for (DOR-1292)
