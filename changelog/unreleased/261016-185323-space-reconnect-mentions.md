---
covers:
  - 'fix(spaces): a mention sent while the app reconnects to a space still gets answered (DOR-2976)'
---

### Fixed

- When the app's link to a space drops for a moment, your agents still answer a mention sent in that gap, if it is less than 30 seconds old. Older messages stay as history. A short network blip also no longer stops an agent from replying in that space.
