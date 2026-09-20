---
slug: agent-browser-sessions
number: 260919-180529
created: 2026-09-19
status: specified
---

# Agent browser sessions — ideation

**Author:** Latch (Claude Code), from an operator brief
**Tracker:** DOR-2155 (Layer 2 is DOR-2156, blocked by this)
**Background:** `research/20260919_agent-secrets-and-vault.md` §1.2 (1Password's agent tooling) and §4 (references, never values)

## 1) Intent

Agents that browse the web hit sign-in pages. Today the operator either pastes a password into a chat (the agent now holds it forever, in a transcript) or gives up. The operator wants to sign in to a site once, in a browser they recognise, with their password manager working normally, and have every agent's browser start already signed in. Agents never see a password; they only ever get the saved session.

It must work the same for Claude Code, Codex and OpenCode agents inside DorkOS, and there must be a written setup for the bare `claude`, `codex` and `opencode` CLIs.

## 2) What already exists

- A working prototype (session scratchpad, `login.mjs`) launched system Chrome on `~/.dork/browser/profile` with a debugging port, then exported the signed-in state with Playwright `connectOverCDP` + `storageState()` to `~/.dork/browser/storage-state.json` (`0600`). The operator has signed in with it. **Both paths are kept** so that sign-in carries over.
- `@playwright/mcp` accepts `--isolated --storage-state <file>`: each server gets its own in-memory browser seeded from the file. That is the concurrency answer. Its default (one persistent profile per server) collides as soon as two agents open a browser.
- Per-agent managed MCP servers (`AgentManifest.mcpServers`, `AgentMcpServerService`) already reach all three runtimes inline, behind the gated `mcp.add` capability and its approval card (ADR 260803-233420, ADR 260803-233414).
- `research/` has Playwright-for-testing reports (`20260225_*`) and a canvas-browser report; none covers signed-in agent browsing.

## 3) Options considered

| Question                    | Options                                                                                                                              | Pick                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| How the CLI talks to Chrome | Playwright `connectOverCDP` over a TCP port (prototype); raw CDP over `--remote-debugging-pipe`                                      | **Pipe.** No port, so nothing else on the machine can drive the signed-in browser while it is open, and it needs only Node built-ins, so the published CLI gains no dependency.                                                                                                                                                                                                                                                                                    |
| When to save                | When the window closes; when the operator presses Enter                                                                              | **Enter.** Saving needs a live browser: cookies on disk are encrypted with a Keychain key, a page's own storage can only be read from an open tab, and sign-ins that end when the browser closes are gone once it quits. "Window closed" also means different things per OS (macOS keeps Chrome running with no windows). If Chrome quits first, nothing is saved and the old file is left alone.                                                                  |
| Automation marker           | Any debugging channel makes `navigator.webdriver` true; hiding it needs a flag that shows a "Stability and security will suffer" bar | **Accept the marker by default** (the prototype had it too) and offer `--plain`: plain Chrome with no debugging channel at all, saved after it quits, which keeps "remember me" sign-ins but loses ones that end when the browser closes.                                                                                                                                                                                                                          |
| How agents get it           | A new capability; a preset in the Toolkit Add flow; both                                                                             | **Both, thin.** An `observe` capability `mcp.browser_preset` (no MCP tool, so it is not ambient in every agent's session) reports which sites have a session and returns the exact server entry; the Toolkit's "Signed-in browser" button feeds that entry to the existing `mcp.add`, so the operator approves it at the same card that shows the exact command. No new write path.                                                                                |
| Missing session file        | Let Playwright fail with `ENOENT`; a wrapper process; keep an empty file in place                                                    | **Empty file plus a context line.** Playwright MCP fails every tool on a missing file (it does not start signed out), so the server writes an empty session whenever the browser is added or injected, and `forget --all` empties rather than deletes. The runtime-neutral context builder then tells the agent it starts signed out and to ask for `dorkos browser login`. No wrapper process, and the server entry stays the plain `npx` command the card shows. |
| Visible theme               | A first-run page asking the operator to pick a colour; profile preferences                                                           | **Preferences**, verified by experiment on Chrome 153 (see spec §4).                                                                                                                                                                                                                                                                                                                                                                                               |

## 4) Out of scope, recorded as future work

**Layer 2: an agent-triggered sign-in broker (DOR-2156, blocked by DOR-2155).** A `sign_in(site)` tool that asks 1Password's `op` for the site's item with Touch ID on every use, refuses unless the item's URL matches the page's origin, fills and submits the form, scrubs the value, and returns only a status. This is the "Agentic Autofill" shape from the research report §1.2. One known gap to design around: Codex has no PreToolUse hooks, so nothing in DorkOS could stop a Codex agent from calling `op` directly; that broker would need to own the only credential path rather than police it.

Also out: a DorkOS password vault (research §4.6 says no), and saving new sign-ins from inside an agent's isolated browser (they are discarded when it closes, on purpose).
