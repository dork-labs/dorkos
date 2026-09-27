---
covers:
  - 'fix(extensions): load extensions that ask for a recent DorkOS version'
---

### Fixed

- Extensions that ask for a recent version of DorkOS now load. Before, DorkOS compared every extension against the wrong version number of itself, so any extension that needed a real release was marked "incompatible" and never started. When an extension really does need a newer DorkOS, its card now says which version: "Needs DorkOS 0.88.0 or newer"
