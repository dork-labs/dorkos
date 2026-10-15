# Local Playwright browser implementation

Status: In progress. Tracked work: DOR-2929.

Current delivery gate (2026-10-15 03:00 UTC): source remains uncommitted;
no branch push or PR exists. Isolated installed CLI and packaged desktop proofs
passed on earlier source snapshots. Final panel/PiP composition awaits the panel
owner's protected main merge. Latest metadata/privacy and review fixes still need
fresh tests, types, installed-package repetition and independent final review.
Native Chrome permission remains unproved; Edge, Windows and Linux are unproved.

Worktree: `/Users/doriancollier/.codex/worktrees/local-playwright-browser/dorkos`
Branch: `codex/local-playwright-browser`
Baseline: `76bae7b6e4b9f5f2c2e1d3314e6fbb0bd75e3748`

## Scope and ownership

The human chose Playwright and exactly three local modes. No VM, streaming, model
calls, spending, credential copying, installed-app changes, or old paused programme
work is authorized. Bounded owner coordination is authorized. Native and heavy work
uses the existing exclusive workspace marker when available.

- `local_browser_service`: service/backend/schema, human routes and scoped tools.
- `browser_ui`: three choices, plain setup, transport, geometry and entry.
- Root: native view/page transport, authenticated bridge, boot, packaging and proof.
- `scope_artifacts`: specification/tasks, independent implementation review; now
  isolated installed-CLI proof only. Empty model bindings use harness default.

Agent tools bind to the direct chat and selected tab. Screenshots use real MCP image
blocks. Observation-time node identity fences actions. Pause stops admission, while
dispatched uncertainty is recorded without replay. Journals fsync each phase and exclude typed values, page titles, and
URL queries. The superseded hidden-browser offer is removed; configured custom
servers and saved sign-ins are preserved.

## Evidence so far

- Exact Playwright 1.63.0 controls Electron 41.10.7 / Chromium 146 through production
  transport: one live view, shell excluded, native mouse/keyboard and automation
  reach the same page.
- Real visible Chromium 153: service actions, pause/stale refusals, saved page state
  survives close/reopen. No model/account calls.
- Installed CLI proof uses a real npm tarball outside the checkout, Playwright
  1.63.0, automatic Chromium 153 acquisition, persistent fixture cookie across
  server restart, unavailable installer proxy on cached reopen, web embedded
  refusal, consent requirement, and a test-owned attachment that leaves its tab
  intact on detach. Receipt: `.dork/local-browser/cli-proof/1792024298649/receipt.json`.
  SHA256: `72576488b44b6d76c87d33127c6c73b0ad236bfc6dd36d6c0540af2d3cc920e9`.
- Installed Chrome 155.0.8059.40 with a throwaway profile: Playwright 1.63.0
  CDP attachment with `noDefaults:true`, real fill/click/reload, and detach that
  preserves the same live page. No personal browser/profile touched. Native
  channel consent remains a separate gap.
- Fresh root service/transport tests: 27 passed. Registry/docs/permission/capability
  conformance tests: 126 passed after normal dependency-gated composition.
- Service worker: 21 tests and scoped lint pass after expanded controls and audit.
- UI worker: 62 tests, client typecheck, lint and copy-length pass after cleanup.
- Server typecheck passes with an 8GB heap and fresh dependency builds; dependency
  build passes 16/16 tasks.

Review found MCP union projection and same-looking replacement-node bugs. Production
projection and observation-identity regressions now cover their fixes. Popup sign-in
and uncertainty guidance fixes are implemented, with full native bridge proof still
pending. Earlier bridge attempts exposed suspended click checks on an unpresented
guest. No forced DOM click workaround or success claim is used.

## Remaining

Complete native authenticated bridge/popup/hidden-view/parent-close proof; integrate
PR #2893 resource tabs; prove the isolated desktop package; distinguish
test-owned existing attachment from personal-channel consent proof; reconcile docs,
manifests and census; run required verification and fresh independent review; pass
normal hooks, push, PR and protected merge; preserve evidence and clean only owned
resources. Personal app/profile/guest and all old held resources remain untouched.

## Native visibility investigation

An initially hidden native view suspends compositor frames even with background
throttling disabled. Moving it to child index zero still covers the shell; that
approach was removed. Genuine native screenshots confirm that `setVisible(false)`
keeps the shell controls visible. Chromium's focus emulation requests real rendering;
Playwright normally enables it, but `noDefaults:true` skips it. The production
transport now initializes this control and renews it after main navigation, with
serialized page-command admission and close cleanup. Eleven focused regressions
passed. Ten delayed reload/action cycles and six genuine cross-site HTTP
navigations passed, including native renderer process IDs 6–11, unchanged 400×550
viewport, and same guest present/hide/delayed click. Receipt:
`.dork/local-browser/visibility/production-results.json`. The wrapper physically
closed its child and removed the exact temporary profile. No JavaScript event shim, forced click,
streamed frame, duplicate page, or browser-wide authority is introduced.

## First-use and scope hardening

The capability response records platform, paired managed Chromium, existing-browser
version range, and unsupported-mode reasons. Download, free-space and folder
permission refusals have short recovery guidance without raw installer details.
Cancel aborts the installer, fences late context creation, and prevents stale UI
responses crossing cancellation or direct-chat changes. Fresh root backend/service
and native transport run: 34 passed. Fresh service/capability run: 22 passed.
UI worker cancellation/recovery suite: 22 passed, scoped lint clean. Shared package
was rebuilt. Final broader gates, UI dependency composition, installed package
repetition and independent review remain outstanding.

## Selected personal-style tab and candidate preparation

A stricter fixture manually launched installed Chrome 155.0.8059.40 with an owned
throwaway profile, without Playwright's launch defaults. The unselected foreground
tab stayed unchanged while production service actions succeeded on the explicitly
selected background tab, through three reloads and selection changes. This is not
channel-native permission proof. Disconnect cleanup stalled, so the attempt remains
failed; the owned Chrome and runner were closed and their exact profile removed.

The live fixture also exposed a TypeScript keepNames serialization failure in the
recursive DOM identity walker. An iterative stack preserves nested open-shadow
root coverage; a serialization regression reproduced the original failure and
then passed. The worker reports 30 focused tests passing and clean scoped lint.
Fresh package typecheck caught six Promise<void>/Promise<undefined> test-mock
assignments; explicit mock return annotations are fixed, with fresh types pending.

Desktop build passed: renderer assets carry no unsubstituted version defines,
and the bundled server's 76 runtime specifiers resolve and ship. Candidate
packaging is in progress. Qualification will rebuild native addons only in
private byte-copied staging and replace only candidate-owned binaries, avoiding
any shared pnpm-store ABI mutation while other checkouts run. The packaged
proof harness isolates CoreFoundation home, app data and logs and preserves
HOME/CODEX_HOME. No personal app, browser, model, or credential is used.

### Manual Chrome proof retry — passed

After bounded restore-first cleanup, the actual manual-profile fixture completed
with exit 0: selected background actions, three reloads, selection changes,
unchanged unselected tab, restored focus and both tabs preserved after detach.
Owned Chrome 155.0.8059.40 physically exited; the wrapper released its exact
marker and the profile was removed. Receipt: `.dork/local-browser/existing-service/receipt.json`.
The service waits up to 750 ms for focus restoration/detach before closing only
its attachment transport; an unresponsive protocol cannot block disconnect.
The worker's 32 focused tests include responsive order and nonresponding cleanup.
Channel-native consent is still separate and unproved.

Desktop packaging also exited 0 without calling shared native rebuilds. The
unsigned worktree candidate is preparation only until private native staging
and the isolated packaged proof pass. Fresh server/client/desktop types rerun
is now in progress after the mock fixes.

Fresh root verification after the selected-page cleanup fixes: server, client
and full desktop typecheck exited 0. Focused browser test batch exited 0 with
79 tests in 8 files. Logs: `/tmp/local-browser-fresh-types.log` and
`/tmp/local-browser-focused-tests.log`. UI review found editable channel/consent
during setup and focus loss when Cancel/Disconnect removes the active button;
those fixes are being implemented before final verification.

## Failed private-native preparation and recovery

The first helper preflight used a framework plist key absent from the real
package; both helpers now read CFBundleVersion41.10.7. The next rebuild attempt
found a more serious containment failure: Electron rebuild ascended from the
repository-nested staging tree to the pnpm lockfile and scheduled both private
and worktree addon copies. Its compiler group physically closed, but our source
SQLite binary changed to Electron ABI and three node-pty native artifacts appeared.
The before/after guard rejected the attempt. No candidate app was launched.
Receipt: `.dork/local-browser/native-staging/1792029823562/receipt.json`.

Read-only canonical path/dev/inode/nlink checks showed these targets belong only
to this worktree (nlink1); primary, Doc, panel and WiFi checkout native files have
different inodes. Exact SQLite original bytes were found in the pinned Node127
prebuild cache and match the recorded pre-attempt SHA. Root notified both
coordination peers; restoration is awaiting narrow coordinated execution. No
broad rebuild, foreign PID stop or foreign file mutation is authorized. Exact
plan: `.dork/local-browser/native-staging/restoration-plan.json`. The helper is
being moved outside the repo and gains an actual module-target preflight and
runtime boundary guard before another compilation can run.

### Exact checkout repair — verified

