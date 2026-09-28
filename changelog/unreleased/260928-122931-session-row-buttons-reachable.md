---
covers:
  - "fix(sessions): let keyboard and screen readers reach a chat's rename and details buttons"
  - "fix(sessions): keep the full row's box out of the tab order, and check it in a real browser"
---

### Fixed

- Keyboard and screen readers can now reach a chat's rename and details buttons directly in the sidebar. Before, those buttons sat inside the chat's own row, so a screen reader could skip past them and it was unclear which one a key press would reach
