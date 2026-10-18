# Build the real distributable apps before sealing the runtime network.
FROM node:24-bookworm-slim
# Where the space server lives, relative to the repository root. run.sh passes
# it from ci/space-server.env (DOR-3007); there is no default here, so a build
# that forgets it stops instead of guessing an old folder.
ARG SPACE_DIR
RUN test -n "$SPACE_DIR" || { echo 'Build with --build-arg SPACE_DIR=<folder>; run.sh reads it from ci/space-server.env.' >&2; exit 1; }
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /work
COPY . .
# The clean source context has no .git, so there are no hooks to install.
# Build the native dependencies explicitly; normal Git gates run on the source branch.
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild -r esbuild better-sqlite3 node-pty
RUN pnpm --filter @dork-labs/cloud-api build && pnpm --filter @dork-labs/connector-providers build && pnpm --filter @dorkos/shared build && pnpm --filter @dorkos/decisions build && pnpm --filter @dork-labs/ui build && pnpm --filter @dorkos/community build && pnpm --filter dorkos build
RUN mkdir /packed && pnpm --dir packages/cli pack --pack-destination /packed && npm install --prefix /packaged-cli /packed/dorkos-*.tgz
RUN pnpm --filter @dorkos/community deploy --prod --legacy --ignore-scripts /packaged-community && cp -R "$SPACE_DIR/dist" "$SPACE_DIR/dist-server" "$SPACE_DIR/migrations" /packaged-community/
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN pnpm --filter @dorkos/community exec playwright install --with-deps chromium
ENV NODE_ENV=production SPACE_DIR=$SPACE_DIR
# A shell only to read the folder; `exec` hands PID 1 to node, as before.
CMD ["sh", "-c", "exec node \"$SPACE_DIR/acceptance/run.mjs\""]
