---
covers:
  - 'fix(server): search survives one broken source, and stops blocking the app (DOR-709, DOR-702)'
---

### Fixed

- Search keeps filling even when one of the places it reads breaks. If DorkOS could no longer read a folder or a program's history — the files moved, or it lost permission to open them — everything from that one place quietly stopped being added to search, and nothing told you. Now your search results say that part of your history could not be read, nothing already found is thrown away, and every other place carries on being added. (DOR-709)
- The app stays responsive while search catches up. Adding to the index used to hold up everything else until it finished, which is most noticeable the first time you run DorkOS, when there is a whole history to get through. It now works in small pieces and gives the app a turn between each one, so it fills in the background instead of in your way. (DOR-702)
