---
covers:
  - 'feat(api): chats, agents, rooms and work answer errors as problem documents (DOR-4979)'
---

### Changed

- More of the DorkOS API now answers errors in the standard `application/problem+json` format: chats, agent programs, agents and the team, rooms and direct chats, profiles, tasks, to-dos, the work queue, terminals, diffs, notifications, activity and settings. Each answer carries `code`, the kind of problem, and `detail`, a sentence about what went wrong (DOR-4979)

### Note for people upgrading

- **This is a breaking change for scripts that call these parts of the API directly.** The old `error` field is gone from their error answers: read `code` for the kind of problem and `detail` for the message. Codes are now lower case with underscores. Extra facts, such as which agent is paused, sit beside `code` in the same answer. The DorkOS app, the `dorkos` command and the desktop app already read the new format (DOR-4979)
- **Codes that kept their meaning, now lower case:** `SESSION_LOCKED` is `session_locked`, `TERMINAL_LIMIT` is `terminal_limit`, `TASK_NOT_RUNNING` is `task_not_running`, `AGENT_PAUSED` is `agent_paused`, `QUEUED_MESSAGE_NOT_FOUND` is `queued_message_not_found`, `QUEUED_MESSAGE_LAUNCHING` is `queued_message_launching`, `AVATAR_MISSING` is `avatar_missing`, `AVATAR_TYPE_UNSUPPORTED` is `avatar_type_unsupported`, `ROOM_REPO_EXISTS` is `room_repo_exists`, `DESK_NOT_OWN` is `desk_not_own`, `PROTECTED_FOLDER` is `protected_folder`, `ROOM_SESSION_MOVED` is `room_session_moved`, `REPORTS_TO_CYCLE` is `reports_to_cycle`, and `SESSION_NOT_FOUND` is `session_not_found` (DOR-4979)
- **Codes folded into a shared one** (`detail` still says which):
  - `invalid_request` (400): `INVALID_SESSION_ID`, `VALIDATION_ERROR`, `INVALID_COMMAND_INTENT`, `INVALID_DAYS`, `INVALID_LEVEL`, `INVALID_MESSAGE_ID`, `INVALID_SEARCH_QUERY`, `INVALID_URI`, `UNKNOWN_SEARCH_SOURCE`, `UNSUPPORTED_MODEL`, `ATTACHMENT_ID_INVALID`, `ATTACHMENT_MISSING`, `AVATAR_ID_INVALID`, `NOT_A_CHAT_MESSAGE`, `RECORDING_MISSING`, `UNSAFE_WORKSPACE_SOURCE`, and a path with a NUL byte in it (`NULL_BYTE`, which some routes answered with 403).
  - `request_too_large` (413): `BATCH_TOO_LARGE`, `RECORDING_KEYFRAME_TOO_LARGE`.
  - `not_found` or `session_not_found` (404): `NO_PENDING_APPROVAL`, `NO_PENDING_QUESTION`, `NO_PENDING_ELICITATION`, `NO_MCP_CONTEXT`, `SERVER_CONFIG_UNAVAILABLE`, `RECORDING_NOT_PENDING`, `NO_BASELINE`, `AVATAR_NOT_FOUND`, `HISTORY_CURSOR_UNKNOWN`, and `SESSION_CWD_REQUIRED`.
  - `person_only` (403): `PERSON_ONLY`, `PEOPLE_ONLY`, `NOT_A_PERSON`, `SIGNIN_NEEDS_PERSON`, `SESSION_LOCATION_PERSON_REQUIRED`, `operator_cookie_required` and `operator_only_config`.
  - `operator_only` (403): `NEEDS_PERSON_AT_THIS_COMPUTER`, `SESSION_RELAY_NEEDS_THIS_COMPUTER`, `NOTIFICATIONS_OPERATOR_ONLY`, `OPERATOR_ONLY`.
  - `forbidden` (403): `LIMITED_TURN`, `APPROVALS_REQUIRE_SEPARATE_CONFIRMATION`, and a missing or wrong password for linking (`SESSION_RELAY_PASSWORD`).
  - `conflict` (409): `QUEUED_MESSAGE_NOT_YOURS`, `NOT_LINKED`, `LINK_CHANGED`, `NOT_AVAILABLE`, `RECORDING_RETIRED`, `SESSION_LOCATION_LIMIT`, `SESSION_ID_CONFLICT`, `NOT_A_DIRECT_CHAT`, `NO_ACTIVE_QUERY`, `looser_than_proposed`.
  - `not_supported` (501): `COMMAND_INTENT_UNSUPPORTED`, `NOT_SUPPORTED`.
  - `already_resolved` (409): `INTERACTION_ALREADY_RESOLVED`.
  - `internal_error` (500): `CONTINUE_ERROR`, `FORK_ERROR`, `FORK_FAILED`, `LIMIT_HISTORY_ERROR`, `MEMBER_ROOMS_FAILED`, `TEAM_ROSTER_FAILED`, `RECORDING_WRITE_FAILED`, `STOP_TASK_ERROR`, `ATTACHMENT_READ_FAILED`, `AVATAR_STORE_FAILED`; a full disk while moving a backup is `internal_error` with status 507 (it was `insufficient_storage`).
  - `temporarily_unavailable` (503): `RELOAD_ERROR`, `RELOAD_TIMEOUT`, `ROOMS_UNAVAILABLE`.
  - `upstream_unavailable` (502): a scheduled run's stop that nothing confirmed (it was 502 `temporarily_unavailable`), and an MCP app the tool server did not send.
  - `needs_review` (409): `template_needs_review`, `workspace_needs_review`, `remove_hooks_need_review`.
- **Status changes on these routes:** anything refused because it changed since you looked is now 412 `precondition_failed`, not 409. That covers a schedule under review (`schedule_review_changed`), a scheduled task that changed while you confirmed (`TASK_CHANGED`), a task file that changed since the cap you saw (`file_changed_since`), an agent changed while you confirmed (`AGENT_CHANGED`), where a Claude account may work (`ACCOUNT_RULES_CHANGED`), the local API token settings (`TOKEN_CHANGED`), a config backup that changed, a to-do or promise no longer in the state you saw, a held-back package decision and its kept files, and an agent created from a package that changed what it runs (`disclosure_changed`). A path with a NUL byte is now 400, not 403 (DOR-4979)