Root coordination approved the narrow repair after the own-consumer census.
Only this worktree's SQLite bytes were restored from the cache member matching
SHA1946ab352978b5b3493f99080dc04ed6d0a4157c511c7139cbf50b3d44d8d560, preserving
mode755 and inode1366932544. Only the three proven newly-created node-pty
native artifacts were removed, each guarded by its recorded inode/hash. Plain
NodeABI127 loaded SQLite, ran an in-memory select7 query, and loaded the PTY
module without spawning a terminal. Receipt: `.dork/local-browser/native-staging/restoration-result.json`.
No broad rebuild or foreign write occurred. Doc independently confirmed its
R/I binaries use different nlink1 inodes. The next Git/GH-only Doc window is
released. Corrected native containment awaits independent source review before
any new compiler or candidate launch. The initial shared-store assumption and
subsequent canonical-path correction remain in this ledger.

## Frozen installed desktop proof — passed

The initial package was corrupt because root packed while a worker still edited
page-focus.test.ts. The first9040ASARpayloads matched; that next file changed
size/content and shifted subsequent offsets. Root explicitly froze all own
source writers and compared17310source files plus4026generated dist files
before/after a fresh shared+desktop build and normal direct package. Source
SHA stayed ddb6b2da3256f9612fb6e612e9c6dab15bac07bd7bc3adf425407a7f8d84c422;
pack dist SHA stayed f2815524c64c647d23f9802c706bd16ca1bc21df8767e7f0d5b5fdb0273a4204.
All33101packedpayloadhashes passed readback. Archive SHA:
f7f7057159fd7ad2a28a7f80d3fc6b2f74c2f7f64b204a0fac0f14a087212dfc.
The verified private Electron41.10.7 native bytes were reused with exact receipt
and atomic candidate-only copies; source binaries stayed unchanged.

Harness repairs canonicalize macOS /var aliases, use Node's builtin module loader
in serialized main evaluation, keep fixed RAF fixture code outside tsx name
transforms, and await a real rendered control before capturing pixels. The
preload heartbeat can precede React's first paint; an early blank capture is
preserved as a failed attempt rather than claimed as success.

Final bounded package proof exited0: `.dork/local-browser/desktop-proof/1792031545310/receipt.json`.
It proves own CoreFoundation home/userData/logs, packaged identity/Electron41.10.7,
shipped+resolved Playwright1.63, fresh real renderer heartbeat and94902changed
pixels, one embedded guest, automatic Chromium153.0.8010.12 acquisition, fake
saved sign-in cookies in both modes after app restart, and cached offline
installer reuse. All own app/server/browser PIDs and port closed; its temporary
data was removed. Final panel composition, native Chrome/Edge permission, final
CLI repeat, metadata-read boundary fix, final gates/reviews/merge remain required.
The source freeze ended only after immutable artifact readback.

## Native permission fixture — UI targeting gap

Source-reviewed disposable-profile proof helpers passed scoped ESLint. The owned
Chrome 155 process launched without a remote-debugging flag, in its own process
group and isolated CoreFoundation home. The native CUA app binding resolved the
personal Chrome bundle instance instead of the disposable instance; its documented
inventory exposed no owned PID/window selector. No UI action was sent to either
browser, and no personal permission or browser data changed. The proof was stopped
before permission; this is a failed attempt, not native channel evidence.

Receipt: `.dork/local-browser/native-consent/1792032794058/receipt.json`.
Exact owned PID10231 was checked against the unique fixture command before TERM;
the identity-guarded helper confirmed process-group and escaped-helper closure,
removed the disposable profile, and exited1. The wrapper released its exact marker
and Doc was notified of physical release. Follow-on checks remain queued behind
Doc's reserved provisioning/validation window. Do not claim browser-native consent
works from the prior CDP-only attachment evidence.

Independent production re-review found three further source gaps: the browser
subcommand help retained removed setup guidance, the active panel omitted browser
and agent names, and observation payloads lacked size caps. CLI help and labels are
now corrected with drafted regression tests. Bounded observation work is in progress.
These fixes have not yet been executed through tests during the shared lane hold.

### Production delta source review

Independent Stage1 re-review found the three source fixes satisfactory: older CLI
subcommand guidance, explicit Chrome/Edge and chat-owned agent identity, and bounded
observations. The name lookup uses the direct chat's session row, never a globally
selected working directory; another chat is explicitly labeled. New payload limits
are128KiB UTF8 snapshots,4MiB PNG bytes,8192-pixel edges and16Mi pixels, with no
viewport resizing. Snapshots over the limit grant no stored action observation.
This is source review only: latest regressions and package/type checks remain queued.

Native permission has a concrete alternate-method question pending with the human:
permission to use PID-specific AppleScript only for the disposable Chrome fixture,
because the native UI tool instructions require explicit authorization for that
alternate method. No alternate UI method has been run. No time elapsed is treated
as authorization. Doc's validation window remains ahead of browser follow-on work.

## Focused regression batch and isolated UI proof preparation

Doc granted one bounded batch after its build producer closed. Wrapper39847 owned
PGID39847 and pnpm39850/39851. One Vitest invocation completed in5.27s with100passed
and1failed across8files: metadata, observation limits, service, focus, node identity,
panel UI, route scoping, and CLI dispatcher. Failure: an older service test required
an immediate title in open(), contradicting deliberately nonblocking unselected-title
refresh. The corrected regression holds that first title pending, requires open
to return, refreshes on document events, and rejects the late old reply. That fix is
source-only and has not been rerun. No further batch was chained; the recorded PIDs
and whole PGID were absent, marker removed, and Doc notified of physical release.

The new scripted local-browser scenario calls production registry observe/fill/click/
screenshot against the same boot-owned service. Its dependency getter is configured
only on the existing test-control router; boot hands it over only under the existing
DORKOS_TEST_RUNTIME gate. No new action/debug endpoint or model call is introduced.
Independent review found the initial shared-E2E draft could collide with global reset
calls from other suites. Those shared test and fixture-index edits were fully removed.

The replacement UI helper runs only inside cli-installed-proof.ts's exclusively
owned installed server, private profile/data/ports. Each server launch checks its PID
owns the allocated TCP listener. The installed Playwright browser owns a private
persistent headless profile; UI contexts record video and screenshots. Draft assertions
cover all3choices, saved mode/channel without saved consent, desktop/tablet/phone
widths, real scripted input and PNG result, Pause refusal, Resume and Disconnect.
Source review and execution remain pending. LocalBrowserPage.selectView depends on
the panel owner's final POM composition; do not execute before that main merge.

### Follow-up checks after the metadata assertion fix

The granted `browser-service-lint-types` batch completed all three commands with
exit 0. The service file passed all 29 tests, including the rewritten nonblocking
metadata regression. Server package typechecking passed with an 8 GiB heap. Scoped
lint reported zero errors and three warnings in `cli-installed-proof.ts`: a misplaced
environment directive and a 575-line file. A source-only extraction of UI process
ownership is addressing those warnings; lint must run again afterward.

Wrapper PID 50407, inner PID 50412, and all PGID 50407 descendants were absent after
completion. Its matching marker was absent, and Doc received the physical release.
No native/E2E follow-on batch ran. Logs are `/tmp/local-browser-service-test.log`,
`/tmp/local-browser-delta-lint.log` and `/tmp/local-browser-server-types.log`.

A separate native/PiP source trace found that human-only popup parent windows still
captured the original main window. New and late-created popups now use the guest's
current host, and tracked popup windows move with the guest through Electron's
`setParentWindow()`, preserving pages and opener relationships. This source fix has
passed scoped lint; desktop types and actual PiP/opener proof remain required.

### Superseded fixture archive

The six early feasibility/window/visibility runners are preserved with SHA-256 hashes in `.dork/local-browser/historical-proofs/manifest.json`. They are evidence of earlier runs, not maintained proof entry points. The installed CLI and packaged desktop proofs cover the shipped paths; the bridge fixture remains for the final native panel/PiP checks and will receive a bounded runner before reuse.

The earlier endpoint-only `existing-service-proof.ts` is also archived, with its original receipt retained. Source review found incomplete helper-process census and unbounded cleanup, so it is no longer an executable maintenance path. The newer native-consent fixture uses bounded operations and owned physical cleanup; its browser-native permission gate remains pending. This does not invalidate the earlier recorded service behavior, and it does not upgrade that endpoint run to native permission proof.

### Composition with merged panel resources

PR #2893 merged through the protected queue as `73dc7cbbe32353637824ffa062e6ac2d2d056012`. All local authors joined before parking source. The repository hook rejected the shared checkpoint command because it can affect other worktrees; none was created. Root instead copied and SHA-256 verified 40 tracked paths and 62 untracked files into a private OS scratch directory, saved the tracked binary diff, restored only those owned paths, fast-forwarded this branch to the merged main, applied the tracked diff and restored all 62 untracked files with no overlap. Both manifest additions were preserved; CLI help keeps the current `docsUrl` helper while removing obsolete setup instructions. No hooks were bypassed.

The panel composition and native main/PiP proof source are now in progress. The installed UI proof also drafts an actual installer refusal through an unreachable local proxy, followed by normal-network first-use Download/Cancel/retry. These new checks have not run. Build/install proof commands now have a private wrapper identity, detached process group, deadline and owned physical cleanup. Source review caught inherited npm configuration that could redirect an installation globally; the proof now strips inherited npm settings, uses private user/global config and cache paths, and passes explicit local-install and private-prefix arguments. Final installed proofs must repeat against the composed source.

