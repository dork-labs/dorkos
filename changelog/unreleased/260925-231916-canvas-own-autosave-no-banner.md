---
covers:
  - 'fix(canvas): stop your own autosave from raising the "your agent changed this" notice (DOR-2213)'
---

### Fixed

- **Typing in a canvas document no longer tells you your agent changed it.** Each time a document saved itself while you were editing, the canvas mistook that save for a change from your agent and showed "Your agent changed this while you were editing". It now recognizes its own saves. A real change from your agent, or from another window, still shows the notice so you can choose which version to keep.
