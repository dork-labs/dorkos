FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /work
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/community/package.json apps/community/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/relay/package.json packages/relay/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/test-utils/package.json packages/test-utils/package.json
COPY packages/cloud-api/package.json packages/cloud-api/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages/shared packages/shared
COPY packages/ui packages/ui
COPY packages/cloud-api packages/cloud-api
COPY packages/typescript-config packages/typescript-config
COPY apps/community apps/community
RUN pnpm --filter @dork-labs/cloud-api build && pnpm --filter @dorkos/shared build && pnpm --filter @dork-labs/ui build && pnpm --filter @dorkos/community build
RUN pnpm --filter @dorkos/community deploy --prod --legacy --ignore-scripts /runtime
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
