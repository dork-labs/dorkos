---
covers:
  - 'feat(extensions): one line per extension in Settings, with what needs you on top'
---

### Changed

- See every extension at once in Settings → Extensions: each one is a single line with its name, what it is for, and its switch. Ones that need you sit on top with a short label, like "Needs your OK" or "Not working". The rest are A to Z and stay put when you switch one off. Search and an Off filter help in a long list.
- Click a row to open it in place. The one decision comes first, and the version, author, access and the tools it gives agents sit underneath.
- An extension waiting for your OK shows Review instead of a switch, so turning it on always goes through the question first.
- An extension whose screens were paused after its files changed now says so, and shows what changed, instead of quietly looking allowed.
- Extension authors can set a one-line `summary` in `extension.json`; without it, the first sentence of the description is shown.

### Fixed

- When your extensions can't be loaded, Settings says so and offers Try again, instead of saying none are installed.
