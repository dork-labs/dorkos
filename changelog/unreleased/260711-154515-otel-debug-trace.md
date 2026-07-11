### Added

- New `dorkos --debug-trace` mode writes a local timing file you can send when reporting a bug. It records how long session turns, agent calls, relay messages, and task runs take — durations and counts only, never your prompts, file paths, tokens, or anything you typed. It's off unless you ask for it, the file stays on your machine, and nothing is ever sent anywhere (DOR-294)
