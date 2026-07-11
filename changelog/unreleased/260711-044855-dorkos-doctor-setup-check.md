### Added

- New: `dorkos doctor` checks your setup and tells you what is wrong in plain words. It runs through Node version, whether your data folder is writable, whether the port is free, whether the Claude Code CLI is installed, whether extensions can compile, and whether your login and tunnel settings make sense (for example, login turned on but no signing secret yet). It reads your config and changes nothing. There is also a new Security page and a written threat model that spell out what DorkOS trusts and how to report a problem.

### Security

- Hardening pass on the parts of DorkOS that decide what a package can do and who can reach it. Marketplace installs can no longer be tricked into running a command through a booby-trapped source link. Your login secret and any chat-bot tokens are now kept private on disk, readable only by you. And the key that protects the tool endpoint is checked in a way that gives nothing away. Full write-up in `research/20260711_security-hardening-audit.md`.
