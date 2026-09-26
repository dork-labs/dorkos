### Security

- Agents can no longer start a scheduled run on their own. Before this, an agent could send a message that started a run with its own instructions, in any folder, with every permission check turned off and nobody watching. Now only the scheduler can start a run, and any other attempt is turned away and logged. (DOR-2416)
