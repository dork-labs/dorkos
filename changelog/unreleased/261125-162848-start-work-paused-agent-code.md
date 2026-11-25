### Changed

- For extension authors: `api.startWork` and `ctx.sessions.start` now refuse a start to a paused agent with `StartWorkError` code `agent_paused`, so your app can tell the person to resume the agent first. Before, `api.startWork` threw a generic "couldn't be started" error. Nothing is saved for later. The extension-seam contract is now 2.1.0. (DOR-5260)
