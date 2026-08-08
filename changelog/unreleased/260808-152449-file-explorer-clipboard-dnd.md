---
covers:
  - 'feat(client): file explorer clipboard, alt-drag copy, and drag into chat'
  - "fix(client): make the explorer's refusals speak, and stop consuming the composer's drop"
---

### Added

- Copy and paste files in the Files panel — from the right-click menu or with Cmd/Ctrl+C and Cmd/Ctrl+V. A copy that would land on an existing name is renamed the way your file manager does it (`notes copy.md`), and Duplicate makes one beside the original in a single step (DOR-1032)
- Hold Alt while dropping a file in the tree to copy it instead of moving it, and drop one in the empty space below the tree to move it to the top level (DOR-1032)
- Drag a file or folder from the Files panel into the chat box to add it to your message as an `@` reference. Files dragged in from your desktop still upload as before (DOR-1032)
- Paste tells you when a folder cannot go where you asked, and the menu greys it out where it would not work, instead of looking like nothing happened (DOR-1032)
