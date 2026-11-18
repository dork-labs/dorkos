# PR #3943 (DOR-4426) shots, head 6339bb2ee8

The real app, served from this head: a sandbox server (fresh data folder and home, test runtime, no real Claude sign-in) and the Vite client. The account "Studio" is made up. Each shot comes in four versions: light, dark, light-390 and dark-390 (390 px wide). The others are 1280 px wide. All at 2x.

- `settings-account-row-*`: Settings, Runtimes, Claude Code, the Studio row after Sign in failed.
- `signed-out-banner-*`: the signed-out banner after Sign in to Studio failed.

Four answers were filled in at the network edge so the failure could be shown without a real sign-in:

- Studio is marked signed out.
- The inbox holds one "sign-in stopped working" row for Studio.
- The sign-in request answers with the server's own `credential_store` line from `login-failure.ts`.
- The Claude Code card gets the real Claude Code settings declaration. The test runtime declares none, so the account list would not show.

Worth a look: at 1280 px both red lines sit beside the button, not under it. They wrap under the button only at 390 px.
