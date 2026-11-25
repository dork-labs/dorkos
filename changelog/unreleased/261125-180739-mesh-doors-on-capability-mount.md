---
covers:
  - 'fix(api): the agent registry reads and changes on /api/mesh are served by the capability mount, the changes person-only (DOR-4978)'
---

### Changed

- For scripts that use the DorkOS API: the agent list, the counts and the agent network on `/api/mesh` have new operation names (`mesh.list_agents`, `mesh.status` and `mesh.topology`), with the same paths and answers for a person. Read by an agent, the agent list and the agent network leave out other agents' instructions, permissions, MCP servers, workspace and folder, and the counts leave out the count by folder.
- Registering, scanning for, removing and deleting agents, hiding folders from discovery, the list of hidden folders and who may message whom are now a person's controls. A call from an agent, or one that sends an API key or any `Authorization` header, is refused with `person_only`. Agents keep their own tools for these, which ask a person where they must.
- A bad icon, color or display name on a new agent is refused with a fixed sentence that no longer repeats what you typed.
