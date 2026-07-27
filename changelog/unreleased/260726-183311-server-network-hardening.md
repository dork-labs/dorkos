---
covers:
  - 'fix(server): validate Host on /api, gate admin restart, lock the data directory (DOR-532)'
  - 'fix(server): judge caller locality by the real Host header, not a forwarded one (DOR-532)'
  - 'fix(server): require a loopback socket for local-only actions, and close an admin path bypass (DOR-532)'
  - 'fix(server): let DORKOS_ALLOW_INSECURE_BIND relax the local-only gate too (DOR-532)'
  - 'fix(server): stop two test-state leaks that could hide a real 403 (DOR-532)'
  - "fix(server): cover the credential routes' locality gate, and correct a wrong diagnosis (DOR-532)"
---

### Security

- Close a hole where a web page you visit could drive your agents. A page can point its own domain at your own machine, which makes your browser treat it as if it came from DorkOS. DorkOS now answers only to the address you actually use, so that page gets turned away (DOR-532)
- Reach DorkOS by another name, like `dorkos.example.com` behind a proxy? Set `DORKOS_TRUSTED_HOSTS=dorkos.example.com` and it works again. Turning on login skips the check entirely, and the official Docker image is unchanged (DOR-532)
- Stop a stranger from installing software on your machine through DorkOS. The buttons that install Ollama, Codex, and OpenCode are meant for you, sitting at your own computer. They trusted headers that any caller can set, so anyone who could reach your instance could start an install. DorkOS now checks the network connection itself, which nobody can fake. Docker is unaffected, because there the container already controls who gets in (DOR-532)

### Fixed

- Stop the Restart and Reset buttons from leaving the desktop app with no server. Restart now tells you to quit and reopen the app, which does the same thing. Reset tells you plainly that nothing was deleted, and names the folder to remove if you really want to start over (DOR-532)

### Added

- Refuse to start a second DorkOS against the same data directory, and say which one already has it. Two servers sharing one directory used to corrupt each other's agents and history (DOR-532)
