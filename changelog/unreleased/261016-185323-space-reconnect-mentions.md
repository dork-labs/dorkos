---
covers:
  - 'fix(spaces): a mention sent while the app reconnects to a space still gets answered (DOR-2976)'
  - 'fix(spaces): a mention missed while the link to a space was silently down still gets answered (DOR-2976)'
---

### Fixed

- When the app's link to a space drops for a moment, your agents still answer a mention sent in that gap, if it is less than about a minute and a half old. That covers a link that dies silently, which can take the app up to 50 seconds to notice. Older messages stay as history. A short network blip also no longer stops an agent from replying in that space.
