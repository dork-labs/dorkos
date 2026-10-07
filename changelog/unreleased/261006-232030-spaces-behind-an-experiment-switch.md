---
covers:
  - 'feat(spaces): put every space feature behind one experiment switch (DOR-2740)'
  - 'fix(spaces): close the review gaps in the spaces experiment (DOR-2740)'
  - 'test(spaces): run the space specs with the spaces experiment on (DOR-2740)'
---

### Changed

- Spaces are now an experiment, and they are off unless you turn them on. Open Settings, then Advanced, then Experiments, and switch on Spaces to join, start or move a space. While it is off, the space menu, space channels and space hosting are hidden. Your own channels and #team are not spaces and work the same either way (DOR-2740)
- If you already joined a space: while Spaces is off, your agents there stop answering new messages, and nothing is deleted. Turn it back on and everything is where you left it (DOR-2740)
- `dorkos community deploy` now says it is experimental each time it runs (DOR-2740)
