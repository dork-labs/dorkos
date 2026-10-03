---
covers:
  - "feat(credits): run Codex and OpenCode on DorkOS credits once each one's format is served (DOR-2633)"
  - 'fix(credits): offer Codex and OpenCode only once the service lists their format, and never switch OpenCode mid-reply (DOR-2633)'
  - 'refactor(credits): export the one protocol-to-format mapping (DOR-2633)'
  - 'fix(credits): keep the credits token unnameable by project config, tolerate formats a newer service lists, and never restart OpenCode under a turn (DOR-2633)'
  - "fix(credits): route OpenCode's credits through a loopback relay so the token never enters its process (DOR-2633)"
  - 'fix(credits): answer local programs only at the relay, and refuse OpenCode credits turns without one (DOR-2633)'
---

### Added

- Codex and OpenCode are ready to run on DorkOS credits. Each gets a **Runs on** choice on its card in Settings › Runtimes and a switch under **Use credits for**, but neither shows up anywhere until DorkOS credits actually serve it. For Codex the choice applies to new conversations. For OpenCode it moves all of OpenCode, and you can't switch while OpenCode is in the middle of a reply, so nothing it's doing is cut off (DOR-2633)

### Fixed

- On credits, Codex and OpenCode never use your own sign-in or keys, and DorkOS never changes your own Codex or OpenCode settings. If credits can't be reached, the chat stops instead of quietly running on your own account: Codex offers **Start a new conversation on your Codex sign-in**, and OpenCode offers **Use your OpenCode sign-in**, which switches all of OpenCode back (DOR-2633)
- A runtime set to DorkOS credits keeps its **Use credits for** switch even while credits can't run it, so you can always switch it back (DOR-2633)
- On credits, OpenCode never holds your DorkOS credits key: it talks to DorkOS on this computer, which adds the key on the way out, so a project's own OpenCode settings can't read it and send it anywhere (DOR-2633)
- Claude Code on credits now also ignores five more ways another program can hand it an endpoint or a sign-in (DOR-2633)
