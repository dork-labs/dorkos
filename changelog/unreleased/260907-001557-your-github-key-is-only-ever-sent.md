---
covers:
  - 'fix(server): your GitHub key is only ever sent to GitHub (DOR-1833)'
---

### Fixed

- Your GitHub key is only ever sent to GitHub. Installing a marketplace package, or creating an agent from a template, used to attach your key to whatever address it was pointed at — so an address on someone else's site was handed a working key to your GitHub account. Private repositories on GitHub still work exactly as before (DOR-1833)
