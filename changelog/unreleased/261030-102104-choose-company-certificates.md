---
covers:
  - 'feat(settings): choose company certificates with a file picker, and restart from the row (DOR-3361)'
  - 'fix(settings): the certificates row names the file a restart will load, and refuses other windows'' file dialogs in a test (DOR-3361)'
  - 'fix(settings): the empty-file line uses the designer''s copy (DOR-3361)'
---

### Changed

- In the Mac app, pick your company's certificate file with **Choose…** in Settings → Server → Network, instead of typing its path. The row shows how many certificates DorkOS trusts and which file they come from. After you pick a new file or stop using one, it says what's still in use and offers **Restart** to switch. (DOR-3361)
