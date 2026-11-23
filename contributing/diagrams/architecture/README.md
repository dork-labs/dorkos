# Architecture diagram sources

These Mermaid sources own the diagrams in [the system architecture guide](../../system-architecture.md). Generated SVGs live in `apps/site/public/diagrams/architecture/` so both repository Markdown and the docs site can use the same images. Do not edit SVGs by hand.

## Rendering

Use Mermaid CLI **11.12.0** and the checked-in `mermaid.json` configuration. This Mac may not launch Chromium, so render with the CLI's Docker image, with the repository mounted read-write. From the repository root (replace the uid and gid with yours; the output files are then owned by you):

```sh
for source in contributing/diagrams/architecture/*.mmd; do
  name=$(basename "$source" .mmd)
  docker run --rm -u 501:20 -v "$PWD":/data minlag/mermaid-cli:11.12.0 \
    -i "/data/contributing/diagrams/architecture/$name.mmd" \
    -o "/data/apps/site/public/diagrams/architecture/$name.svg" \
    -c /data/contributing/diagrams/architecture/mermaid.json \
    -b white -w 1800
done
```

A local `mmdc` with the same version and flags gives the same output. If it uses an existing browser instead of its bundled Chromium, pass `-p <config.json>` with an `executablePath` for that machine, and do not commit a machine-specific browser path. Change `.svg` to `.png` in the output path to get a reading-size image for a review or a design sign-off. CI does not render diagrams; a changed `.mmd` without its SVG is a review finding.

## The style rules

Every diagram follows these rules, so the set reads as one. They came out of the November 21 restyle, after the roles view was reviewed as unreadable: no font hierarchy, group titles hidden under boxes, long lines crossing everything, labels far from their lines, and code in the boxes.

1. **One idea per diagram.** When a view needs more than about twelve boxes, or mixes two stories (the Cloud calls and the ways in from another device were one picture), split it and embed both. The guide's prose joins them.
2. **A box is a name and one short line.** The first line is the name, in bold. The second line, in the smaller muted style, says what matters about it here: at most two lines, about forty characters each. Write it as `["<b>Name</b><br/><span class='d'>Short detail</span>"]`. The `d` class is styled once in `mermaid.json` (`themeCSS`), so the sources never carry font sizes or colours.
3. **No code in boxes.** No file names, API paths, environment variables, config keys, class names, ADR numbers or ticket numbers. Those belong in the guide's prose and its Key Files table, next to the diagram. The exceptions are the names of ports and their implementations in the ports view (they are the subject), an event name in the sequence diagram (`turn_start` is the wire fact the diagram exists to show), and a product name.
4. **Short group titles.** A subgraph title is two to five words, with a status after a middle dot when the status is the point: `Hub · built, not deployed`. Never a switch or a variable name.
5. **Short edge labels.** Two to five words, lower case, in the voice of the arrow ("reads its assignment"). A second line in the muted style is allowed for one qualifier (`<br/><span class='d'>contract only</span>`). Say the protocol only where the guide makes the distinction (HTTP, WebSocket, SSE).
6. **One status key.** Default blue is built. Built but off by default, experimental or unregistered is still blue; the detail line says `off`, `experiment` or `not registered`, and a dashed edge may say why. `planned` (dashed grey) is only for what does not exist in the source yet. `cloud` (amber) is optional DorkOS Cloud. `external` (white) is outside DorkOS: a browser, a messaging platform, a package registry, an identity provider, a tunnel service; the DorkOS app and its CLI are never `external`, while an outside program calling our MCP endpoint is. `port` (green hexagon) is a port in the ports view. Copy the `classDef` lines from an existing source; the colours are the same in every file. A diagram that mixes built and planned carries a small `Key` subgraph; the others rely on the key sentence in the guide.
7. **Solid and dashed edges keep their meaning.** Solid is implemented wiring. Dashed is unfinished wiring, a schema relationship or a planned path, and the label says which. Built and planned must not change meaning in a restyle.
8. **Layout is ELK**, set once in `mermaid.json` (`layout: elk`), with the spacing there. Do not add per-diagram layout overrides unless a diagram cannot be read without one, and then say why in a comment at the top of the source. `TB` for views with groups, `LR` for lists of rows such as the ports view.
9. **Rich labels are HTML labels** (`htmlLabels: true`), so the SVGs carry `foreignObject` text. GitHub and the docs site both show them through an `img` element, which renders that text. Keep the light background and dark text so the image reads on a dark page too.
10. **Every source has an accessible title and description.** `accTitle` is the diagram's name. `accDescr` says what the diagram claims and what it does not, including the status of anything that is built but off by default.

