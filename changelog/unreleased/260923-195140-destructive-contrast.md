---
covers:
  - 'fix(client): destructive red meets WCAG AA contrast in light and dark'
---

### Fixed

- Warning and error text is easier to read. The red used for error messages and for buttons like Delete and Reset was too faint against the background in both light and dark mode. It is now a slightly deeper red in light mode and a slightly brighter one in dark mode, so every error message and red button label meets the standard contrast level for readable text. Red buttons in dark mode now use the same deeper shade the main Delete button already had.
