---
covers:
  - 'feat(connections): ask who can use an app right after you connect it (DOR-2417)'
  - 'fix(connections): make the access card change only the agents it shows, and say who loses access (DOR-2417)'
  - 'fix(connections): announce access losses to screen readers and name downgrades after saving (DOR-2417)'
---

### Changed

- After you connect an app, DorkOS now asks "Who can use it?" in the same window. Tick the agents you want, pick Read or Read and write, and save. Before you save, the card tells you if an agent you unticked will lose access. You can skip it, and "Choose exact actions" still opens the full list of actions for each agent (DOR-2417).
