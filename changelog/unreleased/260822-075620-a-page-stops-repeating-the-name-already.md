---
covers:
  - 'refactor(client): a page stops repeating the name already in the bar'
  - 'refactor(client): the tab strip drops the density no route wears'
  - 'refactor(client): name the fixed cluster so I1 can be asserted by name'
---

### Changed

- Pages stop saying their own name twice. The bar along the top already tells you where you are,
  so Marketplace, Marketplace Sources, Connections and Product feedback no longer repeat it as a
  big title underneath — each one opens with the line that actually explains it. Screen readers
  still announce the page name, so nothing is lost if you navigate by heading
