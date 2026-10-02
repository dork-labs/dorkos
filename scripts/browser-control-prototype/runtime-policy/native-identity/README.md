# Unchanged native identity research

**Proposed Phase1 evidence only. Aggregate UNVERIFIED.** No generated package patch or UA/metadata/header override is applied. This does not resolve the user's Chrome-compatible preference and is not production activation or native full-matrix readiness. The earlier rejected metadata candidate and its ordering/acquisition failures remain intact in the parent directory.

## Module ownership and isolation

This new leaf owns its HTTPS fixture, native child, IPC/lifecycle wrapper, runner, exact research pins and tests. Installed Playwright1.63.0 is loaded through the existing read-only runtime loader. The unpatched bundle SHA256 is `549070af3acabb3efcc4f55bfe6210f9f7c2fcf633cf7eaa59bfe60719969171`; the exact Darwin-arm64 Chromium153.0.8010.12/revision1243 executable SHA256 is `8319963f6625accf51c0dd4f55091ceaf9f09ed39e7a52fed4fae12b2a6b668a`. Both pins refuse a different source/runtime, and the installed bundle is checked unchanged afterward. These are this host's research pins, not cross-platform claims.

The reviewed parent wrapper hardcodes its rejected-candidate child path, so this leaf owns a copy of the same exact PID/birth and observer-failure cleanup semantics with its own native child. It removes the unused held-install event and explicitly avoids inheriting parent Node execution flags. It does not modify the accepted wrapper. Node-only tests verify healthy cleanup and whole-table observer failure (`ps -axo` fails, strict `ps -p` still works) before later browser acquisitions. Observer failure still attempts graceful close/known identity cleanup and preserves UNVERIFIED inventory, never invented allGone. All cleanup addresses only owned identities; no operator processes or process groups.

