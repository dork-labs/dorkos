---
covers:
  - 'feat(shared): add the Docs embed catalog, decoded from string attributes into gen-UI widget nodes (DOR-2981)'
  - 'feat(client): draw charts, stats and tables in markdown docs, and save a doc as a web page (DOR-2981)'
  - 'feat(server): teach agents the markdown embed syntax and its escape (DOR-2981)'
  - 'fix(docs): take a stat delta as JSON, cap embed sizes, and parse each embed once (DOR-2981)'
  - "fix(client): read only a table row's own cells in widget tables (DOR-2981)"
  - 'fix(docs): show readers a quiet note where an embed cannot draw, and draw math in saved pages (DOR-2981)'
  - 'test(docs): prove the docs.enabled gate through the real server config (DOR-2981)'
---

### Added

- With the Docs experiment on, markdown docs can show charts, stats, tables, timelines and the other widgets agents draw in chat. Type `/` and pick one under Embeds, or write a line like `::chart{kind="bar" data='[{"label":"Mon","value":4}]'}` (DOR-2981)
- With the Docs experiment on, save a doc that lives in a file as one web page that opens in any browser, with its widgets and math (DOR-2981)

### Fixed

- A widget table with a column named like `constructor` no longer shows code in its cells (DOR-2981)
