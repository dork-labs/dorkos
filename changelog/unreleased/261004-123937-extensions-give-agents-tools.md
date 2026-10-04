---
covers:
  - 'feat(extensions): declare agent tools and skills in extension.json (DOR-2685)'
  - 'feat(extensions): accept only listable tool input schemas (DOR-2685)'
  - 'feat(extensions): bind tool handlers through ctx.tools and register them at load (DOR-2685)'
  - 'chore(extensions): fit the tools reference, fix test types, regenerate the API document (DOR-2685)'
  - 'docs(extensions): document extension tools for authors and people (DOR-2685)'
---

### Added

- Extensions can now give your agents tools. An extension you approved offers its tools while it runs, and they go away when you turn it off, stop it or remove it. Each tool sits in the **Extension tools** permission area, and one that deletes something asks you every time. Codex and OpenCode chats get new tools the next time they ask DorkOS for its tool list; a Claude Code chat that is already running keeps the tools it started with until it starts again (DOR-2685)
- Removing an extension clears any permission you set for its tools, so a choice like Allowed never carries over to something installed later under the same name (DOR-2685)
