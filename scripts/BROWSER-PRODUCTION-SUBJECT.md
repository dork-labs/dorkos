# Managed browser qualification subject

`browser-production-subject.ts` computes a production subject for the compiled
CLI and Desktop server. An accepted catalogue entry must match this digest as
well as the actual executable, native observer, controller, verifier, platform,
channel, selected identity mode, and policy revisions. The shipped catalogue is
empty until qualification receipts have been reviewed. Installing or verifying
runtime files cannot add an entry.

The subject includes the complete browser engine/native installation sources
(including C), server browser policy/registry/owner/HTTP/tool/stream code, managed
viewer code, browser transport, experiment controls, and the real auth/config/
origin/grant dependencies reached by runtime imports. Shared browser DTOs,
configuration schema, and the transport contract are explicit entry points.
The actual database migration SQL and runtime journal are included because the
auth/profile database migrator consumes them at boot; generator snapshots are
excluded. Literal imports, dynamic imports, and require calls are followed to original
source, including `.js` source conventions and workspace export mappings. Named
barrel imports follow the requested exports; type-only links to independent
application domains do not add their implementations. Missing source or a
missing dependency identity refuses the build subject rather than omitting it.

Server, client, and Desktop composition roots and build/signing configuration
are bound as wiring bytes. Their independent agent runtime, marketplace, room,
site, and CI callees are not recursively swept into browser qualification. The
browser callees are separately covered by the domain roots and runtime closure.
These composition files are conservative boundaries: changing their wiring
requires review even if the change appears unrelated to the browser. Changes in
an independent source module that this closure does not reach remain stable.

Workspace package versions/module kind and the exact selected export mappings
are bound. For external imports, the selected importer resolution and the
transitive lock package/snapshot records (including integrity, peer resolution,
and optional native variants) are bound. Unused dependencies and unrelated lock
entries are excluded. The dynamically owned Playwright library and the existing
TypeScript, YAML, esbuild, Electron and packaging build dependencies are explicit
pinned inputs. Their versions cannot silently change behind the subject.

Generated outputs, tests/fixtures, evidence reports, documentation, site code,
CI source, and `accepted-catalogue.ts` are excluded. Catalogue publication is the
only authority-bearing metadata exclusion: it prevents a receipt from needing
the hash of its own catalogue entry. It does not exclude the reader, schema,
qualification bootstrap, or any browser policy code. Catalogue-only publication
therefore keeps the qualified production subject stable, while policy/source or
selected dependency changes invalidate it.

The four source controls construct actual owned source trees and lock records:
policy edits change the digest; unrelated source and catalogue-only edits do
not; real transitive imports are included while unrequested barrel callees are
excluded; unresolved imports refuse; and selected dependency integrity changes
invalidate without unrelated lock churn. They are authored controls, not native
qualification receipts.

## Runtime compatibility scope

Catalogue admission binds an exact runtime class, rather than a customer's host
executable hash. The class includes original Node version, module ABI, V8,
OpenSSL and libuv versions, platform/architecture, optional Electron version and
the versioned browser-owner primitive availability contract. No version range
authorizes a class. The CLI engine minimum is only an eligibility check; the
empty catalogue still refuses every ordinary production class.

The local original Node/Electron executable remains hashed, retained and freshly
verified by the installation/custody code. These checks were not changed. The
release subject's native journal digest now binds the exact distributed observer
artifact and source vintage; exact original runtime class is a separate required
subject field. Changing the observer artifact or any class field invalidates the
record, while a different executable location or packaging signature alone does
not identify a different compatibility class.

Primitive availability is not behavioral qualification. Before accepting a
class, retain complete mode-specific gate receipts on at least two independently
built/signed original Node distributions reporting that exact class. Verify
original worker creation/stdio cancellation and joins, bigint file identity and
close retention, callback DNS cancellation ordering, abort composition, TLS/H2
and native lifecycle/input/render semantics. Record the actual executable hashes
in each private receipt for provenance. Include missing-primitive, altered ABI/
V8/OpenSSL/libuv/version/platform and wrong-observer negatives, and preserve all
first-failure and physical-return observations. Electron needs its own genuine
signed-app distribution and shutdown gates. These receipts are unrun; no class
has been populated. Broad compatible patch ranges require separately reviewed
class evidence and are not implied by this implementation.

This resolves the consumer key's per-customer executable uniqueness, but does
not establish that every build advertising the same class has qualified. The
reviewed runtime contract and collected receipts are still a production delivery
requirement. Private qualification remains explicitly unaccepted and can exercise
new exact original classes without self-issuing a ready record.
