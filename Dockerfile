# think — one image for both containers: the Node server, the built client, the
# agent runner, and the ACP agent adapters (which bundle their agents' CLIs).
#
# The app lives in /opt/think; the data folder (ROOT) is mounted at /projects.
# The entrypoint becomes the data folder's owner (PUID/PGID) before starting,
# so one image serves any machine and user — see docs/install.md.

FROM node:24-bookworm-slim AS build
# node-pty has no Linux prebuilds: compile it here, never in the runtime image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/think
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
# fonts-inter: text drawn on images renders in the app's own typeface.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates fonts-inter \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1001 think \
 && useradd -u 1001 -g 1001 -m -d /home/think -s /bin/bash think \
 && mkdir -p /projects /run/think
# The commit and version being built, shown in Settings and on the image.
ARG THINK_COMMIT=""
ARG THINK_VERSION=""
ENV THINK_COMMIT=$THINK_COMMIT
LABEL org.opencontainers.image.title="think" \
      org.opencontainers.image.description="A self-hosted canvas for thinking with an AI agent" \
      org.opencontainers.image.version=$THINK_VERSION \
      org.opencontainers.image.revision=$THINK_COMMIT
WORKDIR /opt/think
COPY --from=build /opt/think/node_modules ./node_modules
COPY --from=build /opt/think/dist ./dist
COPY package.json ./
COPY config ./config
COPY prompts ./prompts
COPY bin ./bin
COPY skills ./skills
COPY examples ./examples
ENV NODE_ENV=production \
    THINK_ROOT=/projects \
    THINK_APP_DIR=/opt/think \
    THINK_HOST=0.0.0.0 \
    THINK_PORT=8080
EXPOSE 8080
ENTRYPOINT ["/opt/think/bin/docker-entrypoint.sh"]
CMD ["node", "dist/node/server/index.js"]