Two distinct sites, `native-a.test` and `native-b.test`, bind owned 127.0.0.1 listeners. Per-runtime `--host-resolver-rules=MAP native-a.test 127.0.0.1, MAP native-b.test 127.0.0.1` maps only those fake hosts. No DNS/system trust changes occur. A private generated SAN certificate supplies one exact fixture-only `--ignore-certificate-errors-spki-list` fingerprint; no general TLS bypass. The launch explicitly sets `chromiumSandbox:true`; actual owned arguments contain no no-sandbox or user-agent override. The SPKI/mapping exceptions are never production policy. See the [pinned network switch declarations](https://raw.githubusercontent.com/chromium/chromium/153.0.8010.12/services/network/public/cpp/network_switches.cc).

## Actual Phase1 matrix

The child uses an ordinary clean context with no identity option, init script, route interception or request-header replacement. A native Page embeds a truly cross-site iframe. Read-only `Target.getTargets` records an `iframe` target ID and the exact evaluated frame URL; it never attaches a competing debugger/autoattach controller. The browser's existing Playwright target owner remains authoritative.

Six completed identity reports are counted from actual results: initial Page, cross-site frame, reloaded Page, dedicated worker, shared worker and service worker. They agree on native UA/appVersion/platform/secure context and native UAData, including fullVersionList, architecture, bitness, model, platformVersion, wow64 and formFactors. Native MacIntel/10_15_7 reduced legacy conventions remain alongside native arm/64/macOS26.6.2 metadata. The native HeadlessChrome token remains unchanged.

First Page/frame HTTP UA and low hints agree with that descriptor. The top-level Page and delegated OOPIF negotiated HTTP hints also agree, including native distribution/GREASE brands/full versions and all observed high fields. Initial worker script requests and worker fetches carry matching native legacy UA, but **emit no HTTP Client Hints** in this fixture. Worker JS UAData is observed separately; it cannot fill missing HTTP observations.

The fixture's top response delegates `ch-ua-arch`, `ch-ua-bitness`, `ch-ua-full-version-list`, `ch-ua-platform-version`, `ch-ua-model`, `ch-ua-wow64` and `ch-ua-form-factors` to the two exact origins with Permissions-Policy. The [official Chromium guide](https://developer.chrome.com/docs/privacy-security/user-agent-client-hints#hint_scope_and_cross-origin_requests) documents cross-origin delegation; the [pinned feature declarations](https://raw.githubusercontent.com/chromium/chromium/153.0.8010.12/services/network/public/cpp/permissions_policy/permissions_policy_features.json5) identify these names.

## Controlled availability evidence

- With delegation, the actual matching OOPIF emits native high HTTP hints. Remove that real response policy while keeping the same fixture behavior: the exact OOPIF still runs and its JS identity agrees, but the negotiated frame request loses high hints. This is an observed fixture-policy effect, not an intentionally wrong expected value. It remains UNVERIFIED HTTP coverage.
- For each `/fetch-dedicated`, `/fetch-shared` and `/fetch-service` endpoint, the worker sends native UA with no hints, then a Page fetch to the **same exact endpoint** emits matching native high hints. The server/HTTPS/header observer can therefore observe those fields; their absence in the worker request is not hidden by rewriting headers or a failed endpoint observer.
- Pinned [WorkerFetchContext](https://raw.githubusercontent.com/chromium/chromium/153.0.8010.12/third_party/blink/renderer/core/loader/worker_fetch_context.cc), lines181–228, sets worker HTTP UA and adds Save-Data, with an explicit note that workers lack a permissions policy from which to derive proper hints. Pinned [FrameFetchContext](https://raw.githubusercontent.com/chromium/chromium/153.0.8010.12/third_party/blink/renderer/core/loader/frame_fetch_context.cc), lines592–625 and925–932, applies frame hint generation through document permissions policy. This source evidence supports the observed worker-fetch omission; it does not prove every future worker/protocol/lifetime omits hints.

**Proposed availability clarification, not accepted:** bind each observation to its actual target, request and lifetime; compare every emitted native identity field; record omitted native HTTP hint fields as unavailable separately from matching native JS metadata/legacy HTTP UA. Do not require invented hints or silently normalize missing fields into success. Full matrix acceptance remains open until this interpretation receives independent design review and required target/lifetime cases are measured. The runner keeps aggregate UNVERIFIED meanwhile.

## Retained receipts and verification

Earlier controlled pair: `/var/folders/64/06xfpz_s2kj5xc29cmm6f2fw0000gn/T/native-final-policy-ArDs3A/`. It precedes the final explicit evaluated `frameUrl`/`pageUrl` receipt fields and frame-to-target binding check; it is not evidence for that final check.

- `delegated/native-receipt.json`: native Page/OOPIF/reload/three-worker JS and legacy HTTP coherence PASS; six actual subject reports; worker HTTP-hint coverage UNVERIFIED; all five recorded exact identities gone.
- `no-delegation/native-receipt.json`: UNVERIFIED `NATIVE_HIGH_HINT_NOT_EMITTED:/frame-negotiated`; six reports still observed; all seven recorded identities gone.
- Original strict nondelegated fixture run remains `/var/folders/64/06xfpz_s2kj5xc29cmm6f2fw0000gn/T/unchanged-native-NQkUr7/probe/native-receipt.json`: FAIL for missing expected high HTTP header, exact OOPIF target and coherent JS observations retained, five recorded identities gone. The delegated fixture correction does not erase it.
- The first retained-pair invocation inherited parent `--input-type=module` into a file-based worker and failed before Chromium acquisition. Both UNVERIFIED receipts remain under `/var/folders/64/06xfpz_s2kj5xc29cmm6f2fw0000gn/T/native-final-policy-tXlAQZ/`; each has its one owned Node identity gone. The new wrapper uses `execArgv:[]`, with a Node-only regression covering that invocation.

Run `node --test scripts/browser-control-prototype/runtime-policy/native-identity/cleanup.test.mjs scripts/browser-control-prototype/runtime-policy/native-identity/native.test.mjs`. The tests verify scoped coherence, actual OOPIF binding, same-endpoint positive controls, real delegation removal and fail-closed availability/cleanup reporting; a green harness does not mean complete native readiness. The CLI `node scripts/browser-control-prototype/runtime-policy/native-identity/run-native.mjs "$PWD"` returns nonzero for the aggregate UNVERIFIED receipt.

## Independent-review corrections and exact revised evidence

The emitted-field comparator now validates each present field independently of brand/full-version-list presence. A wrong emitted architecture, platform, bitness, wow64, form factor or full-version list fails even if `sec-ch-ua` is absent. Missing required fields return UNVERIFIED with exact missing-field names; unsupported emitted fields remain unavailable. Worker coverage uses that structured result instead of treating a single present brand header as complete high-hint success. No native availability exception has been accepted.

Both new Node-only regressions failed against the exact original comparator extracted from committed source, then passed after correction. Existing four scoped lifecycle/actual-fixture tests also passed. Browser correctness was rerun specifically to cover the final evaluated-frame binding and revised comparator, with no latency/resource sampling.

Corrected retained pair: `/var/folders/64/06xfpz_s2kj5xc29cmm6f2fw0000gn/T/native-corrected-policy-vZvafZ/`.

- `delegated/native-receipt.json`: `frameUrl=https://native-b.test:52021/frame`, exactly equal to the observed iframe target URL, target ID `F831BBBB9A8E7A10C62A358F7C45AEA7`; `pageUrl` is the actual native-a.test Page. Six reports, scoped coherence PASS, aggregate UNVERIFIED, five exact owned identities gone.
- `no-delegation/native-receipt.json`: `frameUrl=https://native-b.test:52043/frame`, exactly equal to iframe target URL, target ID `34D63CBBA6B58C96378B96B9CD2F0E3F`; six reports, `NATIVE_HIGH_HINT_NOT_EMITTED:/frame-negotiated` UNVERIFIED, six exact owned identities gone.

This pair ran the following exact source SHA256 values (independent of documentation/test edits):

- `headers.mjs`: `14d3b22456d8bc0e270bd3df2948e0fc3b4af334d104e77aa7413013f3f6b3b8`.
- `run-native.mjs`: `804765192fa70947b503e9b7a58f7789163d77c98ac5e17e9e6b583939c092bf`.
- `native-child.mjs`: `add5dc52e0cc18b196de89d7c0c928134083cc3c50979547fc5075d02e0def33`.

Phase2 remains paused for independent review of the availability interpretation. No private persistent reopen/restart, detached/background worker lifetime, nested worker, worker restart/update or other platform claim is made. No Chrome-compatible fallback, production network-policy success, OS containment or performance conclusion follows from this leaf.
