# Build the real distributable apps before sealing the runtime network.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /work
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @dork-labs/cloud-api build && pnpm --filter @dorkos/shared build && pnpm --filter @dorkos/community build && pnpm --filter dorkos build
RUN mkdir /packed && pnpm --dir packages/cli pack --pack-destination /packed && npm install --prefix /packaged-cli /packed/dorkos-*.tgz
RUN pnpm --filter @dorkos/community deploy --prod --legacy --ignore-scripts /packaged-community && cp -R apps/community/dist apps/community/dist-server apps/community/migrations /packaged-community/
RUN pnpm --filter @dorkos/community exec playwright install --with-deps chromium
ENV NODE_ENV=production
CMD ["node", "apps/community/acceptance/run.mjs"]
