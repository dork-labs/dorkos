---
covers:
  - 'fix(server): MCP server arguments hide a password with no scheme, well-known key shapes, and anything too long to read (DOR-3846)'
---

### Fixed

- In Connections → MCP servers, an argument like `user:password@db-host/app` now shows as `•••@db-host/•••`, and a key on its own in a well-known shape (a GitHub, OpenAI, Anthropic, Slack, GitLab or AWS key, or a sign-in token) shows as `•••`. A very long argument is hidden whole, so the list stays fast. Add still warns when arguments look like they hold a secret. (DOR-3846)
