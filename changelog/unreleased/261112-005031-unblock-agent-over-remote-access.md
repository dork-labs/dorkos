---
covers:
  - 'fix(server): folders and names travel outside the address path, so Unblock agent works over Remote Access (DOR-4212)'
---

### Fixed

- **Unblock agent works over Remote Access again.** In 0.135.6 it failed from another device, over both DorkOS's remote access and your own ngrok tunnel. That known issue is fixed (DOR-4212).
- Over Remote Access, a picture you attached in a chat now shows when DorkOS runs on Windows, and you can refresh or remove a marketplace source saved by an older DorkOS whose name holds a `/` (DOR-4212).

### Changed

- For scripts: `DELETE /api/mesh/denied/{encodedPath}` is now `DELETE /api/mesh/denied?path=<folder>`. The marketplace source routes also take the name as `?name=`: `DELETE /api/marketplace/sources?name=` and `POST /api/marketplace/sources/refresh?name=`. The old source routes still work (DOR-4212).
