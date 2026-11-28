---
covers:
  - 'feat(api): fourteen API paths name a thing instead of an action (DOR-4982)'
---

### Changed

- Fourteen API addresses now name a thing instead of an action. The app already uses the new ones. If you call the DorkOS API from your own scripts, change these calls. The old addresses now answer "not found".

  | Before                                                         | Now                                                                                   |
  | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
  | `GET /api/audit/verify`                                        | `GET /api/audit/integrity`                                                            |
  | `GET /api/documents/resolve`                                   | `GET /api/documents/lookup`                                                           |
  | `GET /api/projects/resolve`                                    | `GET /api/projects/lookup`                                                            |
  | `GET /api/workspaces/scan`                                     | `GET /api/workspaces/disk-checkouts`                                                  |
  | `GET /api/hub/computers/{computerId}/sessions/{id}/stream`     | `GET /api/hub/computers/{computerId}/sessions/{id}/events`                            |
  | `PATCH /api/notifications/{id}/read`                           | `PATCH /api/notifications/{id}` with `{ "read": true }`                               |
  | `POST /api/notifications/read-all`                             | `PATCH /api/notifications` with `{ "read": true }`                                    |
  | `POST /api/config/backups/{name}/move`                         | `PATCH /api/config/backups/{name}` with the same `{ "destination" }`                  |
  | `POST /api/tasks/runs/{id}/cancel`                             | `PATCH /api/tasks/runs/{id}` with `{ "status": "cancelled" }`                         |
  | `POST /api/sessions/{id}/continue/cancel`                      | `DELETE /api/sessions/{id}/continue`                                                  |
  | `POST /api/todo-promises/{id}/confirm`                         | `PUT /api/todo-promises/{id}/confirmation` with the same `{ "answer" }`               |
  | `POST /api/workbench/probe`                                    | `POST /api/workbench/port-checks`                                                     |
  | `POST /api/agents/{agentId}/work-queue/items/{itemId}/requeue` | `PATCH /api/agents/{agentId}/work-queue/items/{itemId}` with `{ "status": "queued" }` |
  | `PUT /api/work-queues/stop`                                    | `PUT /api/work-queues/stopped`                                                        |

- Who may use each one, and what it does, has not changed. Some operation names in the API document changed with them, so a client built from the document needs rebuilding.