The merged owner supports floating computer content, not a native browser presentation descriptor. Per the accepted specification’s explicit fallback, Browser remains in the right panel and its app/docs copy states that limit. The native host reparent fixture qualifies engine ownership and popup behavior; it must not be reported as a shipped user-facing browser PiP flow. No duplicate page, streamed page or second browser is introduced.

Fresh composed-source batch: shared build passed. Twenty-four focused test files ran 299 tests, with 296 passed and three failures in the new Cancel test barriers. The radio assertion ignored disabled fieldset inheritance; retry resolved before its asynchronous transport call began. Those tests are corrected in source but not rerun. The batch stopped on failure, so lint and client/desktop types did not start. The wrapper and command groups closed, the exact marker was absent, and Doc received the physical release. No native or installed run was chained.

### Bounded lifecycle review and first gate

Independent source review identified real Playwright calls with no built-in timeout: node checks, input acknowledgement, disposal and close. The source now returns Pause immediately after fencing admission. Its action response deadline keeps the original pending-effect ownership until the effect actually settles; late continuations re-admit before input. Nonmutating disposal no longer holds action completion. Observation handles and presentation focus waits have finite response waits. Disconnect keeps one closing flight, bare acquisition, resource references and saved-data ownership until real closure. New opens remain blocked, pending closes say to wait, and an actually failed close requires restarting DorkOS. A late-created context remains owned and is closed. The launch itself has an explicit 15-second library timeout.

The boot-owned browser wrapper consumes the private bridge handoff before harness children start. It keeps the same service in human routes, tools and the test runtime. A bounded closing error does not abort the rest of server shutdown. This wiring exposed a previously unused mesh-root import and its superseded helper; only Tasks’ live helper remains. Three shutdown timer guards use Node’s existing no-op handling for undefined timer handles, keeping index.ts within its prior line count without raising the baseline.

The first lifecycle batch passed all 89 tests in four changed files and fresh client types. Server types found one deferred-fixture return annotation mismatch. Lint found one missing helper JSDoc, plus the index line debt and stale import. The fixture annotation/JSDoc are being corrected with the journal follow-up; index cleanup is source-only. Prior desktop types and shared build remain green. Independent Stage1 found no other lifecycle blocker, but asked for finite journal-write waits and deferred start/finish writer coverage before completion. The journal follow-up is now source-complete and independently re-reviewed without a new blocker: start, success and failure journal waits have separate two-second response budgets. A late start cannot dispatch; a stalled success write receives an ordered unknown correction after settling. Two deferred-writer regressions were added. The next bounded service/lint/server/E2E batch is prepared but held for Doc’s explicit shared-lane handoff. All native/installed repetitions remain pending.

### Reload recovery and journal gate

The app reload left no owned browser, private app, test or build process running. Earlier receipts and staged source remained intact. OS scratch scripts and the private native-build directory were gone. The three native binaries in the older owned candidate still matched their original compile receipt; verified private copies now live under `.dork/local-browser/native-staging/recovered-cache-1792042121380/`. No compile or shared native binary write ran during recovery. Personal DorkOS remained separate. Doc recovered its own interrupted validation groups and released its exact marker before granting the next batch.

The durable `journal-02` batch passed all40 service tests, including both deferred journal cases, scoped ESLint, server types and E2E types. ESLint reported only index.ts's existing3508-line warning; its baseline was not raised. All four recorded process groups were absent after completion, the marker was absent, and Doc received the physical release. Results and closure are under `.dork/local-browser/delta-batches/journal-02/`. No native or build command was chained. Prior client/desktop types and shared build remain green. Current native bridge, installed CLI/UI and frozen packaged desktop proofs still remain, along with final independent review and normal publication.

### Current production native bridge proof

The separately granted bridge-final-01 run passed on Electron41.10.7, Chromium146.0.7680.216 and Playwright1.63.0. It compiled the current production bridge and recorded source, bundle and fixture hashes. Guest2 and its Playwright page remained identical through main→secondary fixture→main. Existing and new human-only popups followed the current host with opener intact. Closing the former host preserved the guest; closing the current host closed it. The authenticated page-only bridge refused shell targets; hidden-view actions also passed. Three actual native page captures were visually inspected and all recorded29,423 painted pixels at840×900. This is native-host qualification only; shipped Browser PiP UI remains false and the app still explains its right-panel limit.

Receipt: `.dork/local-browser/bridge-proof/1792043636908/receipt.json`. The outer descendant-aware runner captured14 process identities; all recorded PIDs and owned groups93884/93909 were absent afterward. The inner fixture removed its private data, the exact marker was absent, and Doc received physical release. Closure receipt: `.dork/local-browser/delta-batches/bridge-final-01/attempt-20261015T055356-04d0e3a8/physical-closure.json`. No other build or proof was chained. Installed CLI/UI, final frozen packaged desktop and native Chrome permission still remain.

### Installed UI proof preparation

Readback of the older desktop capture showed the welcome screen. That run proved an included library, actual native guest, healthy renderer and persistence, but not the Browser panel controls. The final proof now dismisses first-run prompts only in its explicitly verified private data directory, opens Browser through the existing panel POM, checks the three choices and desktop default, uses Open browser and Web address, checks public native-view visibility/bounds and captures the native page and renderer separately. Closing and reopening the panel must preserve connection and guest identity. Standalone CLI UI proofs now settle those same prompts; they do not run the shared E2E global setup or send first-run chat turns. A read-only data-directory check precedes every reset, then repeats before configuration patching.

Proof-ui-03 passed two caller-level wrong-home regressions, zero-warning scoped lint and E2E types. The new proof-specific typecheck found six missing Electron callback annotations. Proof-ui-04 added those annotations and passed lint, but its typecheck found that Electron's declaration package must be loaded as ambient types rather than imported by relative directory. The proof-only tsconfig now explicitly loads the desktop-owned Electron types and the runner imports the public electron type module; that final fix is not rerun. Both batches terminated and their recorded groups and exact markers were absent; Doc and the parent received explicit releases. No installed or native proof was chained. Production code and the successful current bridge proof are unchanged.

The fix-only proof-ui-05 batch subsequently passed zero-warning lint and the typecheck covering every maintained TypeScript proof runner. The local proof tsconfig loads Node and desktop-owned Electron ambient types explicitly; no existing gate config changed. Prior custody regressions and E2E types remain green. Both command groups36145/36162 and the exact marker were absent; immediate physical releases went to Doc and the parent. All proof writers have joined. The installed CLI/UI and frozen packaged desktop runs are now ready for separately granted windows. No build or native run followed this gate.

Fresh independent source-only review of the proof custody and desktop panel changes found no factual issues (zero important findings, zero nits). The reviewer checked private-home checks before mutations, actual Browser controls, native guest visibility and same-connection close/reopen, scripted tool wiring and cleanup. No test, build, browser or native runner was executed by the reviewer. Installed-package runtime proof and native Chrome consent remain pending. The reviewer used the inherited harness default because the configured named model was unavailable; this is Stage1 fixture review, not the final pushed-branch Stage2 gate.

### API reference completion

The prepublication route audit found that the eight new human-control endpoints were absent from the API reference. A domain-owned registration now projects existing browser request, state and capability schemas, describes local owner access, explicit permission/tab selection, Pause, fresh observation after Resume and detach/close behavior. No browser runtime or control behavior changed. Generation, the existing OpenAPI export tests, scoped lint and server types are prepared in a single 180-second batch and remain pending the next explicit shared-lane grant.

API-docs-01 generated both committed API outputs successfully, passed all16 existing OpenAPI tests and zero-warning scoped lint. Independent Stage1 source review found no factual issues in the eight methods, schemas or behavior descriptions. Its final server typecheck exhausted Node's default4GB heap and exitedSIGABRT(-6), without a TypeScript verdict. Earlier passing type batches used8GB; a120-second types-only retry with that same explicit heap setting is prepared, not run. All22 observed PIDs and six command groups were absent, the exact marker was absent and Doc/parent received immediate physical release. Evidence: `.dork/local-browser/delta-batches/api-docs-01/attempt-20261015T070321-76db519a/`. No browser/native/build command was chained.

The separately granted API-types-01 retry passed server `tsc --noEmit` with the same explicit8GB heap used by prior successful batches. The one recorded group94576 and PIDs94576/94579/94589 were absent after exit0, the exact marker was absent and Doc/parent received release. Evidence: `.dork/local-browser/delta-batches/api-types-01/attempt-20261015T070912-7187fe7a/`. No successful generator/test was repeated and no browser/native/build command was chained. The initial default-heap OOM remains recorded as a failed attempt. All API-reference gates are now green; installed CLI/UI, frozen desktop and native Chrome permission remain.

### Installed CLI attempt: stale build rejected

The granted CLI-final-01 batch packed and privately installed194 packages, verified included Playwright1.63.0 and an empty managed cache, then failed waiting for Add view. Root traced this to proof preparation: `npm pack --ignore-scripts` packed existing dist without a fresh CLI build. Its active client asset SHA51ce7160f20619205dd4675ebd77e7631070517eccd8df78173f83cb5cc23ae1 was written00:18UTC, before the03:44 merged panel implementation. The current source header and POM agree; no UI fix is justified by this failure. The maintained proof is being corrected to build first and bind the packed artifact to source fingerprints.

Negative receipt/tarball/video remain under `.dork/local-browser/cli-proof/1792049124740/`; tarball SHAa6a3881d5bb6a97382cab686958b245c6243b61beef734aabc119ca494b762d2. The outer wrapper exited1, all43 observed PIDs and group6750 were absent, and the exact marker was absent. Both inner and outer receipts confirm physical closure; Doc and parent received release before diagnosis. Evidence: `.dork/local-browser/delta-batches/cli-final-01/attempt-20261015T072524-c82af9f1/physical-closure.json`. No retry, desktop or native proof was chained.

