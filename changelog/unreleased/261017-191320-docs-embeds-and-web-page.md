---
covers:
  - 'feat(shared): add the Docs embed catalog, decoded from string attributes into gen-UI widget nodes (DOR-2981)'
  - 'feat(client): draw charts, stats and tables in markdown docs, and save a doc as a web page (DOR-2981)'
  - 'feat(server): teach agents the markdown embed syntax and its escape (DOR-2981)'
---

### Added

- With the Docs experiment on, markdown docs can show charts, stats, tables, timelines and the other widgets agents draw in chat. Type `/` and pick one under Embeds, or write a line like `::chart{kind="bar" data='[{"label":"Mon","value":4}]'}` (DOR-2981)
- With the Docs experiment on, save a file-backed doc as one web page, widgets included, that opens in any browser (DOR-2981)
