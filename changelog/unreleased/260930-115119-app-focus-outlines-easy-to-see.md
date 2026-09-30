---
covers:
  - 'fix(client): draw every keyboard focus ring in the app at full strength (DOR-2615)'
  - 'fix(client): show the answer cursor only after a key, and tighten the faint-ring guard (DOR-2615)'
  - 'fix(client): first arrow key reveals the hidden answer cursor instead of moving it (DOR-2617)'
---

### Fixed

- When you move around the DorkOS app with the Tab key, the outline around the thing you're on is now easy to see in light and dark mode. Before, many boxes, rows, links and small buttons drew it too faintly: the folder path box, the feedback message box, inbox rows, option lists and banner close buttons among them (DOR-2615)
- Choice switches like "Ask first / Full autonomy" now show an outline when you tab to them. Before, nothing showed at all (DOR-2615)
- When an agent asks you a question, the first answer no longer looks already chosen. The outline that shows where the arrow keys are only appears once you press one (DOR-2615). The first arrow press now just reveals that outline where it already was, instead of secretly moving it first — so Down no longer skips past the first choice, and Up no longer jumps to the last one. Enter does the same: while the outline is still hidden, it moves you to the next question instead of submitting a choice you never saw (DOR-2617)
