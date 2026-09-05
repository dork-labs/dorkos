---
covers:
  - 'fix(marketplace): adapters say when they ignore your project scope (DOR-1776)'
  - 'fix(marketplace): key the self-install filter on install root, not name (DOR-1776)'
---

### Fixed

- Installing an adapter for one project now tells you when it lands machine-wide instead of silently ignoring the project choice (DOR-1776)
- The install conflict check now looks at every kind of installed package — agents and Shapes as well as plugins — when warning you about a clashing skill name or a screen slot two packages both want (DOR-1776)
- Reinstalling a package no longer warns that it clashes with itself, and two different packages that happen to share a name are no longer mistaken for one, which used to hide a real clash between them (DOR-1776)
