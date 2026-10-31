---
covers:
  - 'fix(server): agents on small-context models fit their window, and say plainly when they cannot (DOR-2839)'
  - 'fix(server): a small-window agent keeps the DorkOS tool guard lines (DOR-3515)'
---

### Fixed

- An agent on a model with a small context window, such as a 32k local model, no longer stops on its first message. DorkOS used to fill most of the window with its own instructions and tool descriptions before the conversation began. Now, when the window is small, DorkOS leaves out its least useful extras first: the widget guide, the list of DorkOS areas, the room guide outside rooms, and then full tool descriptions, which the agent can still look up. Safety boundaries, working rules and the rules for reaching DorkOS's tools safely always stay. If the agent still can't fit, the chat says so and suggests a model with a larger window or a shorter AGENTS.md. (DOR-2839)
