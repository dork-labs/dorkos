---
covers:
  - "fix(security): allowlist the tokenless config snapshot, give the CLI a credential (DOR-428)"
---

### Security

- Closed an information leak in the `config_get` tool. It returned your whole settings file with only four fields held back. What came through included pointers to where your provider keys live. That means an environment variable name, a keychain entry, or the path to a key file on your disk. It also included the name of the DorkOS account this install is linked to. That tool answers without asking for a token, so any program running on your machine could read all of it. Your keys themselves were never in there. Now the tool shares a fixed list of settings. Anything key-related comes back as a plain yes or no instead of a value. Adding a new setting to DorkOS now means deciding whether it belongs on that list, so nothing new can slip in unnoticed (DOR-428)

### Fixed

- CLI commands work again when your DorkOS asks you to sign in. `dorkos agent`, `dorkos task`, `dorkos activity`, `dorkos call`, and `dorkos version --check` sent nothing to prove who you were. On an instance with login turned on, every one of them stopped with a bare "Unauthorized". Your agents in Codex and OpenCode lost their only way to act. The CLI now sends your API key, read from `DORKOS_API_KEY` or from `~/.dork/api-key`. When no key is set up, the error names what is missing and where in the cockpit to create one. If you have not set up a key, nothing changes (DOR-428)