The proof-only correction is source-complete and independently converged. CLI proof now runs the normal sanitized, bounded300-second CLI build before pack. Source receipts before build, after build, after pack and after the final attempt bind HEAD, lock, file hashes/modes, symlink metadata and deleted entries to the tarball fingerprint. Final snapshot failure retains the original error and prevents successful temporary-install deletion. Source writers must remain stopped throughout. Stage1 caught a symlink-parent read gap; internal ancestors are now checked before leaf reads, which use O_NOFOLLOW. Four focused source regressions cover actual source changes/deletion, ignored outputs, leaf-link privacy and indexed parent replacement. No production UI/POM change was made. The prepared180-second scoped gate has not run; fresh installed/package/native permission proof remains pending.

Source-custody-01 passed all six custody tests in two files and zero-warning scoped proof lint. The maintained proof typecheck found TS2322: installed Node declarations allow only string flags on createReadStream. E2E types did not start. The helper now opens a typed FileHandle with numeric O_RDONLY|O_NOFOLLOW, hashes that descriptor and closes it in finally; source-only independent review found no factual issues. A fix-only batch covering four snapshot cases, helper lint/format, proof types and E2E types is prepared, not run. All17 recorded PIDs and four groups were absent, the exact marker was absent and Doc/parent received release. Evidence: `.dork/local-browser/delta-batches/source-custody-01/attempt-20261015T073833-98edcd23/physical-closure.json`. No browser/native/build or retry was chained.

The separately granted source-custody-02 fix gate passed all four snapshot regressions, zero-warning helper lint, all maintained proof-runner types and E2E types. Prior two caller-custody tests remain green. All18 observed PIDs and five groups were absent, the exact marker was absent and immediate release went to Doc/parent. Evidence: `.dork/local-browser/delta-batches/source-custody-02/attempt-20261015T074307-949f2442/physical-closure.json`. No browser/native/package build was chained. The fresh-build-before-pack CLI retry is ready but still requires a separate explicit900-second grant.

### Fresh installed CLI: real recovery passed, picker fixture corrected

The separately granted fresh-build retry completed the normal CLI build, installed194 packages and held the same source fingerprint across all four snapshots (17,343 inputs). Included Playwright, empty cache, the actual proxy-refused installer UI, preparation clearing, enabled recovery, web capabilities, embedded refusal and explicit-consent refusal all passed. The error recovery screenshot was visually inspected and shows the actual Browser panel controls. Normal UI then failed on an exact-label locator: the native select was visible in the video frame, while Playwright1.63 label text includes its nested option text. The proof now uses the select's actual combobox role and accessible name. Independent source review confirmed this selector.

The same proof-helper source trace adds the existing turn-end barrier after each scripted reply and lets the connected assertion cover the production180-second acquisition plus15-second launch (210 seconds total assertion budget). No production UI or POM source changed. Scoped lint/types for this correction and a separate installed retry remain pending. Negative receipt/media/source snapshots: `.dork/local-browser/cli-proof/1792051060859/`. All83 recorded PIDs and group33812 were absent after outerexit1, the exact marker was absent and immediate release went to Doc/parent. Physical closure: `.dork/local-browser/delta-batches/cli-final-01/attempt-20261015T075740-59981935/physical-closure.json`. No retry/desktop/native proof was chained.

Picker-locator-01 then passed zero-warning helper lint, all maintained proof-runner types and E2E types. No unit or runtime test was repeated. All12 recorded PIDs and four groups were absent, the exact marker was absent and immediate release went to Doc/parent. Evidence: `.dork/local-browser/delta-batches/picker-locator-01/attempt-20261015T080702-e863e4d5/physical-closure.json`. A separate900-second fresh CLI retry with30-second census/cleanup reserve is ready, awaiting Doc's next explicit grant. The reserve corrects earlier six-second wording, which counted signal waits but omitted bounded process censuses; prior actual closures remain confirmed.

### Fresh CLI responsive-panel race and focused gate

The next separately granted CLI attempt passed fresh build,194-package private installation, actual installer-error recovery, capability/refusal checks and the1280-wide browser choices, picker and persisted preference/reload checks. It then failed at768 after reload: layout restoration opened the Sheet between reading the Open panel label and clicking the toggle behind it. All four source fingerprints remained9aea4027ceed96875ae68777fc6b8df08d35eeae035e607ba9f81487c183a879; tarball SHAb665c48fdd5898b0a1c27d71b7406d2250fb1dc3b0882394bcb33df131ba626c. Negative evidence remains under `.dork/local-browser/cli-proof/1792052597458/`. Outerattempt20261015T082316-c3fb2e73 exited1; all72 observed PIDs and group51621 were absent, the exact marker was absent and Doc/parent received immediate release at08:25:06UTC. No retry was chained.

The shared RightPanelPage.open helper now recognizes an already open panel and tolerates a concurrent Sheet opening. Its Close panel locator explicitly excludes inert ancestors because pinned Playwright role/visibility queries do not do so. No forced click, production UI or state manipulation was added. Independent Stage1 review converged without findings. The separately granted panel-open-01 gate passed format, scoped lint, all proof-runner types and E2E types in6.08seconds. All15 observed PIDs and groups61617/61639/61671/61695 were physically absent, the exact marker was absent and Doc/parent received immediate release. Receipt: `.dork/local-browser/delta-batches/panel-open-01/attempt-20261015T083350-ebe8a516/receipt.json`.

A related source trace found that pinned Playwright editable/fill internals do not check inert controls. Production browser behavior has not been changed on that evidence alone. A bounded owned loopback fixture is prepared to call unchanged production performPageAction against inert text/date controls and record dispatch, values and input events. Runtime reproduction requires a separate grant. Full installed CLI/UI, frozen packaged desktop and native Chrome permission remain pending; none is claimed complete.

The first inert fixture attempt failed before importing esbuild or launching a browser because pnpm does not expose the server's esbuild dependency at root. The fixture now resolves it through the server's declared package, matching the existing bridge-proof pattern. Runtime behavior remains untested. Outerreceipt `.dork/local-browser/delta-batches/inert-repro-01/attempt-20261015T083605-5a76f62a/` records exit1, sole observed PID/group63628 physically absent and exact marker absent; immediate release went to Doc/parent before diagnosis. No retry was chained. The same60-second reproduction plus30-second reserve is awaiting a separate grant after Doc's Foundation diagnostic.

### Inert input safety defect reproduced

The separately granted corrected fixture completed and reproduced a real production defect on Chromium153. A fresh accessibility snapshot included both inert controls. Filling the inert text field inserted into the previously focused ordinary field; filling the inert date field directly changed its value. Both dispatched input events. Before-fix evidence: `.dork/local-browser/delta-batches/inert-repro-01/attempt-20261015T083840-e56ffa02/reproduction.json`. All10 observed PIDs and group65858 were absent, the exact marker was absent and Doc/parent received physical release before diagnosis.

A fill-only guard is source-complete: it reads explicit inert state through assigned slots, DOM parents and shadow hosts after the final snapshot, before admission/dispatch. It reuses not_editable, changes no focus and leaves click behavior and observation identity collection intact. Two focused tests cover serialized callback/composed ancestry and a field becoming inert during the final snapshot, with no fill or dispatch. The service fixture supplies the new read-only evaluate method. Independent source review found no blocking issues. This checks state before dispatch and does not claim an atomic transaction against later DOM changes.

A separately requested180-second gate plus30-second cleanup reserve will run scoped format/lint, both focused tests and existing service tests, server8GB types, then the same real-browser fixture with assertions that both inert cases remain unchanged and emit nothing, followed by an editable positive control. The receipt now hashes the guard, action source and compiled action bundle. This gate has not run; further installed CLI/desktop proof remains pending.

Inert-fix-01 subsequently passed zero-warning scoped lint, all42 tests across the new admission cases and existing service suite, server8GB types and the real Chromium153 regression. Both inert text/date actions were refused before dispatch; ordinary/inert values and focus stayed unchanged and no input events fired. The editable positive control still received its exact replacement text. Action, guard and compiled bundle hashes are in `reproduction.json`. All25 observed PIDs and groups69438/69460/69494/69540/70613 were physically absent, the exact marker was absent and Doc/parent received immediate release before result readback. Evidence: `.dork/local-browser/delta-batches/inert-fix-01/attempt-20261015T084241-62b41a60/`. Duration41.44seconds; no CLI/desktop/native proof was chained. Installed proofs remain pending separate grants.

### Final installed-proof preparation

Actual1280 screenshot inspection found the panel's Browser heading repeated by the radio-group legend. The legend is now visually hidden while retaining the group accessible name. No label, selection or action behavior changed.

While the shared heavy lane is held for Doc's CI diagnostic validation/publication, native Chrome fixture preparation is also complete. Its independently reviewed extension proposal passed gitapply--check and is now applied: a tiny owned MV3 extension must be installed through Chrome's native UI in the disposable profile, supply nonce-bound local probes with the same extension ID before/during/after attachment, and expose its visible marker to the production selected-page observation. The fixture attaches without a URL, requires no automatic selection, explicitly selects the exact already-open fixture tab and verifies that navigation keeps its ID. Cookie/input/detach checks remain. The operation budget is300seconds; final bounded5-second detach,60-second owned-process cleanup and2-second fixture close remain separate. Restart persistence is not claimed. No extension installation or native UI action has run. The earlier pending UI-method authorization does not yet include extension installation.

