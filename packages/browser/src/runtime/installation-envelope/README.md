# Private installation envelopes

This leaf implements the ratified `63ed3fa3` envelope contract using portable,
fixture-only authority. It has no supported production constructor, installer,
runner, filesystem port, readiness check, reservation implementation, public
export, or CLI wire. No returned fixture result proves an installed runtime.

`createFixtureEnvelopeDomain` returns separate `issuer` and `domain` capabilities.
The trusted mock harness keeps `issuer`: it registers immutable jobs, independently
observes bounded facts, and issues publication observations. A consumer receives
opaque object references. Weak-map membership authenticates them within this one
fixture owner; equality of JSON, hashes, bindings, or caller booleans does not.
Every projection says `fixture-only` and readiness `unavailable`. Structural
schemas may recognize `accepted-runner` for contract validation, but this leaf
never issues that provenance. Public projections cannot reenter composition.

## Private registered-job projection

The field table below is an implementation choice inside this leaf, not a new
wire schema or accepted backend. The fixture issuer supplies the closed SHA256
identities independently of runner bytes; real derivations remain unavailable
until a separately reviewed production registry exists.

| Field                                            | Fixture meaning / intended later derivation                            |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| `kind`                                           | `official-install` or `fresh-verifier`; at most one of each registered |
| `binding`                                        | Exact five-field JobBinding, including original nonce and generation   |
| `packageDigest`                                  | Exact pinned package identity, not a caller-selected executable        |
| `sourceDigest`                                   | Exact pinned source/distribution identity                              |
| `entryDigest`                                    | Exact registered entry bytes                                           |
| `environmentDigest`                              | Exact trusted environment policy and values                            |
| `backendDigest`                                  | Exact separately accepted custody/enforcement backend identity         |
| `candidateDigest`                                | Exact registered candidate identity chain                              |
| `expectedReply`                                  | Closed pinned fresh reply expectation, including relative executable   |
| owner `origin`, `workEnd`, `finalEnd`, job `end` | Original cooperative clock observation and immutable absolute bounds   |

Canonical hashing streams sorted record keys, ordered arrays, type tags, and
length-prefixed scalars. It does not serialize a whole receipt for hashing. The
job digest includes the projection and original bounds; fresh evidence binds the
exact reply bytes, canonical reply, independent certified runner facts, accounting
prefix, and registered job digest. Matching any digest remains insufficient to
issue a reference. No production policy/environment is inferred from mock values.

Fixture duration and metric ceilings must all be explicit; there are no runtime
defaults. The verifier end is the smaller of original workEnd and its registration
clock sample plus explicit fixture verifierDuration. Cleanup uses original
finalEnd. Cooperative checks do not provide physical deadline enforcement.

## Intake and representation ownership

`BytePort` is a trusted **mock bounded producer** prerequisite. Before invocation,
the fixture harness must guarantee no hidden unbounded buffering/prefetch and
exact delivery-specific close acknowledgement. There is no actual producer
adapter here. Two precharged 65536-byte buffers serve every delivery, including
its accounted overflow byte. `read` receives only the requested buffer view.
Accessor-bearing transfer replies are refused without invoking accessors.
An exact close acknowledgement alone cannot refund a still-held read promise.
Unknown ACKs, throws, clock failures, or unresolved reads retain their phase.
No retired owner admits a successor or upgrades late data into verified evidence.

Before decode, scanning, parse, or copying, the complete runner/reply/local phase
is reserved (1048576/131072/524288 logical units). Dropped runner working data
retains 393216 units; reply snapshot retains 24576. Two runner snapshots, reply,
and local composition coexist at 1335296 units. The 131072 raw-storage budget is
separate from the 2097152 logical representation budget. Neither is a heap/RSS,
physical producer-memory, throughput, or accepted runtime-capacity claim.

The iterative scanner bounds depth, member count, decoded strings, and numbers;
it compares prior decoded keys with bounded rescans instead of retaining a token
tree or every key. Raw JSON is decoded fatally and fully scanned before parse.
Raw reply framing operates on the already charged byte view. Schema copies are
made once. Trusted producer records must be prebounded own data **before entry**;
no arbitrary object constructor traverses an unbounded record first. Guarded
facades obtain each data descriptor under post-observation owner checks, avoiding
external getters during schema copy. At most 256 compound facades fit the fixed
65536-unit cursor overhead (closed schema compound counts are below this); text
and member payload remain charged in their representation phase. This is a
private implementation bound, not an accepted process/runtime limit.

Independent witness issuance reserves a runner phase, validates and digests the
mock facts, then drops the full record. At most 64 compact witness identities are
issued. Stored witnesses retain a digest and exact issuer/job association, not a
receipt history. The terminal public projection is memoized once; joins return its immutable alias.
Compact metadata stays within retained snapshot ceilings; if no working or
retained payload phase remains, its already specified 65536-unit fixed overhead
is retained before terminal metadata allocation. One current progress snapshot per job is invalidated/dropped
before its later settled delivery. Accounting remains one cumulative ledger,
with at most 64 exact PID/birth/acquisition identities; closed ancestry survives
job changes. Unknown metrics never turn into zero.

## Composition and failure

An authentic fresh verifier envelope plus an authentic publication reference is
required for verified reuse. Installation also needs an authentic successful
installer envelope. All required fields, cumulative observations, pinned reply,
final candidate, manifest, current pointer, and local path observations must
match. The fixture issuer can independently replace the current pointer after
issuing its observation; an old reference then fails composition.

A known failed envelope can compose a refused result; unknown closure or
publication/reservation composes uncertainty without local evidence. `failure()`
reports a retired delivery as memoized uncertainty with charged acquisition
intents and unknown metrics. It never manufactures closure, observed zero,
installed evidence, or later success. A projection remains readable after owner
retirement because it reads only its authentic immutable result. `observe` and
publication capabilities are mock claims, not kernel/installed-file verification.

The caller's prebounded producer obligation cannot be established by parsing its
own flag. It is a fixture-only trusted capability precondition. Real producer
buffering, physical acquisition/custody, installed library assets, packaged fresh
verifier, reservation/publication, complete inventories, and actual runtime
numeric limits are all unavailable. Full tasks 5.6 and 8.1 remain unverified.
