---
covers:
  - 'fix(server): marketplace package names cannot climb out of their folders'
  - 'fix(server): the package resolver bounds local paths and cache-key names'
  - 'fix(server): the marketplace MCP tools check names and project paths'
  - 'chore(server): end git option parsing before author-supplied URLs and refs'
---

### Fixed

- Fixed a hole where an uninstall could reach outside the marketplace's own folders. A package name is now checked before DorkOS turns it into a folder on your disk, so a name dressed up as a path — `../../something-else` — is refused instead of pointing the uninstall's delete at a folder that was never a package. The same check now guards the install cache, which builds folder names out of package names too
- Installing a package from a folder on your own disk now has to stay inside the folder DorkOS is allowed to reach, the same limit every other file feature already respects. Nothing changes for the usual case; a path outside that limit is refused rather than quietly read
- The `marketplace_install` and `marketplace_uninstall` tools an agent can call now check the project folder you point them at, which the web app has always done and the tools did not
