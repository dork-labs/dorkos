---
title: 'Relay Mailbox Subject Folder Names: Direct Subject vs Hash'
date: 2026-03-21
type: implementation
status: active
tags: [relay, maildir, filesystem, subject, hash, directory-naming]
feature_slug: relay-subject-folder-names
searches_performed: 4
sources_count: 8
---

## Research Summary

The current relay implementation hashes subject strings (e.g. `relay.system.pulse.01KKE8QHFP41HTHD4A50TYW4NP`) into 12-character SHA-256 hex prefixes to use as Maildir directory names. The proposal is to use the subject string directly as the folder name. This is safe, desirable, and well-supported. DorkOS subject strings use only `[a-zA-Z0-9_-]` tokens separated by dots — exactly the POSIX portable filename character set. Path length is not a concern at realistic subject depths. The recommendation is **Approach 1: direct subject string as folder name**, with no sanitization step required.

## Key Findings

1. **Subject character set is already filesystem-safe**: The `validateSubject` function in `packages/relay/src/subject-matcher.ts` enforces `VALID_TOKEN_RE = /^[a-zA-Z0-9_-]+$/` for all literal tokens, separated by `.` dots. The only characters present in a concrete endpoint subject (wildcards `*` and `>` are forbidden for endpoints) are alphanumeric characters, hyphens, underscores, and dots — all safe on Linux, macOS, and Windows.

2. **Dots in directory names are universally safe**: POSIX explicitly permits dots in filenames. Only `.` (current directory) and `..` (parent) are reserved. A subject like `relay.system.pulse.01KKE8QHFP41HTHD4A50TYW4NP` starts with `relay`, not a dot, so no special handling is needed. Dots are how Maildir++ itself encodes folder hierarchies (e.g. `.Inbox.Subfolder`), making this approach idiomatic.

3. **Path length is not a concern**: Relay subjects are bounded at 16 tokens of `[a-zA-Z0-9_-]+` characters. The longest conceivable subject — 16 tokens of ~12 characters each — is approximately 200 characters plus separators, well under the universal 255-byte `NAME_MAX` limit for a single path component on ext4, APFS, and NTFS. Total path length (`~/.dork/relay/mailboxes/<subject>/new/<ulid>.json`) sits around 150–280 characters, far below the 4096-byte Linux `PATH_MAX` or macOS's 1023-character limit.

4. **NATS JetStream explicitly forbids dots in stream names for this reason**: JetStream prohibits dots, `>`, `*`, and path separators in stream and consumer names precisely because those names become filesystem directory components. DorkOS subjects are the opposite — they use dots as structural delimiters, not as arbitrary user input, and the validator ensures no other special characters can appear.

5. **No security or privacy concern with readable names**: Relay subjects follow a structured hierarchy (`relay.agent.*`, `relay.system.*`, `relay.inbox.*`) and are internal to `~/.dork/` — a directory only the owning user can read (`0o700` permissions are already enforced). There is no information leakage risk that would justify hashing. The hash currently provides no meaningful access control benefit because the mapping is in memory and the directory is owner-only.

6. **The hash breaks observability without adding value**: A human inspecting `~/.dork/relay/mailboxes/` currently sees opaque names like `a1b2c3d4e5f6/`. With direct subject names, they would see `relay.agent.myproject.backend/`, `relay.system.pulse.01KKE8QHFP41HTHD4A50TYW4NP/`, etc. — immediately interpretable without a lookup table. This directly serves DorkOS's developer-transparency goals.

7. **`EndpointInfo.hash` field and all callers use the hash as both a key and a directory name**: The current API threads `endpointHash` through `MaildirStore`, `DeliveryPipeline`, `WatcherManager`, `SqliteIndex`, `DeadLetter`, and `PublishResult`. Switching to subject-as-directory-name means the "hash" is simply the subject string itself. The `hashSubject()` function and `HASH_LENGTH` constant in `endpoint-registry.ts` would be removed; `EndpointInfo.hash` would become `EndpointInfo.subject` used directly (or the `hash` field would be set equal to `subject`).

