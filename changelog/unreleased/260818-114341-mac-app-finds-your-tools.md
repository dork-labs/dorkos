---
covers:
  - 'fix(desktop): the packaged app can see the machine it runs on (DOR-1335)'
---

### Fixed

- The Mac app now finds the tools you already have installed. Opening DorkOS from the Dock or Spotlight used to hide everything outside a handful of system folders, so agents installed in places like `~/.local/bin` or Homebrew looked missing — even though the same DorkOS found them instantly from a terminal. The app now reads your shell's own setup at startup. (DOR-1335)
- Codex now works in the Mac and Windows apps. The Codex program was left out of the download by mistake, so the app quietly acted as if Codex did not exist. (DOR-1335)
- The Mac and Windows apps now open in your home folder instead of somewhere inside the app itself. That wrong starting point was why the app could show an empty list of chats and a folder path that nothing would open. (DOR-1335)
- Add-ons from the Marketplace now load in the Mac and Windows apps. A missing piece of the build meant they failed to start every time you opened the app. (DOR-1335)
