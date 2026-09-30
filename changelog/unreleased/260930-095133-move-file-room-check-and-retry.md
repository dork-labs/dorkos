---
covers:
  - 'fix(cloud): check free space before sending a move file, and say why a retried move stopped (DOR-2610, DOR-2611)'
  - 'fix(cloud): keep the move key whenever the refusal says the move may exist (DOR-2611)'
---

### Fixed

- When you move a community in, DorkOS now checks that the file fits on this computer before sending it. If it doesn't fit, you hear so at once, with how much space it needs and how much is free, instead of after the whole file has gone up. That matters most from a phone, where a large file can take a long time to send. (DOR-2610)
- Starting a move again, after it was refused, cancelled or failed, now begins a new move. If it is refused again, you see the real reason. Before, it could show the old cancelled move with no explanation. (DOR-2611)