After changing a source, regenerate its SVG, look at it at reading size, and check its labels against the code pointers in the guide. Keep implementation status in the prose and diagrams aligned. A parser succeeding proves syntax, not architectural accuracy.

## Content notes

Current-state diagram arrows show primary operation/data direction, not every response. Dashed edges are explicitly labeled: unfinished wiring or a schema relationship, never an unexplained status. The separately titled `vision-reset-target` is the roles view; built parts are solid and planned parts dashed.

The Cloud views were rechecked against the public source on 2026-09-27. Solid edges show implemented public-side wiring, not a deployment guarantee. Dashed hosting edges describe the public service contract; destination availability must be checked separately. The hosted-community view includes the implemented local start/move relay and direct archive upload. The account-handover view shows conditional routing, not the production switch state. The runtime-tools view separates the internal loopback listener from external `/mcp`.

The Cloud boundary was updated on 2026-09-28 at public source `2a847e0236dd643b6490acde294788de51bcf90e` for authenticated `/v1/session` identity before inference minting under the same current link. Credits launch wiring is Claude Code only. The managed remote consumer remains a draft with enrollment and ingress gates; solid app-side arrows still do not certify service deployment.

The October 1 review pins public source `996161118a84f938fe76b6e569ba077dfb7a574a`. System, Community, hosting and marketplace views now include Projects/extension orchestration, installation-qualified agent credentials, revocable mirrors, implemented import/multipart upload, configurable OIDC, scoped moderation/evidence and marketplace preservation. `projects-extensions.mmd` separates reported roots, source trust, project enablement, Activity decisions and account-qualified launches. Cloud-hosting availability remains a public contract relationship; no new live deployment is inferred.

The October 4 assessment pins source `116297e14f7c357d24010ba34b9ceaa1b44aef99`. Cloud and account-handover views supersede the older Claude-only/flag-based credits and managed-exclusion notes above. Runs on choice authorizes credits, with runtime-specific scope and token-format gating. Managed compatibility forwarding has its own switch. Neither view certifies the production configuration. Isolated extensions and managed browser foundations are still distinct from production activation.

The October 9 vision-reset review pins source `417bd3a33fb99a80c0184800a33432f09e44f4f8`. Doe is now in the runtime census; decision bridges exist without production consumers, and managed remote enrollment/ingress contracts are settled while implementation/deployed acceptance remain pending. Isolated extension production activation supersedes the earlier foundation-only note. `vision-reset-target` describes the accepted one-program direction and proposed command/persistence/execution seams; it is not a replacement current deployment diagram. Its entire title, description and legend mark it as planned.

The November 21 rebaseline pins source `14434634ff15978f4acaa561a445ac0b88c6555a` and supersedes the October 9 notes where they disagree. `vision-reset-target` is redrawn as the roles view of ADR `261015-042933`: one program as a person's computer, a hub or an agent computer, plus the space server entry, with built parts solid and planned parts dashed; the October "shared workspace command core" is gone because it is not the accepted shape. `system-context` and `community` show the space server as an entry of the same package with agents as members and an availability report. `ports` shows the decision ladder's two production callers and the `computer-local` runtime without a conformance suite. `runtime-tools` adds the VM bridge and `end_beat`. `cloud-boundary` shows the managed remote consumer as built behind its switch and the session relay as a path to a hub, not to Cloud. Role-gated and default-off still mean not deployed; the hub image has booted only in CI.

The November 21 restyle changed no status: every built piece stays solid and every planned piece stays dashed. It moved every code name, route, switch and ticket number out of the boxes into the guide, split the ways in from another device out of `cloud-boundary` into `remote-access` (which adds the Wi-Fi listener and the device-to-hub path, both already in the guide's connection table), collapsed the space server's internals in `community` to the parts the local side talks to (the hosted-spaces view keeps the internals), and put the style rules above into `mermaid.json`.
