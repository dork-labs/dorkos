---
covers:
  - 'feat(api): file and folder routes answer errors as problem documents (DOR-4979)'
  - 'fix(api): review round 1 on the file and folder problems (DOR-4979)'
---

### Changed

- Errors from the file routes (`/api/files`: reading, saving, creating, deleting, moving, copying and showing files) and the folder picker (`/api/directory`) now use the same standard format as the rest of the API, `application/problem+json`. Each one says what kind of problem it is in `code` and what to do in `detail`. Error messages no longer repeat internal error text or file paths; the full text is in the server log (DOR-4979)
- A few of these errors now answer differently (DOR-4979):
  - Saving a file that changed since you opened it is 412 `precondition_failed`, not 409. It still carries `currentHash` and `currentContent`, so the app can show both versions.
  - Listing the files in a folder whose path has a null character in it is 400, not 403, like every other file route.
  - A canvas save refused by one of its checks no longer carries a `reason` field: `detail` says which check refused it.

### Note for people upgrading

- **This is a breaking change for scripts that call these routes directly.** The old `error` field is gone: read `code` for the kind of problem and `detail` for the message. The codes changed too: `CONFLICT` is `already_exists` (or `precondition_failed` for a save), `NOT_FOUND` is `not_found`, `DIR_NOT_EMPTY` is `folder_not_empty`, `COPY_INTO_SELF` is `copy_into_self`, `REFUSE_ROOT` is `working_folder_root`, `NOT_A_DIRECTORY` is `not_a_folder`, `NOT_A_FILE`, `TOO_LARGE` and `BINARY_FILE` are `not_a_file`, `too_large` and `binary_file`, `UNSUPPORTED_TYPE` is `unsupported_media_type`, `RANGE_NOT_SATISFIABLE` is `range_not_satisfiable`, `OUTSIDE_BOUNDARY` is `outside_boundary`, `NULL_BYTE` and a path that can't be followed are `invalid_request`, `EACCES` is `forbidden`, `REVEAL_UNAVAILABLE` is `internal_error`, `FILE_IDENTITY_CHANGED` and `DOC_SAVE_ID_CONFLICT` are `precondition_failed`, `DOC_SAVE_FAILED` is `save_not_applied`, `DOC_SAVE_IN_DOUBT` is `temporarily_unavailable` and `CANVAS_DOCUMENT_NOT_FOUND` is `not_found`. The folder picker's errors, which had no code before, now carry one. The DorkOS app already reads the new format (DOR-4979)
