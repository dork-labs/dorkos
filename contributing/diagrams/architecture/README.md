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

Each source includes an accessible title and description. The fixed light background and dark labels keep exported images readable in both light and dark docs pages. Diagram arrows show primary operation/data direction, not every response. Dashed edges are explicitly labeled: unfinished wiring or a schema relationship, never an unexplained status.

After changing a source, regenerate its SVG, inspect it at reading size, and check its labels against the code pointers in the guide. Keep implementation status in the prose and diagrams aligned. A parser succeeding proves syntax, not architectural accuracy.

The hosted-community view separates implemented host capabilities from planned Cloud and app wiring at the guide’s pinned snapshot. Keep dashed edges until composition and callers exist; a tracker parent marked Done or a published schema alone is insufficient. The runtime-tools view separates the internal loopback listener from external `/mcp`.