## Detailed Analysis

### Filesystem Character Safety

DorkOS subject validation (`subject-matcher.ts`) is strict:

```
VALID_TOKEN_RE = /^[a-zA-Z0-9_-]+$/
```

Tokens joined by `.` produce strings containing only characters in the POSIX Portable Filename Character Set: `[A-Za-z0-9._-]`. This set is safe on every target filesystem:

- **Linux (ext4, btrfs, etc.)**: Only `/` (path separator) and `\0` (NUL) are forbidden. All subject characters are permitted.
- **macOS (APFS, HFS+)**: Same UNIX rules apply. The colon `:` is traditionally discouraged on HFS+ but subjects contain no colons.
- **Windows (NTFS)**: Forbids `< > : " / \ | ? *`. Subject characters contain none of these.

No additional sanitization is required.

### Path Length Analysis

Worst-case path constructed from a maximum-depth subject:

```
~/.dork/relay/mailboxes/relay.system.pulse.01KKE8QHFP41HTHD4A50TYW4NP.something.more.tokens.a.b.c.d/new/01JKABCDEFGHIJKLMNOPQRSTUV.json
```

| Component                                | Approximate length |
| ---------------------------------------- | ------------------ |
| `~/.dork/relay/mailboxes/`               | ~35 chars          |
| Subject (16 tokens × 13 chars + 15 dots) | ~223 chars         |
| `/new/`                                  | 5 chars            |
| `01JKABCDEFGHIJKLMNOPQRSTUV.json`        | 30 chars           |
| **Total**                                | **~293 chars**     |

All target OS limits:

- Linux `NAME_MAX`: 255 bytes per component — the subject itself stays under this
- Linux `PATH_MAX`: 4096 bytes — the full path is well under this
- macOS path limit: 1023 Unicode chars — well under this

The `MAX_TOKEN_COUNT = 16` limit in `subject-matcher.ts` provides an effective upper bound that makes length overflows structurally impossible.

### Comparison with Similar Systems

| System             | Approach                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Maildir++**      | Uses dot-prefixed folder names (`.Inbox.Subfolder`) — dots as hierarchy separators, directly in filesystem                   |
| **NATS JetStream** | Prohibits dots in stream/consumer names used as filesystem directories; uses sanitized names directly                        |
| **RabbitMQ**       | Uses SHA-256 hash of queue name for internal `.mnesia` storage paths — chosen because queue names allow arbitrary characters |
| **DorkOS Relay**   | Validated subjects with restricted character set — no hashing needed                                                         |

RabbitMQ hashes because queue names are user-supplied strings that may contain `/`, spaces, and unicode. DorkOS subjects are validated to a restricted character set before use, which is the correct architectural decision that makes the hash unnecessary.

### Impact Assessment

Switching to direct subject names affects the following call sites:

1. **`endpoint-registry.ts`**: Remove `hashSubject()`, remove `HASH_LENGTH`, set `maildirPath = join(mailboxesDir, subject)` and `hash = subject`.
2. **`maildir-store.ts`**: The `endpointHash` parameter is used only as a directory name segment — no logic change needed, just rename the parameter to `endpointId` or keep as-is with a comment.
3. **`types.ts`**: `EndpointInfo.hash` field — could remain as `hash: string` set equal to `subject`, or be renamed to clarify. `DeadLetter.endpointHash` field similarly.
4. **`delivery-pipeline.ts`**, **`watcher-manager.ts`**, **`sqlite-index.ts`**: All use `endpoint.hash` as a pass-through key — these work unchanged if `hash` is set to subject.
5. **Tests**: `maildir-store.test.ts` uses `TEST_ENDPOINT = 'abc123'` — this should become a realistic subject string like `relay.test.subject` to properly exercise the new path format.

The change is mechanical and low-risk. The in-memory registry already keys on `subject` — the hash is only used at the filesystem layer.

### Persistence / Migration Concern

