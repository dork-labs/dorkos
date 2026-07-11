### Added

- New: `dorkos doctor` checks your setup and tells you what is wrong in plain words. It runs through Node version, whether your data folder is writable, whether the port is free, whether the Claude Code CLI is installed, whether extensions can compile, and whether your login and tunnel settings make sense (for example, login turned on but no signing secret yet). It reads your config and changes nothing. There is also a new Security page and a written threat model that spell out what DorkOS trusts and how to report a problem.
