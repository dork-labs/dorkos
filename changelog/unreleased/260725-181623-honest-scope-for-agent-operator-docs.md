### Fixed

- Our docs said DorkOS sorts everything an agent can do into three risk groups, and asks you before anything that cannot be undone. That was not true, and it was not true in the direction that matters: an agent can still delete one of your scheduled tasks without asking. The guides now name exactly what waits for you (adding, removing, and creating marketplace packages) and say plainly which tools are not covered yet, so you can decide what to hand an agent (DOR-468)
- The "Your Agents Can Operate DorkOS" guide promised two safety checks DorkOS does not perform: that an agent checks with you before editing a different agent, and that it changes settings only when you ask. Both are instructions we give the agent, not locks. The guide now says so, and points you at your activity feed, which does record the change (DOR-428)
- The MCP server page listed 48 tools and left out everything the operator surface added. It now lists all 55, says which 15 carry a risk level, and counts the capability catalog resource it had been missing (DOR-428)

### Added

- Three new pages on dorkos.ai describe what shipped: Action Approvals, Agent Attribution, and the Capability Catalog (DOR-428)
