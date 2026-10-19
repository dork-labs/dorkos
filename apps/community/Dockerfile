FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /work
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY apps/community/package.json apps/community/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/relay/package.json packages/relay/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/decisions/package.json packages/decisions/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/icons/package.json packages/icons/package.json
COPY packages/test-utils/package.json packages/test-utils/package.json
COPY packages/cloud-api/package.json packages/cloud-api/package.json
COPY packages/connector-providers/package.json packages/connector-providers/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages/shared packages/shared
COPY packages/decisions packages/decisions
COPY packages/ui packages/ui
COPY packages/icons packages/icons
COPY packages/cloud-api packages/cloud-api
COPY packages/connector-providers packages/connector-providers
COPY packages/typescript-config packages/typescript-config
COPY apps/community apps/community
# The space server's code lives in the DorkOS server package (server-merge step 7); its build
# (apps/community/tsconfig.build.json) still compiles it into apps/community/dist-server/. The
# link lets that code find the space server's own packages without installing the DorkOS
# server's, so nothing of the server's reaches this image.
COPY apps/server/src/services/spaces apps/server/src/services/spaces
RUN ln -s ../community/node_modules apps/server/node_modules
RUN pnpm --filter @dork-labs/cloud-api build && pnpm --filter @dork-labs/connector-providers build && pnpm --filter @dorkos/shared build && pnpm --filter @dorkos/decisions build && pnpm --filter @dork-labs/ui build && pnpm --filter @dorkos/community build
# This image copies only the community's slice of the workspace, so a root patch for a
# package it never installs (when-exit, which the server reaches through conf) is
# "unused" here, and pnpm deploy refuses unused patches by default. The v0.114.0 and
# v0.114.1 images failed to build on exactly that.
RUN pnpm --config.allow-unused-patches=true --filter @dorkos/community deploy --prod --legacy --ignore-scripts /runtime
RUN cp -R apps/community/dist apps/community/dist-server apps/community/migrations /runtime/

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /runtime /app
RUN mkdir -p /data/blobs && chown node:node /data/blobs
USER node
ENV COMMUNITY_PORT=6481 COMMUNITY_STORAGE_PATH=/data/blobs NODE_ENV=production
EXPOSE 6481
VOLUME /data/blobs
CMD ["node", "dist-server/main.js"]
