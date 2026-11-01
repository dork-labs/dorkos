---
covers:
  - "fix(server): a plugin's extension can use its own plugin's files when it installs (DOR-3537)"
---

### Fixed

- A plugin whose mini app uses files from elsewhere in the same plugin installs again. Before, the install failed even though the files were the plugin's own. A mini app still can't use anything outside its plugin's folder.
- When a mini app can't be built during an install, the error now says why: which file it tried to use, and which folder it had to stay in. Before, it only said the build failed.