The amended requested next batch has one global900-second budget plus30-second cleanup reserve: native-proof/legend scoped format+lint, maintained proof-runner types, then the single normal fresh-build/private-installed CLI proof. Independent source review found no factual issues in the runner, native-source delta or preserved accessible legend. Command: `python3 scripts/local-browser/run-in-lane.py bounded-local-browser-cli-proof python3 .dork/local-browser/delta-batches/native-preflight-cli-01/run.py`. It stops on preflight failure and invokes no native-consent or desktop proof. No execution has run; it awaits Doc's actual closure and an explicit grant.

### Fresh installed CLI: responsive flow passed, sharing defect found

Native-preflight-cli-01 passed the two-file format/lint and every maintained proof-runner typecheck, then built and installed the current CLI. The actual UI passed1280/768/390 choices, saved preference/reload and consent-not-restored checks, and genuine first download, cancellation and retry connection. Root visually inspected desktop/phone choices, download and cancelled frames; the duplicate visible legend is gone. The first production-tool turn then correctly returned not_shared rather than acting: LocalBrowserContent read the obsolete store session ID, while SessionPage and chat use the URL's entity useSessionId. The same stale source also governed Browser resource ownership. This is a production sharing defect, not a reason to loosen tool ownership.

Negative receipt/media: `.dork/local-browser/cli-proof/1792056360002/`. All four fingerprints stayedb8b4476836e998eb46e810a8b08d02a4a80c7d6fa63404948bb7242bf9c35b69 across17,345 inputs. TarballSHA1830ff62f2a09e956b01713623e8a62794e34d237867da11996814f1713cc450. Outer attempt20261015T092553-f26e7c8f exited1 after116.61seconds; all103 observed PIDs and groups97440/97462/97507/97547 were physically absent, exact marker absent, and Doc/parent received immediate release before diagnosis. No native/desktop proof was chained.

The source correction now uses the canonical route hook in Browser content and Browser resource ownership. Legacy terminal/canvas scoping is untouched. Regressions deliberately vary null/stale legacy IDs independently of the route, follow navigation, and preserve human-only team/Rooms browsing. Three container tests now mock the newly required hook. Independent seven-file source review found no factual issues. A180-second scoped format/lint/local-browser+right-panel unit/client8GB types gate is prepared and awaiting a separate grant; no check has run on this correction.

A separate acceptance audit also found that the installed CLI's existing endpoint leg calls its installed Playwright library directly, and the packaged desktop proof has no existing-mode leg. Repository-source native consent plus these receipts cannot close task4.1. Artifact-backed installed-server public controls/scoped tools and normal packaged-app existing mode remain required. Ignored source-only proposals are being prepared; native permission and extension retention remain unproved.

Canonical-session-01 passed all228 tests in15 Browser/right-panel files, zero-warning scoped lint and client8GB types. The null/stale legacy selection, route change and human-only Rooms cases are green. Duration45.71seconds. All28 observed PIDs and groups6776/6802/6844/6952 were physically absent, the exact marker was absent and Doc/parent received immediate release before test-result readback. Receipt: `.dork/local-browser/delta-batches/canonical-session-01/attempt-20261015T093452-aaa1cda0/receipt.json`. No installed/native/package proof was chained. A separately granted fresh installed CLI run still must prove that the first real scoped turn can use the shared page.

### Installed scoped tools passed; persistent-cookie restart failed

Original cli-final-01 received an explicit900+30 grant and ran against the canonical-session fix. Receipt `.dork/local-browser/cli-proof/1792057705167/receipt.json` proves the real installed UI at1280/768/390, genuine download cancellation/retry, same-live-page scoped observe/fill/click and PNG results, Pause refusal and fresh-observation Resume. Two independent fixture callbacks contained exactly Scripted local input. The run then failed the saved-sign-in title check after disconnect/server restart; it is not an overall pass. The owned profile Cookies table was empty in a subsequent read-only inspection. Root is tracing the cause before changing production or weakening this assertion.

All four source snapshots remained754f01f82afc27e0b47a072afa8bb1eb0ddb1b3b2dee59e88a64ff7fbbc5945a across17,345 inputs; tarballSHAf799a9f927ab3664c0cd4669819f71c962d546f99fd58770fe4e1d65bb1c20af,29,082,131bytes. Outer attempt20261015T094824-997fd6ed exited1, group15769 and all104 observed owned identities were physically closed with empty remaining PID/group lists. Exact shared marker absence was confirmed and Doc/parent received immediate release before diagnosis. No further grant or chained native/desktop run exists. Native artifact-backed existing-browser qualification remains a separate gap.

The subsequent source trace identified a shutdown race in the pinned Playwright path: its persistent context protocol-close event can precede completion of the browser-process close request. The service raced those events and released the profile; the proof then immediately sent SIGTERM, which can reenter Playwright graceful shutdown and kill that still-closing child. Owned persistent contexts now await the original context.close request. Remote detach behavior is unchanged. Rejected or pending owned closes retain the existing tombstone/lease even if a later protocol event arrives. Two focused regressions cover early-event/pending-request and rejected-request behavior. Independent review found no issues; the focused180+30 gate is prepared and queued, not yet run.

The installed CLI proof now records pack version and asserts installed manifest agreement, logs only owned-cookie presence and fixture phase/timestamp, and verifies a cookie-bearing request before shutdown. This distinguishes failure to set a cookie from failure to preserve it. The restart assertion remains strict. These proof changes and the focused gate also passed independent source review; no runtime pass is claimed.

Persistent-close-01 attempt20261015T100622-6a675d88 stopped on ESLint max-lines only: the CLI proof grew to519 lines against500. Tests and types did not run. Both formatter/lint groups31727/31756 and all6 observed PIDs were physically absent, exact marker absent; Doc/parent received immediate release before diagnosis. The archive/version/hash read is now extracted to the existing custody helper; CLI behavior and installed version comparison remain, with archive basename/actual-byte-count validation added. The amended gate includes four scoped files under the same180+30 bound and awaits independent review/new explicit grant.

The amended focused gate attempt20261015T100845-51c4b0a7 again stopped solely on max-lines: extraction reduced519 to501 counted lines, one over the configured500 (blank lines/comments excluded). Groups34312/34336 and all6 observed PIDs were physically closed, exact marker absent, immediate Doc/parent release preceded diagnosis. Removed the redundant one-use tarball alias and passed packed.tarball directly; read-only source count is500 and independent review found no issues. The revised gate now starts with only the affected CLI file's lint, stops on failure, then checks formatting and runs the necessary regressions/types. No shutdown/cookie assertion was weakened. No runtime gate pass is claimed.

The revised lint-first persistent-close gate subsequently PASSED: attempt20261015T101130-46ddd730, affected CLI lint zero warnings, four-file formatting check,84 tests across9 local-browser files, server8GB types and maintained proof-runner types. All22 observed PIDs and groups36815/36846/36877/36959/37429 were physically absent with empty remaining lists, exact marker absent, and Doc received immediate release before result readback. The original failed attempts remain preserved. No installed restart persistence pass is claimed yet; the next fresh installed CLI run needs its own900+30 grant after staging/freezing.

### Fresh installed CLI passed after owned-close fix

Receipt `.dork/local-browser/cli-proof/1792059442318/receipt.json` is passed-bounded-cli-proof. The fresh normal CLI build/pack/private install passed responsive1280/768/390 choices/preferences/consent-not-restored, real installer refusal/recovery/download/cancel/retry, actual scoped observe/fill/click/PNG and Pause/Resume. The owned-cookie witness was present before close and after server restart; cached browser reopening worked while installer proxies refused traffic. The isolated installed-library endpoint compatibility leg also passed, preserving its owned tab/cookie on detach; it does not prove native channel discovery or consent.

Four unchanged source inventories across17,345 inputs: e97bf766343ee3effbc11f2ef4d2b322fdf166eab7571d5741afcd48f43277bc. Version0.115.0, tarballSHA d4814a07b941dbf282d23a607849a873daada24659822df78df3af86fe505adf,29,082,267bytes. Runtime10:17:22–10:18:41UTC. Outer cli-final-01/attempt20261015T101721-7865bb9a exited0; group41094/all98 observed PIDs were physically absent, exact marker absent, and Doc received immediate release before diagnosis. Temporary installation removed only after closure; tarball, receipts and UI media retained. Root viewed actual tablet choices and shared-agent frame. Native channel consent and normal packaged desktop qualification remain explicitly pending; Windows/Linux/Edge are unproved.

Normal desktop metadata feasibility attempt `.dork/local-browser/native-artifact-feasibility/attempt-20261015T052135-6472ea20/` stopped in the dev-Electron CFhome preflight before launching the packaged candidate: app.getPath(home) reported the normal /var alias, while the private fixture was canonical /private/var. No Chrome/discovery/model/build/native write occurred; candidate bytes and shared native identities stayed unchanged. All6 observed PIDs/group45410 were physically absent and exact marker absent; Doc received immediate release before diagnosis. Strict canonical private-path equality is being corrected in the ignored harness. This failed preflight does not qualify utility preload or the candidate.

