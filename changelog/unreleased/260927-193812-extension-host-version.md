---
covers:
  - 'fix(extensions): load extensions that ask for a recent DorkOS version'
---

### Fixed

- Extensions that ask for a recent version of DorkOS now load. Before, DorkOS compared every extension against the wrong version number of itself, so any extension that needed a real release was marked "incompatible" and never started. The card for an extension that needs a newer DorkOS now reads "Needs DorkOS 0.88.0 or newer".
