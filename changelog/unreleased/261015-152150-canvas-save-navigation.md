---
covers:
  - 'fix(canvas): flush buffered drafts when editors close'
  - 'fix(canvas): isolate autosave results across document navigation'
---

### Fixed

- Keep a previous document’s save result from changing the document you open next.
- Save the latest buffered draft when you close a document editor.
