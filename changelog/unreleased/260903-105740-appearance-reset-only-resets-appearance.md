---
covers:
  - 'fix(client): the Appearance reset stops at appearance (DOR-923)'
---

### Fixed

- "Reset to defaults" on the Appearance tab now puts back the theme and text and nothing else. It used to quietly flip every switch on the Preferences tab and forget your sidebar, canvas, and panel layouts too. If you do want the clean slate, it lives in Settings → Advanced → Danger Zone as "Reset All Settings", and it asks first (DOR-923)
