---
covers:
  - "feat(cli,server,client): sign in once, and every agent's browser starts signed in (DOR-2155)"
  - 'fix(cli,server,client): the signed-in browser starts signed out instead of failing, and a page cannot plant its storage (DOR-2155)'
---

### Added

- Sign in to a website once and your agents' browsers start already signed in. Run `dorkos browser login github.com`, sign in in the orange-framed agent browser (your password manager works there as usual), and press Enter. Agents get the saved sign-in, never your password (DOR-2155)
- Give an agent the signed-in browser from its profile: Tools & MCP, then Signed-in browser. The button works for Claude Code, Codex and OpenCode agents. Each browser runs hidden, starts from your save, and keeps what the agent does to itself. An agent with the browser can read every saved sign-in in it, so give it only to agents you trust with those accounts (DOR-2155)
- See which sites are saved with `dorkos browser status`, and take one away with `dorkos browser forget <site>`. The same saved sign-ins also work in the `claude`, `codex` and `opencode` command-line tools; the Signed-in Browser guide has the setup. Tested on macOS with Chrome; a full agent turn inside DorkOS, and Windows and Linux, are not tested yet (DOR-2155)
