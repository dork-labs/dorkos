---
covers:
  - 'feat(canvas): pages with inline SVG in the body keep their line to the agent (DOR-3131)'
---

### Fixed

- A page an agent builds can talk to its agent even when its body has inline SVG icons, MathML, an embedded frame, a `<template>` or a `<noscript>`. Before, any of these quietly cut the page off (DOR-3131)

### Added

- When DorkOS can't connect a page in the canvas to its agent, a short line above the page says why, and the agent can read the same reason (DOR-3131)
