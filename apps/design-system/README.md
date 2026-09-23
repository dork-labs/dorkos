# Shared UI catalog

The catalog shows the portable tokens and controls exported by `@dork-labs/ui`. It runs without a DorkOS server or client providers. Client feature simulations and app-specific galleries remain in `/dev` in the client app.

Build the public UI package once in a fresh worktree, then choose a free local port:

```bash
pnpm --filter @dork-labs/ui build
pnpm --filter @dorkos/design-system dev --port 6250 --strictPort
```

The catalog links to `http://localhost:6241/dev` by default. Set `VITE_DORKOS_PLAYGROUND_URL` to another client playground URL. The client playground links back to `http://localhost:6250` by default; set `VITE_DORKOS_CATALOG_URL` for a different catalog port. The catalog's own CSS imports Tailwind 4 first and `@dork-labs/ui/tailwind.css` once after it.
