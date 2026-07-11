### Security

- Hardening pass on the parts of DorkOS that decide what a package can do and who can reach it. Marketplace installs can no longer be tricked into running a command through a booby-trapped source link. Your login secret and any chat-bot tokens are now kept private on disk, readable only by you. And the key that protects the tool endpoint is checked in a way that gives nothing away. Full write-up in `research/20260711_security-hardening-audit.md`.
