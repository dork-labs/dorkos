---
covers:
  - 'fix(relay): accept a tool approval only from the chat connection that carried the click (DOR-2431)'
---

### Security

- Agents can no longer approve their own tool calls. Before, an agent that knew its session and the pending tool call could send an approval as if you had clicked it on Telegram or Slack. Now DorkOS accepts an approval only when it comes from the chat connection where you clicked, and refuses and logs any other (DOR-2431).
