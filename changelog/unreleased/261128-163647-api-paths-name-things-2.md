---
covers:
  - 'feat(api): thirteen more API paths name a thing, and the two folder scans become one (DOR-4982)'
---

### Changed

- Thirteen more API addresses now name a thing instead of an action. The app and the `dorkos` command already use the new ones. If you call the DorkOS API from your own scripts, change these calls. The old addresses now answer "not found".

  | Before                                                   | Now                                                                          |
  | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
  | `POST /api/harness/sync`                                 | `POST /api/harness/syncs`                                                    |
  | `POST /api/shapes/{name}/apply`                          | `POST /api/shapes/{name}/applications`                                       |
  | `POST /api/your-browser/scan`                            | `POST /api/your-browser/profile-scans`                                       |
  | `POST /api/marketplace/packages/{name}/update`           | `POST /api/marketplace/packages/{name}/update-checks`                        |
  | `POST /api/marketplace/dev-links/preview`                | `POST /api/marketplace/dev-links/previews`                                   |
  | `POST /api/marketplace/dev-links/{name}/unlink`          | `DELETE /api/marketplace/dev-links/{name}?scope=&projectPath=`               |
  | `POST /api/marketplace/sources/{name}/refresh`           | `POST /api/marketplace/sources/refreshes` with `{ "name" }`                  |
  | `POST /api/marketplace/sources/refresh?name=`            | `POST /api/marketplace/sources/refreshes` with `{ "name" }`                  |
  | `POST /api/mesh/deny`                                    | `POST /api/mesh/denied`                                                      |
  | `GET /api/rooms/{id}/export`                             | `GET /api/rooms/{id}/history`                                                |
  | `POST /api/rooms/{id}/files/upload`                      | `POST /api/rooms/{id}/files`                                                 |
  | `POST /api/rooms/{id}/files/move`                        | `PATCH /api/rooms/{id}/files` with the same `{ "from", "to", "baseCommit" }` |
  | `POST /api/rooms/{id}/files/delete`                      | `DELETE /api/rooms/{id}/files?path=&baseCommit=`                             |
  | `POST /api/discovery/scan` and `POST /api/mesh/discover` | `POST /api/discovery/scans`                                                  |

- Scanning folders for agents now has one address. `POST /api/discovery/scans` sends what it finds as it walks, as a stream of events. The old `POST /api/mesh/discover` answered once at the end; use the stream instead. Agents still scan with the `mesh_discover` tool.
- Who may use each one, and what it does, has not changed. Some operation names in the API document changed with them, so a client built from the document needs rebuilding.
