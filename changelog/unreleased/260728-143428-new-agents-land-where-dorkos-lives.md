---
covers:
  - 'fix(agents): create new agents where DorkOS actually keeps its data (DOR-662)'
---

### Fixed

- New agents now land in the DorkOS folder the running copy is actually using. If you point DorkOS at a different folder — a second copy, a container, a checkout you are working on — creating an agent used to build it in your main `~/.dork/agents` instead, so folders appeared in your everyday setup that you never asked for. Setting your own agents folder still means exactly what you typed.
- Setup saves the personality you pick for DorkBot to that same copy's DorkBot. It used to edit the DorkBot in your main folder.
- The create-an-agent screen now shows the real folder the agent will be created in, and checks that folder for a conflict. It used to show `~/.dork/agents`, which was not always where the agent went.
