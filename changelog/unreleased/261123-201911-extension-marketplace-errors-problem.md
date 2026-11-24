---
covers:
  - 'feat(api): extensions and packages answer errors as problem documents (DOR-4979)'
  - 'fix(api): review round 1 on the extensions-and-packages problem switch (DOR-4979)'
---

### Changed

- Errors from the extension, marketplace, MCP server, document, preview, upload, template, shape, agent browser and saved-file recovery routes now use the same standard format as the rest of the API, `application/problem+json`. Each one says what kind of problem it is in `code` (for example `person_only`, `conflict` or `not_found`) and what to do in `detail`. When the app needs a finer reason, it is in `reason` (for example `stale_approval`). Error messages no longer repeat internal error text or file paths; the full text is in the server log (DOR-4979)
- A few of these errors now use a status that fits better (DOR-4979):
  - Restarting an extension that still needs approval is 403, not 409.
  - An extension whose own server fails to start is 502, not 400 or 409.
  - An upload path with a null character in it is 400, not 403.
  - A package offer that can't be saved is 500, and one for a project that can't take it is 409, not 422.

### Note for people upgrading

- **This is a breaking change for scripts that call these routes directly.** The old `error` and `message` fields are gone: read `code` for the kind of problem and `detail` for the message. Codes are now all lowercase with underscores, and many older codes became shared ones: for example `extension_person_required` is now `person_only`, `operator_only_config` on these routes is `operator_only`, `invalid_input` is `invalid_request`, and `OUTSIDE_BOUNDARY` is `outside_boundary`. Capability errors (`/api/capabilities`) keep their old format for now. The DorkOS app, the `dorkos` command and extensions built with the extension API already read the new format (DOR-4979)
