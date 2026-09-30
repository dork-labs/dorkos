---
covers:
  - 'fix(ui): solid keyboard focus ring on every shared form control (DOR-2609)'
---

### Fixed

- When you Tab to a text box, a checkbox, a radio button, a slider or a scrolling list, it now has a clearly visible outline in light and dark mode. Before, the outline was too faint to see easily. This covers the standard controls in the DorkOS app and on a Community's own web page; a few of the app's own boxes, like the folder path box, still have the faint outline and are next (DOR-2609)
- A text box with a mistake in it now shows a clear red outline while you're typing in it. Before, the red was so pale it was hard to tell it apart from the page (DOR-2609)
