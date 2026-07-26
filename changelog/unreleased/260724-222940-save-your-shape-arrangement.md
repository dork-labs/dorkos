---
covers:
  - 'feat(shapes): save your Shape arrangement from the switcher (DOR-402)'
  - 'fix(shapes): never let a fork erase panels nobody closed (DOR-402)'
  - 'fix(shapes): always say why saving your own version failed (DOR-453)'
---

### Added

- Save the setup you are working in as your own Shape. The Shape switcher now has **Make your own version** next to **Reset to defaults**: name your copy, and it keeps the extensions you have turned on and the way your workspace is arranged. Anything DorkOS cannot see stays exactly as the original Shape had it — it will never erase a setting nobody changed, like panels closed by a page reload — so your copy only records what you actually chose. Escape backs out one step at a time: it closes **Name your version** first, the switcher second. And if you walk away while a copy is still saving, DorkOS still tells you how it went (DOR-402, DOR-453)