If an existing `~/.dork/relay/mailboxes/` directory contains hash-named subdirectories, those directories will be orphaned after the change — the registry will no longer compute hash paths for them. For a dev-iteration project at this stage, the correct approach is to delete `~/.dork/relay/mailboxes/` on first run after the upgrade, or to document that users should run `dorkos relay reset` (or simply delete the directory manually). A migration script is not warranted given the ephemeral nature of relay mailboxes.

## Sources & Evidence

- `packages/relay/src/subject-matcher.ts` — `VALID_TOKEN_RE = /^[a-zA-Z0-9_-]+$/`, `MAX_TOKEN_COUNT = 16`
- `packages/relay/src/endpoint-registry.ts` — `hashSubject()`, `HASH_LENGTH = 12`, `maildirPath = join(mailboxesDir, hash)`
- [NATS JetStream Naming](https://docs.nats.io/running-a-nats-service/nats_admin/jetstream_admin/naming) — "Spaces, tabs, period (.), greater than (>) or asterisk (\*) are prohibited" in stream names used as filesystem directories
- [Filename - Wikipedia](https://en.wikipedia.org/wiki/Filename) — Linux/macOS only forbid NUL and `/`; Windows forbids `< > : " / \ | ? *`; 255-byte `NAME_MAX` is universal
- [Maildir - Wikipedia](https://en.wikipedia.org/wiki/Maildir) — Maildir++ uses dot-prefixed hierarchy directly in filesystem names
- [Linux Path Limits](https://linuxvox.com/blog/linux-max-path-length/) — `PATH_MAX = 4096` bytes; `NAME_MAX = 255` bytes per component on ext4
- [macOS Path Length](https://www.quora.com/What-is-the-maximum-length-of-a-filename-and-pathname-in-macOS) — APFS enforces 1023-character path limit, 255-character filename limit
- [Naming Files on Windows](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file) — forbidden characters list, MAX_PATH = 260 (removed in Win10 1607)

## Research Gaps & Limitations

- **Windows testing**: DorkOS currently targets macOS/Linux (CLI runs `~/.dork`). Windows compatibility is not a stated requirement, but the subject character set is Windows-safe anyway.
- **Case sensitivity**: macOS APFS is case-insensitive by default. Subjects are case-sensitive in the validator (`[a-zA-Z]` both cases allowed). If two subjects differ only by case (e.g. `relay.Agent.foo` vs `relay.agent.foo`), they would map to the same directory on a case-insensitive filesystem. This is an existing concern in the current codebase regardless of hashing — and in practice the DorkOS subject convention is all-lowercase tokens.

## Recommendation

**Use Approach 1: direct subject string as folder name.**

The subject validator already enforces a character set that is universally filesystem-safe. There is no security benefit to hashing, no path length risk, and significant observability benefit to using readable directory names. This aligns with how NATS itself recommends storing streams when names are constrained to safe characters, and with the Maildir++ convention of using meaningful folder names directly on the filesystem.

**Implementation steps:**

1. In `endpoint-registry.ts`: Remove `hashSubject()` and `HASH_LENGTH`. Change `registerEndpoint` to use `subject` directly as the directory name: `maildirPath = join(mailboxesDir, subject)`. Set `hash: subject` in `EndpointInfo` to preserve API shape without changing callers (the field becomes a no-op identity).
2. Optionally rename `EndpointInfo.hash` → `EndpointInfo.id` and update all call sites (this is a cleaner long-term change but requires more diffs).
3. Update `maildir-store.ts` JSDoc: change "endpointHash" parameter descriptions to "endpoint subject".
4. Update `maildir-store.test.ts`: replace `TEST_ENDPOINT = 'abc123'` with a real subject string like `relay.test.subject`.
5. Note in release notes that existing `~/.dork/relay/mailboxes/` directories with hash names should be deleted.

## Search Methodology

- Number of searches performed: 4
- Most productive search terms: "NATS JetStream stream directory naming filesystem storage subject", "filesystem directory name dots alphanumeric safe Linux macOS Windows path limits"
- Primary information sources: NATS official docs, Wikipedia (Filename, Maildir), Microsoft Learn, Linux filesystem documentation