The canonical-path feasibility retry attempt20261015T053118-8d2041fd reached its120-second outer timeout. Private-home preflight passed and the normal candidate launched, but updater suppression failed before restart: tsx serialized the assigned async function with a host __name helper missing in Electron main. The guard correctly blocked normal quit; the outer owner closed all12 observed PIDs/group53207 and released the exact marker. Doc received immediate release before diagnosis. Candidate ASAR/executable and shared native identities remained unchanged. No Chrome/native connection ran. A serialization-safe callback and pure serialization/type preflight are required before another native retry; the failed attempt remains failed.

The coalesced pure source preflight attempt `.dork/local-browser/native-artifact-cli-proposal/preflight/attempt-20261015T054138-21d67cc6/` stopped on five TypeScript errors after formatting the exact ignored inputs: URLSearchParams needed string conversion, and the desktop draft needed resolvable Page/bridge types. Serialization and syntax controls did not run; no launcher, Electron, Chrome, build, install, or tracked source mutation occurred. Groups63235/63257/all6 observed PIDs were physically absent and exact marker absent; Doc received immediate release before diagnosis. All errors are being repaired in ignored source and reviewed before a types-first retry; native retries remain blocked on the pure gate.

The repaired pure preflight `.dork/local-browser/native-artifact-cli-proposal/preflight/attempt-20261015T054523-7f378cc1/` PASSED six-root typechecking, exact ignored formatting, four CJS syntax checks and callback serialization controls. The actual tsx historical callback reproduced the missing __name failure. All six actual raw callbacks passed in a helper-free VM, covering two fresh updater reassertions, private canonical environment, wrong entry/deadline refusal, original fork restoration, and AST enforcement of tested callsites. Raw callbacksSHA ab4e7639af60f4766e0f31e694809b2674b87ac07bbecd7d0e88ea5550a6c44c. All12 observed identities/seven groups physically closed, exact marker absent; Doc received immediate release before readback. No native app/browser ran. A new feasibility grant is requested separately. The broader HUMAN PID-specific UI-method exception for the disposable Chrome extension/native permission/fresh same-tab navigation is now pending asynchronously; elapsed time/default selection is not approval.

Serialization-safe feasibility attempt20261015T054719-4587be87 passed actual private candidate identity, updater suppression/fresh close readback, writable fork wrapper installation and normal renderer restart. The replacement server started, but no shim marker appeared before the45-second operation deadline. The current fixture reads fork records only after the marker; interception versus preload behavior is not yet determined. Normal app closure resolved, all15 observed PIDs/group68265 were physically absent, exact marker absent; Doc received immediate release before diagnosis. Candidate/native identities remained unchanged. No Chrome ran and no feasibility pass is claimed; pinned-source investigation and stronger failure-time admission evidence precede another request.

Evidence correction: the pure preflight's formatter command honored gitignored prototype paths and emitted no formatting output. Its type, syntax, serialization controls and AST audit genuinely passed; the earlier word formatting overstates that no-op step. Maintained-source formatting/lint remains pending. Any explicit prototype formatting must be scoped to the exact owned inputs and followed by serialization revalidation.

Pinned Electron41.10.7 primary-source review explains the latest normal-restart/no-marker result: NodeBindings filters utility --require/-r. That recipe is retired; no runtime retry is requested. A new source-only proposal under .dork/local-browser/native-artifact-inspector-feasibility/ evaluates supported owned Node --inspect-brk instrumentation. It requires a proven initialized utility_init pause before server/static imports, exact replacement PID/listener custody and killing an unguarded paused child before debugger disconnect. The initial inspector wait precedes Node bootstrap, so process availability cannot be assumed. Boundary feasibility remains under independent primary-source review. No product hook, fuse, ASAR, HOME or personal-browser change was made. Native acceptance remains open.

Fresh desktop-final-01 attempt20261015T110221-0fbdc7c3 built and packaged the current source, verified full payload hashes and721 frozen desktop inputs, and reused only the three candidate-native files with shared native identities unchanged. ArchiveSHA89a916e024c6e4660cfbc54655c6518f747503e94fdda75c3c5343c4be14f02a; package evidence .dork/local-browser/package-integrity/final-20261015T060221-71435a85/. Actual runtime receipt .dork/local-browser/desktop-proof/1792062211875/ passed private identity, shipped Playwright1.63, native embedded capability, reset and first-run prompt setup, then failed before opening Browser: RightPanelPage.open could not find its toggle within1000ms immediately after direct /session navigation. No Browser UI/native page/new-window pass is claimed. Source-only comparison with the successful CLI draft-session/readiness path is pending. All106 recorded PIDs/group83000 were physically absent in fresh census, marker absent; immediate Doc release preceded diagnosis. No retry was chained.

The desktop proof-only correction is source-complete and independently reviewed without findings. It now seeds an owned test agent, reserves the draft location through the existing absolute public API, builds an explicit UUID/draft/launchRef/runtime URL and waits for the shell, chat and panel toggle. The canonical agent directory must remain under the private boundary. Failure capture records the actual owned window/URL/body before quit within3 seconds and preserves the original error. No product/POM/store behavior changed. A separately requested120+30 source gate starts with zero-warning lint on this file, then exact-file formatting and proof/E2E8GB types; no runtime retry or test has run.

Desktop-ready-01 source gate PASSED: attempt20261015T061052-aba33d0a, zero-warning affected-file ESLint first, actual maintained-file format write/check, proof-runner types and E2E8GB types. All15 recorded PIDs/five groups were absent in fresh census, exact marker absent; immediate Doc release preceded interpretation. No test/native/build/package command was chained. The maintained proof correction and ledger are being staged/frozen before a separately granted fresh desktop runtime retry; this source pass alone does not qualify the desktop feature.

The separately granted desktop retry attempt20261015T111207-1149dbce again passed fresh package integrity but failed before Browser UI. New pre-quit evidence worked: desktop-proof/1792062789017/failure-renderer.png and receipt show the app's person-only folder refusal. Root viewed the actual frame. Source trace identified a proof error: the new draft route navigated to the host API127.0.0.1 origin while the normal desktop transport uses localhost. The cross-site GET session-location and project resolution were correctly refused. Preserve the actual verified renderer origin; do not relax the person bar. The router also normalizes draft1 to a JSON-quoted search value, so route assertions must use its semantic value. These proof-only corrections are under source review. All164 observed PIDs/group91091 were physically absent, marker absent, and immediate Doc release preceded diagnosis; no retry chained. Candidate archive911be5cd3b0f1178b4a90e8435eb8b275b5bb8050e50945c834a21570abc3ab1 remains an unqualified runtime candidate.

The origin/semantic-draft correction passed SAMEdesktop-ready source gate attempt20261015T062532-6f4fb3aa: all five commands exit0, zero-warning affected-file lint first, actual exact-file format write/check, proof and E2E8GB types. All15 PIDs/five groups were physically absent, exact marker absent; immediate release preceded result readback and returned the next slot to Doc's Linux diagnostic. No runtime was chained. Staging/freezing this proof-only correction before requesting a separate desktop retry.

The new inspector mechanism draft passed its separately granted PURE source gate: native-artifact-cli-proposal/preflight/attempt20261015T063540-1e0a44de. All15 commands exit0: seven-root types FIRST, actual formatter output for18 exact ignored paths via owned empty ignore file, historical tsx missing-helper negative plus actual raw callbacks, inspector protocol/boundary/single-fork/invalid-env/closing/disconnect/late-ack controls, common bootstrap canonical/private-alias/foreign guard VM cases, ten CJS syntax checks and three Python AST parses. No app, inspector, browser, build, install, model or actual artifact qualification occurred. Shared raw bootstrapSHAcbd31d376ac34b5d9bdf93a0f0c06dc1e633b109405240e8771b2215e4bb8a16; inspector probeSHA3cbf27eb8d91da58fe511860314e504df03962a312440794c58f06a665d4bf49. All23 observed PIDs/15groups were physically absent, exact marker absent; immediate Doc release preceded readback. This corrects the earlier ignored-formatter no-op with actual file processing and post-format controls. Native mechanism feasibility and all native-channel acceptance remain unproved.

Desktop-final attempt20261015T114806-3c05b58b passed fresh package integrity, but runtime desktop-proof/1792064952736 stopped at app-shell readiness with the actual welcome overlay still showing. Root viewed failure-renderer.png; correct localhost draft URL retained. Source trace found the fixture race: the first renderer latches onboarding before the later external dismissedAt patch; that patch cannot close the active latch, and boot query restoration can repeat it. Prelaunch seeding of the same allowed nonaccount prompt fields in the existing private config is the minimal correction; public guarded postboot setup/readback and actual UI checks remain. No account/runtime/credits/cache/store change is needed. Current failed candidate archivee4f4b5c17a783828b45e75a1ddc0874f8879245d5a6255e59dcd47f4b2486168, package evidence final20261015T064806-3148d89a. All147 PIDs/group33123 physically absent, exact marker absent; immediate Doc release preceded diagnosis. No runtime retry or source gate was chained.

The coalesced source correction gate PASSED: native-artifact-cli-proposal/preflight/first-pause/desktop-combined20261015T065738-1b8650e0. All10 commands exit0: zero-warning maintained proof lint FIRST, actual maintained format write/check, proof/E2E8GB types, exact three ignored CJS files actually formatted through owned empty ignore, actual first-pause/protocol/boundary/bootstrap mock suite and three syntax checks. No seven-root or retired controls were repeated, and no native app/browser/inspector/build/model ran. All23 PIDs/10groups physically absent, exact marker absent; immediate Doc release preceded interpretation. Prelaunch prompt seed/readback and conservative first-pause admission are source-qualified only. Native readiness may now be re-requested with the explicit current candidate receipt; no grant or runtime pass is inferred.

