---
covers:
  - 'fix(browser): preserve warmup cookies and enforce measured viewer limits'
  - 'feat(browser): add owner-controlled managed browser experiment'
  - 'fix(browser): preserve displayed input and packaged runtime ownership'
  - 'fix(browser): identify current instances and diagnose pending shutdown'
  - 'fix(browser): finish viewer capture before renewing its lease'
  - 'fix(browser): distinguish observed helper exits from tracking gaps'
  - 'refactor(browser): isolate lifecycle tracking and acceptance checks'
  - 'feat(browser): expose granted agent diagnostics and trace proxy refusals'
  - 'feat(browser): import sign-ins into isolated managed profiles'
  - 'fix(browser): preserve saved profiles during import upgrades'
  - 'feat(browser): qualify managed browser runtimes and selection copy'
  - 'fix(browser): release cancelled checks and retain process observers'
  - 'fix(browser): preserve original work through diagnostic failures'
  - 'fix(browser): join the original controller reset during cleanup'
  - 'fix(browser): authenticate service workers before resuming them'
  - 'fix(browser): resume owned service-worker requests'
  - 'fix(browser): refuse late worker resumes during shutdown'
  - 'fix(browser): handle authentication on the browser root connection'
  - 'fix(browser): join retired input during controller cleanup'
  - 'fix(browser): warm proxy authentication before saved profile navigation'
---

### Added

- Add **Shared browser** to Settings → Advanced → Experiments, off by default. This setting stays under your control. The experiment targets Apple silicon Macs and stays unavailable when required safety checks fail.
- Add choices for saved browser profiles and clean sessions, with a browser view, visible pointer and typing cursor, and controls for taking or releasing control. Further checks of these flows are still pending.
- Add an option to import cookies and local storage from a file into a new saved profile. Interrupted or failed imports stay blocked after a restart. Checks with the installed browser are still pending.
- Add **Copy selected text** while you control the browser. Passwords and other sensitive fields stay excluded. Checks with the installed browser are still pending.
- Add **Use Chrome user agent** to choose a Chrome-compatible user agent. Change this choice only while Shared browser is off. Checks with the installed browser are still pending.

### Fixed

- Wait for an in-flight browser frame to finish before renewing the view, so renewal does not start overlapping captures.
- Keep browser work running when an observed helper exits during a process check.
- Preserve saved profiles and their session links when updating to a version that supports sign-in imports.
- Release a cancelled installation check's reservation after its processes and file operations finish, so a later check can start. Checks with the installed browser are still pending.
