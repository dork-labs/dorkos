---
covers:
  - 'refactor(client): the keyboard ladder speaks to an editing surface, not a textarea (DOR-948)'
  - 'feat(client): the markdown boundary — nodes, transformers, and the position map (DOR-948)'
  - 'feat(client): the Lexical field behind the editing surface (DOR-948)'
  - 'feat(client): the ladder at critical priority, and who owns a paste (DOR-948)'
  - 'feat(client): lazy-load the editor, and measure what it actually costs (DOR-948)'
  - 'feat(client): typed handles become identity pills, and the two fields read alike (DOR-948)'
  - 'fix(client): jsdom gets DragEvent and ClipboardEvent, so a paste cannot crash the run (DOR-948)'
  - 'feat(config): a setting for whether the message box formats as you type (DOR-948)'
  - 'feat(client): the composer preference, read and written like the status-bar pins (DOR-948)'
  - 'feat(client): a switch in Settings, in words that say what it does (DOR-948)'
  - 'feat(client): rich text in the chat composer, behind a setting (DOR-948)'
  - 'fix(client): Enter on an empty list item exits the list (DOR-948)'
  - "perf(e2e): measure the composer's two costs instead of estimating them (DOR-948)"
---

### Added

- A new setting that makes the chat message box show formatting as you type. Turn it on in
  Settings → Advanced → **Format text as you type**. With it on, `**bold**` turns bold as you
  close the second pair of asterisks, `- ` starts a bullet list, `# ` makes a heading, and
  `` `code` `` becomes code. Enter still sends your message — except inside a list, where it
  starts the next bullet, and an empty bullet ends the list. Anything the box does not preview,
  like quotes, code blocks, links and tables, stays as you typed it and still renders when the
  message is sent. It is off until you turn it on, and it applies to chat for now (DOR-948)
