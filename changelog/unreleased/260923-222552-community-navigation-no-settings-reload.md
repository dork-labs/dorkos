---
covers:
  - 'fix(server): stop community navigation saves from reloading settings in every window'
  - 'refactor(server): type-check the community navigation dot-path write'
  - 'fix(server): give the booted-app navigation test double the dot-path write'
---

### Fixed

- Moving between communities no longer makes your other open windows reload all your settings. DorkOS still remembers where you were in each community. This also stops a one-time prompt from popping up in the middle of what you were doing.
