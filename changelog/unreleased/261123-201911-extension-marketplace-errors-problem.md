---
covers:
  - 'feat(api): extensions and packages answer errors as problem documents (DOR-4979)'
---

### Changed

- Errors from the extension, marketplace, MCP server, document, preview, upload, template, shape, agent browser and capability routes now use the same standard format as the rest of the API, `application/problem+json`. Each one says what kind of problem it is in `code` (for example `person_only`, `conflict` or `not_found`) and what to do in `detail`. When the app needs a finer reason, it is in `reason` (for example `stale_approval`). Error messages no longer repeat internal error text or file paths; the full text is in the server log (DOR-4979)
- A few of these errors now use a status that fits better (DOR-4979):
  - Restarting an extension that still needs approval is 403, not 409.
  - Setting up an extension's server when it fails to start is 409, not 400.
  - An upload path with a null character in it is 400, not 403.
  - A failed package offer is 500, not 422.

### Note for people upgrading

- **This is a breaking change for scripts that call these routes directly.** The old `error` and `message` fields are gone: read `code` for the kind of problem and `detail` for the message. Codes are now all lowercase with underscores, and many older codes became shared ones: for example `extension_person_required` is now `person_only`, `operator_only_config` on these routes is `operator_only`, `invalid_input` is `invalid_request`, and `OUTSIDE_BOUNDARY` is `outside_boundary`. The DorkOS app, the `dorkos` command and extensions built with the extension API already read the new format (DOR-4979)
