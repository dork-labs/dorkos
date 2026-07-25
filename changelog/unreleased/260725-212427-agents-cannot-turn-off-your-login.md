---
covers:
  - 'fix(security): agents cannot change the settings that protect your instance (DOR-488)'
---

### Security

- Agents can no longer turn off your login. The `config_patch` tool let an agent change any setting, and nothing asked you first. That included the login switch. Turning login off is the one change that undoes every other protection, because approving a risky action is what a signed-in person does. An agent could switch that off and then approve its own work. The tool now refuses the settings that decide who can reach your instance and what it can touch: login, the public tunnel, the MCP endpoint and its key, telemetry choices, where your provider keys come from, extensions, the runtime programs DorkOS runs, and the folders DorkOS reads and writes. Ask an agent to change one and it is told plainly to ask you instead. You still change all of these yourself in Settings, exactly as before. Adding a new setting to DorkOS now means deciding whether an agent may write it, so nothing new can slip through unnoticed (DOR-488)
