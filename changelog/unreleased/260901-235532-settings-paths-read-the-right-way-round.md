---
covers:
  - 'fix(client): settings screens stop reversing the ends of a file path (DOR-1686)'
---

### Fixed

- Long file paths in Settings read the right way round again. The Server and Advanced screens shorten a path from the front, so you keep the folder name at the end instead of losing it. That was also moving the slash at the start of the path to the far right, so `/Users/kai/.dork` was drawn as `Users/kai/.dork/`. On the Server screen, a path ending in a dot or a dash had that character moved to the far left too (DOR-1686)
