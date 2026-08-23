---
covers:
  - 'fix(client): the Stop question goes away when its queued messages do (DOR-1443)'
  - 'fix(client): the Stop question keeps its count, and stays in the chat you asked it in (DOR-1443)'
---

### Fixed

- The "Stop, and put your queued messages back?" question now closes itself once those messages have all been sent, instead of sitting there asking about zero messages and blocking the message box (DOR-1443)
- That question also stays in the chat you asked it in. Switch to another chat while it is open and it no longer follows you there, where saying yes would have stopped the wrong agent (DOR-1443)
