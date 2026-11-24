---
covers:
  - 'feat(api): extensions and packages answer errors as problem documents (DOR-4979)'
  - 'fix(api): review round 1 on the extensions-and-packages problem switch (DOR-4979)'
  - 'refactor(api): one error code per problem (DOR-4979)'
  - 'fix(api): review round 1 on the combined problem switch (DOR-4979)'
---

### Changed

- Errors from the extension, marketplace, MCP server, document, preview, upload, template, shape, agent browser and saved-file recovery routes now use the same standard format as the rest of the API, `application/problem+json`. Each one says what kind of problem it is in `code` (for example `person_only`, `conflict` or `not_found`) and what to do in `detail`. The `code` is the only one to check: there is no second, finer field. Error messages no longer repeat internal error text or file paths; the full text is in the server log (DOR-4979)
- A few of these errors now use a status that fits better (DOR-4979):
  - Restarting an extension that still needs approval is 403, not 409.
  - An extension whose own server fails to start is 502, not 400 or 409.
  - An upload path with a null character in it is 400, not 403.
  - A package offer that can't be saved is 500, and one for a project that can't take it is 409, not 422.
  - Anything refused because it changed since you looked is 412 `precondition_failed`, not 409: an extension waiting to be turned on or a set of them, a package install or update, a dev link folder, a question from an extension, a document route or its work, an MCP server changed since its sheet was shown, and a page, its history or the sign-ins folder in the agent browser.
  - A mini app starting work for an extension that is missing or turned off is 409 `not_running`; a folder outside every project stays 404 `not_found`.
  - A room a mini app may not use is 403 `room_not_allowed`, not `forbidden`.
  - The answer for an update a person said no to (403 `declined`) no longer carries a `reason` field: read `detail`.

### Note for people upgrading

- **This is a breaking change for scripts that call these routes directly.** The old `error` and `message` fields are gone: read `code` for the kind of problem and `detail` for the message. Codes are now all lowercase with underscores, and many older codes became shared ones: for example `extension_person_required`, `operator_cookie_required` and `operator_only_config` are now `person_only`, `needs_person_at_this_computer` is `operator_only`, `interaction_already_resolved` is `already_resolved`, `disclosure_changed` and `schedule_review_changed` are `precondition_failed`, `template_needs_review` is `needs_review`, `invalid_input` is `invalid_request`, and `OUTSIDE_BOUNDARY` is `outside_boundary`. Capability errors (`/api/capabilities`) keep their old format for now. The DorkOS app, the `dorkos` command and extensions built with the extension API already read the new format (DOR-4979)