Supported inspector attempt native-artifact-inspector-feasibility/attempt20261015T070029-a2e570a8 FAILED readiness. The exact utility_init first pause (script127,line1,column0,offset70), AST entry proof and preimport raw guard installation/readback/three dummy tests passed on replacement utility44442 with private canonical home and real HOME preserved. After resume, Node scheduled its separate ESM startup pause: Break on start, empty hit IDs, actual packaged playwright-core/index.mjs script184,line0, ancestry #asyncInstantiate in node:internal/modules/esm/module_job. The original restart promise could not settle while paused; the operation deadline expired. Permanent request fence revoked, normal close resolved. No browser open, Chrome, tool or model request occurred. Candidate bytes, shared native identities and helper hashes remained unchanged. All18 recorded PIDs/group44340 were physically absent, exact marker absent; immediate Doc release preceded diagnosis. Partial guard success does not qualify the mechanism or feature. A source-only bounded post-GUARD single-pause proposal and identity-first repeatable guard tests are being implemented; first-pause rules stay unchanged. Separate source review/gate and explicit native grant remain required before retry.

Fresh desktop-final attempt20261015T121205-a92cdce4 PASSED normal build/package and actual packaged desktop runtime: .dork/local-browser/desktop-proof/1792066392775/receipt.json is passed-bounded-packaged-desktop-proof. Private first-run prelaunch seed matched guarded public readback; renderer shell/chat/panel choices passed. Actual embedded guest146 matched selected page, native attached bounds and varied pixels; panel hide/reopen preserved the same connection and guest. Actual shipped Playwright1.63 automatically acquired Chromium153 into fresh private cache. Embedded and new-window fixture cookies survived normal app quit/reopen, with installer proxies unavailable. Root viewed actual renderer-browser-panel-first.png and native-browser-panel-first.png. This qualifies these two modes only; native existing-channel consent remains open. Package .dork/local-browser/package-integrity/final-20261015T071205-25ad2f2e/receipt.json passed full33,125 payload hashes/721 frozen desktop inputs, unchanged shared native inodes/hashes and helper hashes. ArchiveSHAa66b01a2f306cdda3de9a5e8b8f46ebee9200b495ab192008dc08b1ef591f0e9, bundleDigest9a9a66986271bf0a3715af263f69044810a1383a770f9bffcf469867d6857f78, sourceDigestd66bebf5541b0e67a7010bebf75455b1dc694a09fdab7c17e3ee73a430ffe227. All278 recorded PIDs/group54217 absent in fresh census, exact marker absent; immediate Doc release preceded outcome interpretation. No personal app/browser or model touched. No next producer was chained.

Post-GUARD ignored inspector delta and its separately prepared exact-four-CJS source gate are independently source-reviewed without findings. The first preimport pause remains unchanged; exactly one known postguard Node ESM startup pause is allowed only after same PID/context/owned module/ancestry/live guard attestation. Original restart promise/deadline remain. Returned raw guard closure identity-checks all three readers before dummy calls, suppresses only deliberate self-test logs in try/finally, and repeats after server readiness; actual fakefs/admission/refusal/disconnect/lateack mocks cover the new paths. Gate is .dork/local-browser/native-artifact-cli-proposal/preflight/post-guard/run.py, global60+30, owned empty ignore, exact four format write/check, actual mock result assertions and four syntax checks, frozen SHA/read-only dependency enforcement. It has NOT executed; separate request queued with Doc. No mechanism or native-channel pass inferred.

The separately granted post-GUARD PURE source gate PASSED: .dork/local-browser/native-artifact-cli-proposal/preflight/post-guard/attempt20261015T071734-5b711df9/receipt.json. All seven commands exit0, actual opt-in formatter processed four exact CJS files, format check passed, actual mocks reported all five new controls and existing protocol/raw controls true with executedNativefalse, and four syntax checks passed. Read-only dependencies unchanged. Root reread formatted actual postguard consumer. All11 recorded PIDs/seven groups62093/62117/62143/62157/62164/62171/62180 absent in fresh census, marker absent; immediate Doc release preceded interpretation. No app, inspector or browser ran. A separate mechanism-only150+30 request is queued with explicit newly passed package receipt final20261015T071205-25ad2f2e/receipt.json SHA89c2889477144a3ab95b448b994664f1b9f51f6bff42567cd32fe0e9c2d17cb7; no grant or native qualification inferred.

Supported inspector mechanism PASSED its separately granted actual A150 attempt .dork/local-browser/native-artifact-inspector-feasibility/attempt20261015T072045-b241b833/. Driver/outer status passed-normal-app-node-inspector-mechanism-only; actual utility64766 initial script127 entry offset70 and source AST proved preimport guard installation. Exact one subsequent owned PW ESM Break-on-start was admitted after live PID/execPath/home/data/env/guard and all three identity-first selftests; original renderer restart resolvedok. Postready actual guard tests again passed with identities unchanged, passive API reported private data and disconnected Browser/PW1.63. Guard sourceSHA108aadaf53600a8ce7c2a63f49b59fa2bfde4c75dbb0a35d1ed644bc512195e9. Newly passed explicit desktop input receipt SHA89c2889477144a3ab95b448b994664f1b9f51f6bff42567cd32fe0e9c2d17cb7 preserved; candidate bytes/shared natives unchanged and normalclose resolved. All18 recorded PIDs/group64562 absent in fresh census, marker absent; immediate Doc release preceded interpretation. No Chrome, native discovery, browser open, scoped tool or model ran. This qualifies only the supported guarded fixture mechanism, not existing-browser consent or feature acceptance. Native UI-method human approval remains pending. Source-only plan for complete desktop native outer is recorded in native-artifact-desktop-proposal/SUPPORTED-INSPECTOR-PLAN.md; old desktop --require adapter/bootstrap lifecycle must be replaced, reusing only public renderer/API mappings.

First exact normal pnpm verify attempt .dork/local-browser/delta-batches/normal-verify-01/attempt20261015T073109-93a9453b FAILED in test:scripts before root lint or affected types/lint/tests. Shell/Node script fixtures passed; script Vitest had818/819 tests pass across47 files. The only failure was check-vocab-gate.test.ts's real-repo canary: local-browser/openapi.ts20 used the retired network-health noun in 'The current browser connection'. Minimal source correction is 'Current browser state', independently source-reviewed without findings; schemas/routes/statuses unchanged. No allowlist or guard weakening. Normal OpenAPI regeneration should change exactly seven response descriptions, and a narrow lint-first/export/103-case vocab/format gate is being prepared, not executed. All1713 observed PIDs/group75610 absent in fresh census, marker absent; immediate Doc release preceded detailed diagnosis. Frozen tracked/index/dependency state remained unchanged during the failed run. The failed receipt remains failed; normal verification has not passed.

The separately granted vocabulary correction gate PASSED .dork/local-browser/delta-batches/vocab-correction-01/attempt20261015T073805-58c9633f/: affected OpenAPI ESLint0 FIRST, normal docs:export-api regeneration,103 vocabulary tests in one file, source formatting. Whole-JSON equality verified exactly seven200response descriptions changed and no other schema/doc semantics. Generated JSON is intentionally Prettier-ignored; no generated-format claim. All16 observed PIDs/groups19238/19263/19322/19397 absent in fresh census, exact marker absent; immediate Doc release preceded interpretation. Narrow code/docs correction is staged before separately requesting the same normal pnpm verify retry. No browser behavior or schema changed; prior packaged receipts remain historical evidence of their exact bytes. Final artifact custody must bind the final maintained sources before native feature acceptance.

The complete ignored desktop native outer source underwent independent review; three concrete blockers were corrected before native execution: strict127guarded first-run helper versus actual localhost renderer/POM origins, exact seed-agent path derived from private boundary, and healthy final inspector fence required after asynchronous cleanup in runner and driver. Prepared PURE120 source gate then PASSED .dork/local-browser/native-artifact-desktop-proposal/preflight/source-gate/attempt20261015T074240-7f979683/: two-root/transitive types FIRST, actual twoTS/probeCJS/config formatting, actual mocks, probe syntax and two Python AST parses only. Actual mock result included cleanupWindowDisconnectRefusedtrue and all prior guard/pause/protocol controls, executedNativefalse. All12 recorded PIDs/six groups23075/23136/23167/23190/23204/23211 absent in fresh census, marker absent; immediate Doc release preceded interpretation. No app/browser/inspector ran. Subsequent executable hash readback exactly matched gateafter; only two preparation notes changed. The author's late joined notice identified source-boundary/mock-controls as newly changed CJS inputs: those were bound read-only and executed by the actual mocks, but not formatted by this gate. Final independent helper/control rereview and a separately granted tiny two-CJS format/mock/syntax delta remain before promotion; no whole-source qualification overclaim. Normalverify900 retry remains queued behind Foundation publication priority.

The final two-CJS cleanup-window source delta PASSED .dork/local-browser/native-artifact-inspector-feasibility/preflight/cleanup-window/attempt20261015T074734-a121d215/: all five commands exit0, actual exact-two opt-in format write/check, actual cleanup-window plus all16 guard/pause/protocol control flags true with executedNativefalse, two syntax checks. Only permitted mock-controls formatting changed; all read-only input hashes unchanged. All9 observed PIDs/groups28752/28770/28792/28804/28813 absent in fresh census, marker absent; immediate Doc release preceded interpretation. Final helper/callsite/actual-protocol-loss negative independently re-reviewed without findings. All complete ignored native fixture source checks now pass; actual native consent/feature acceptance remains unexecuted. Source-only minimal maintained-promotion dependency plan is being prepared, with no machine-private date-pinned cache paths or ignored runtime-source imports to ship. Normalverify900 retry remains queued/ungranted behind Foundation publication priority.

