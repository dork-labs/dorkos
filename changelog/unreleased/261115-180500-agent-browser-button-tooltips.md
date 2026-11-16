---
covers:
  - "feat(client): the Agent browser's buttons name themselves in tooltips again (DOR-4427)"
  - 'fix(client): browser bar tooltips wait half a second and never blank the Agent browser page (DOR-4427)'
---

### Changed

- Rest the pointer on Back, Forward or Reload in the Agent browser and a small label names the button, the same as in the canvas browser. The label waits half a second, so passing over the bar shows nothing.
- The page never disappears under that label: a picture of the page holds its place while the label shows. If the picture isn't ready, the button shows a plain hover hint instead.
