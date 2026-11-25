---
covers:
  - 'fix(api): blocking an area for agents no longer stops your own app pages for it from loading (DOR-4978)'
---

### Fixed

- If you block an area for agents, such as To-dos, the app's own pages for it still load for you. Before, blocking To-dos for agents also stopped your To-dos page from loading.
- Agents and API keys are still blocked from reading it, and anything that changes something is still blocked too.
- When you read past that block, the audit log records it as your read, at most once every 10 minutes for each page and device.
