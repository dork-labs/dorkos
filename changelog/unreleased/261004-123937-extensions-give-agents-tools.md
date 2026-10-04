---
covers:
  - 'feat(extensions): declare agent tools and skills in extension.json (DOR-2685)'
  - 'feat(extensions): accept only listable tool input schemas (DOR-2685)'
  - 'feat(extensions): bind tool handlers through ctx.tools and register them at load (DOR-2685)'
  - 'chore(extensions): fit the tools reference, fix test types, regenerate the API document (DOR-2685)'
  - 'docs(extensions): document extension tools for authors and people (DOR-2685)'
  - 'fix(extensions): one start or stop at a time per extension (DOR-2685)'
  - "fix(extensions): list_extensions shows each tool's status and reason (DOR-2685)"
  - 'fix(extensions): one tool check for discovery, contribute and marketplace validate (DOR-2685)'
  - 'fix(extensions): redact every path shape from a tool error (DOR-2685)'
  - 'feat(claude-code): relaunch a warm process whose dorkos tool list changed (DOR-2685)'
  - 'test(claude-code): pin the warm-process tool-surface relaunch through dispatch (DOR-2685)'
  - 'test(extensions): guard extension tools in every agent tool list (DOR-2685)'
  - 'docs(extensions): say when each agent sees an extension tool change (DOR-2685)'
  - 'fix(claude-code): leave the per-turn connector tools out of the tool-surface digest (DOR-2685)'
  - 'fix(claude-code): never tear down a working process for a tool-list change (DOR-2685)'
  - 'fix(claude-code): list connector tools on a session-long fact so a staged warm-up is not relaunched (DOR-2685)'
  - 'fix(claude-code): warn once when a held tool list outlives the background ceiling (DOR-2685)'
  - "feat(harness): plan running extensions' skills from the server's ledger (DOR-2685)"
  - 'test(harness): pin extension skill planning, containment, collisions and sweeps (DOR-2685)'
  - "feat(extensions): publish running extensions' skills and deliver them (DOR-2685)"
  - 'test(extensions): pin the running-skills ledger, plugin roots, manager delivery and the busy hold (DOR-2685)'
  - "test(cli): a terminal sync keeps a running extension's skills and sweeps them once it stops (DOR-2685)"
  - 'fix(harness): an agent workspace reads the running-skills ledger too (DOR-2685)'
  - 'docs(extensions): document extension skills for authors and people (DOR-2685)'
  - 'test(marketplace): the skills ledger lists only its own plugin roots (DOR-2685)'
  - "fix(harness): keep running extensions' skill links when the ledger is missing or unreadable (DOR-2685)"
  - 'fix(claude-code): build the session plugin list whole so overlapping refreshes never double a root (DOR-2685)'
  - 'fix(extensions): check the folder of skill plugin roots on every reconcile, never clearing through a link (DOR-2685)'
  - 'docs(extensions): say how extension skills survive a missing ledger and clash with plugins (DOR-2685)'
---

### Added

- Extensions can now give your agents tools. An extension you approved offers its tools while it runs, and they go away when you turn it off, stop it or remove it. Each tool sits in the **Extension tools** permission area, and one that deletes something asks you every time. Codex and OpenCode chats get new tools the next time they ask DorkOS for its tool list, and a Claude Code chat gets them with your next message (DOR-2685)
- Extensions can now give your agents skills too: short guides that teach an agent when and how to use the extension. They follow the same approval as the extension and land where a plugin's skills land, in the project for a project's own extension, and in DorkOS's own Claude Code chats for one installed for all your projects. They go away when you turn the extension off, stop it or remove it, and `dorkos harness sync` from a terminal keeps exactly the same skills (DOR-2685)
- Removing an extension clears any permission you set for its tools, so a choice like Allowed never carries over to something installed later under the same name (DOR-2685)
- `dorkos marketplace validate` now checks the extensions a package carries, and fails when DorkOS would refuse one of their tools, so an author hears about it before publishing (DOR-2685)
