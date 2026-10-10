# Architecture diagram sources

These Mermaid sources own the diagrams in [the system architecture guide](../../system-architecture.md). Generated SVGs live in `apps/site/public/diagrams/architecture/` so both repository Markdown and the docs site can use the same images. Do not edit SVGs by hand.

Use Mermaid CLI **11.12.0** and the checked-in `mermaid.json` configuration. From the repository root, with that CLI available:

```sh
for source in contributing/diagrams/architecture/*.mmd; do
  name=$(basename "$source" .mmd)
  mmdc -i "$source" \
    -o "apps/site/public/diagrams/architecture/$name.svg" \
    -c contributing/diagrams/architecture/mermaid.json \
    -b white -w 1800
done
```

The CLI uses Puppeteer. If using an existing browser instead of its bundled Chromium, pass `-p <config.json>` with an `executablePath` for that machine. Do not commit a machine-specific browser path.

Each source includes an accessible title and description. The fixed light background and dark labels keep exported images readable in both light and dark docs pages. Current-state diagram arrows show primary operation/data direction, not every response. Dashed edges are explicitly labeled: unfinished wiring or a schema relationship, never an unexplained status. The separately titled `vision-reset-target` is entirely planned; its solid arrows show proposed relationships, not implemented wiring.

After changing a source, regenerate its SVG, inspect it at reading size, and check its labels against the code pointers in the guide. Keep implementation status in the prose and diagrams aligned. A parser succeeding proves syntax, not architectural accuracy.

The Cloud views were rechecked against the public source on 2026-09-27. Solid edges show implemented public-side wiring, not a deployment guarantee. Dashed hosting edges describe the public service contract; destination availability must be checked separately. The hosted-community view includes the implemented local start/move relay and direct archive upload. The account-handover view shows conditional routing, not the production switch state. The runtime-tools view separates the internal loopback listener from external `/mcp`.

The Cloud boundary was updated on 2026-09-28 at public source `2a847e0236dd643b6490acde294788de51bcf90e` for authenticated `/v1/session` identity before inference minting under the same current link. Credits launch wiring is Claude Code only. The managed remote consumer remains a draft with enrollment and ingress gates; solid app-side arrows still do not certify service deployment.

The October 1 review pins public source `996161118a84f938fe76b6e569ba077dfb7a574a`. System, Community, hosting and marketplace views now include Projects/extension orchestration, installation-qualified agent credentials, revocable mirrors, implemented import/multipart upload, configurable OIDC, scoped moderation/evidence and marketplace preservation. `projects-extensions.mmd` separates reported roots, source trust, project enablement, Activity decisions and account-qualified launches. Cloud-hosting availability remains a public contract relationship; no new live deployment is inferred.

The October 4 assessment pins source `116297e14f7c357d24010ba34b9ceaa1b44aef99`. Cloud and account-handover views supersede the older Claude-only/flag-based credits and managed-exclusion notes above. Runs on choice authorizes credits, with runtime-specific scope and token-format gating. Managed compatibility forwarding has its own switch. Neither view certifies the production configuration. Isolated extensions and managed browser foundations are still distinct from production activation.

The October 9 vision-reset review pins source `417bd3a33fb99a80c0184800a33432f09e44f4f8`. Doe is now in the runtime census; decision bridges exist without production consumers, and managed remote enrollment/ingress contracts are settled while implementation/deployed acceptance remain pending. Isolated extension production activation supersedes the earlier foundation-only note. `vision-reset-target` describes the accepted one-program direction and proposed command/persistence/execution seams; it is not a replacement current deployment diagram. Its entire title, description and legend mark it as planned.
