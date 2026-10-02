# Served-document isolation (DOR-2663)

Signed files currently inherit the app's origin when their URL is opened directly. The iframe sandbox protects only embedded navigation.

## Acceptance criteria

1. Every response through the signed serve handler carries a CSP sandbox with `allow-scripts allow-forms allow-popups allow-modals`, without `allow-same-origin`. Cover HTML, SVG, PDF, opaque downloads and assets.
2. Embedding is limited to the response's own origin and concrete trusted app origins. Reuse `resolveAuthTrustedOrigins` so local web/Vite, configured desktop development and the live tunnel remain supported. Do not emit `X-Frame-Options: SAMEORIGIN`, which would reject the supported separate desktop origin.
3. Chromium direct HTML navigation attempts an API read and write. Ingress counts both attempts, a same-origin app control succeeds, and the hostile page cannot read responses, cookies, storage or its app opener. The denied write does not reach the fixture handler.
4. Direct SVG script execution cannot read the API response; its attempt is counted.
5. App-origin and separate desktop-origin frames render relative assets and execute the actual injected DevTools shim, including hello/ack and console capture. An unrelated embedding origin is refused.
6. Signed-token verification, path confinement, existing shim injection and independent preview-origin behavior retain their existing coverage.
7. The permanent browser regression is discoverable by the normal repository Chromium project. A focused config may execute the same spec without booting unrelated legs.

## Scope and residuals

This does not redesign the page-world bridge, Doc Channel transport or managed browser engine. The sandbox does not make page reports trustworthy and does not forbid all outbound networking; the current API origin policy rejects opaque-origin reads/writes. The proof uses the real app middleware and signed route, with synthetic API handlers and cookies, ephemeral ports and a temporary home. It does not use personal accounts or run inference. Tunnel embedding receives header-level coverage, not a real tunnel account/browser deployment.
