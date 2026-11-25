---
covers:
  - 'feat(api): capabilities serve their own REST paths, starting with agent pause and MCP servers (DOR-4978)'
  - 'feat(api): a person on Wi-Fi can still pause an agent, but not resume one (DOR-4978)'
  - "fix(api): capability paths are classified in every write census, and documented with the dispatcher's standard answers (DOR-4978)"
---

### Changed

- The API now really answers at the paths its document lists for an agent's MCP servers, such as `GET /api/agents/{agentId}/mcp-servers`. Before, those paths were only described, and the app reached the same actions another way. The app now uses them.
- Pausing and resuming an agent over the API now follows the same rules as every other agent action, and accepts an approval in the `X-DorkOS-Approval` header. A device signed in over Wi-Fi can still pause an agent, since that only stops it, but it cannot resume one. The paths stay the same.
- Nothing was removed. A script that pauses an agent or manages its MCP servers through `POST /api/capabilities/{id}/invoke` still works, and that endpoint is now in the API document too.
- Through that invoke endpoint, a refusal because something was not found now answers `404` instead of `400`, and a refusal because the caller may not do it (such as an agent resuming its own pause) answers `403`. A refusal with the code `NOT_READY`, because something is still starting, now answers `503` instead of `400`, so a script can wait and try again. The body is unchanged.