Second exact normal pnpm verify attempt080345-282519eb FAILED after all819 script tests/47files and shell/Node fixtures passed. Root ESLint then reported1,111 errors across42 files, all under the gitignored .dork/local-browser local draft/evidence directory; zero errors outside it. All1732 observed PIDs/group49103 absent in fresh census, marker absent; immediate Doc release preceded diagnosis; frozen tracked/index/dependency state unchanged. Existing root config intentionally lists named .dork runtime directories rather than a blanket ignore. Minimal correction adds only .dork/local-browser/**, with four actual ESLint resolver controls retaining lint for maintained scripts, future.dork source and similarly named siblings. CI stewardship and ci-status read first: fetched snapshot2026-10-14 reports stale local timing export from another clone, which this hygiene change does not fix. Hygiene ledger261015-131044 records evidence/revert condition, no metric/ratchet/required-check/retry/timeout change. Independent source review found no blocker. Smallest lint-first/4test/script types/root lint/census/ledger/coverage/format gate is being prepared; no verification pass or retry inferred.

Root-lint output-scope correction PASSED its separately granted180+30 gate delta-batches/root-lint-output-01/attempt20261015T081803-b9f7ddc4. All9 commands exit0: affected config/test ESLint0 FIRST, exact3format write/check, actual4ESLint resolver cases in one file, script types, normal root lint, CI census, ledger and coverage at actualbase73dc7cb. Frozen state and read-only dependencies unchanged. All29 observed PIDs/nine groups physically absent, exact marker absent; immediate Doc release preceded interpretation. Named runtime output exclusion does not exempt maintained browser scripts or unrelated.dork paths. Full normalverify is still not green; its next run will follow maintained promotion and focused gate convergence.

HUMAN UI-method authorization is now explicit: Allow disposable Chrome only, for PID-specific AppleScript extension/nativepermission/freshsame-tab navigation. Before each action bind the active proof admission, exactPID/start/profile/lease and foreground target; no personalChrome/TCC/clipboard/CDP shortcut. Source-only PIDoperator review/migration is in progress; no actual native UI run yet.

PID-only disposable Chrome operator pure preflight PASSED .dork/local-browser/native-ui/preflight/attempt-20261015T082451-f1ded2ca/receipt.json: Python AST parsed without importing the operator, and AppleScript compiled without execution. Compiled artifact SHA6f147a73e06086b2979e025eac0321d49a004579d83d021086b6894ac67dea3c, 19,018 bytes, mode0600. Both commands exit0; two PIDs/groups7574/7588 absent, exact marker absent; immediate Doc release preceded interpretation. No UI ran. Human has explicitly authorized disposable Chrome only; actual PID admission and foreground checks remain mandatory for every action.

Maintained native-proof promotion source review converged after correcting build-to-artifact provenance, prelaunch prompt seed/readback and interrupted command evidence retention. Root applied exactly28 manifest targets after confirming no heavy marker and verifying every proposed and previous SHA. Apply receipt .dork/local-browser/maintained-promotion-proposal/apply-receipt.json binds manifestSHA6e08949e8d658bb899a649449b9896ec0f6b09d1a9657361ddd6cd3997cf2170. No source checks or runtime executed for these maintained files yet. Focused lint-first/type/control/syntax/format gate is being prepared; normal verification and final artifact/native proofs remain pending.

First maintained promotion source gate attempt20261015T083013-c2ba7657 FAILED at affected lint FIRST:38 errors and33 warnings across the promoted native harness (missing exported-function JSDoc, loose callback/receipt types, proof-boundary environment reads, CJS quote escapes/window global, prefer-const and one unused binding). Formatter, types and controls were not reached. No app/browser/build/inspector ran. All6 observed PIDs/group15065 absent in fresh census and exact shared marker absent; immediate Doc release preceded log interpretation. Source author is correcting only concrete findings in promoted sources without config exemptions; no follow-up grant inferred.

Concrete lint correction source review converged: exported functions documented, explicit receipt/inventory/API/Playwright types replace any/Function, standalone proof-boundary environment reads carry narrow reasons, const cleanup timer holder is registered before awaits, CJS escape/global correction and unused binding are mechanical. Critical runtime source/build/archive/native/normal-close/inspector assertions remain. Root verified all28 tracked files exactly match mirror and amended manifestSHA3d12277dd0b35f80a1e5959c6fbbe3295ebf12ecad25f838e04bd319a99bd891. No checks yet. Potential attended45s wait concern was traced and dismissed: CLI host wrappers and desktop renderer poll already use remaining operation deadline; separately bounded reads/service calls remain unchanged. Final amended-manifest gate read and fresh separate Doc grant are pending; slot reserved for Foundation protected rearm priority.

Second focused promotion attempt20261015T083931-a979e2e1 PASSED affected27TS/CJS ESLint0 FIRST and actual28-file Prettier write/check, then FAILED proof-runner TypeScript with9 concrete diagnostics: five imported modules use one excessive parent segment, three recursive ASAR values need explicit annotations, and a capabilities response used default State. Normal script types and actual controls/audit/syntax were not reached. No native/browser/build/model ran. All12 observed PIDs/groups26967/27020/27047/27070 absent in fresh census and exact marker absent; immediate Doc release preceded diagnosis. Source author is fixing only these findings and preserving formatted sources; next run needs reviewed amended manifest and separate grant.

Third focused promotion attempt20261015T084233-928735b7 FAILED lint FIRST with0errors10warnings: the preceding actual Prettier pass moved five narrow environment next-line directives away from the process.env expressions they describe. This is a formatter stability issue; prior types remain unqualified. All3 observed PIDs/group29991 absent in fresh census and exact marker absent; immediate Doc release preceded interpretation. Five short local environment assignments are being used to keep the comments attached through formatting. Source gate will add affected lint after format under the same180+30 global ceiling, exact28targets unchanged, so future drift is caught immediately. Updated gate command requires independent review and new explicit grant; no runtime executed.

Fourth focused promotion attempt20261015T084508-09231fa2 PASSED27-file lint FIRST, actual28format write/check, added27-file postformat lint and proof-runner types. Normal repository script types then FAILED noUncheckedIndexedAccess: bundle entry may be absent, and existing source-snapshot readPackedProof packed[0] needed an explicit assert after its length assertion. Actual controls/audit/syntax remain unreached. All18 observed PIDs/groups32688/32729/32760/32790/32822/32847 absent in fresh census and exact shared marker absent; immediate Doc release preceded interpretation. Author authorized only two explicit existence guards, source-snapshot becoming29th source target; gate exactscope29/28lint/7CJS, same180+30, newreview/grant required. No config/type weakening or native execution.

Maintained promotion source gate PASSED attempt20261015T085138-b7fa7218 after the minimal presence assertions. All15 commands exit0:28-file ESLint0 FIRST; actual29format write/check;28-file postformat ESLint0; proof-runner and normal script types; actual2tests/1file controls including stale built-payload refusal; actual maintained-callsite/raw-callback audit reporting executedNativefalse;7CJS syntax checks. Frozen tracked/index/outside-target and read-only inputs unchanged. All31 observed PIDs/15groups absent in fresh census and exact marker absent; immediate Doc release preceded outcome interpretation. No app/browser/build/model ran. This qualifies maintained source only, not native consent. No further proof scaffolding expansion is planned; next required step is normal pnpmverify, then final source-bound artifacts and actual native proof.

After the focused source pass and before normal verification, source inspection found the exported resources.operationFence helper had no callers; both workers already use their separately proved fences. Removed only this unused helper and its now-unused bounded import, per the no-dead-code standard. No active fence behavior changed. This narrow deletion will be verified by the upcoming normal script types/tests/root lint, rather than expanding the proof harness or rerunning unrelated source gates. The preceding focused receipt remains evidence of its exact earlier bytes.

Third normal pnpmverify attempt20261015T091702-e6728c2b FAILED at server TypeScript heap exhaustion, inner137, not a compiler diagnostic. All825 script tests/49files, shell guards and rootlint passed; Turbo60/65 lint/type tasks succeeded before V8 reached its approximately4GiB default heap. Package tests were not reached. Existing unchanged site/evals test lint warnings were reported; no zero-warning whole-repo claim. Frozen source/index/refs/dependencies remained unchanged. All1773 observed PIDs/group64345 absent in fresh census and exact shared marker absent; immediate Doc release preceded diagnosis.

Local-only resource retry prepared and independently source-reviewed: the same pnpmverify900+30 with fixed NODE_OPTIONS=--max-old-space-size=8192 and TURBO_CONCURRENCY=1 after inherited preload/credential sanitization. Existing ignored ops helper admits this profile only for exact argv pnpmverify; default other-producer behavior is unchanged and actual receipt records/asserts both values. Turbo2.10.13 officially passes NODE_OPTIONS in strict mode; no loose mode, config override, skipped check or tracked CI change. Existing .github/workflows/typecheck.yml already supplies this8GiB heap (line433), as do test/build workflows; local inherited NODE_OPTIONS was absent. The retry aligns with that compiler resource allowance and serializes tasks to bound peak memory. No launch/grant yet; Root Doc/Room reproductions have priority.
