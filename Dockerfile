# syntax=docker/dockerfile:1

# The agentdeck runtime image: an agent CLI, tmux, and as little else as the job allows.
#
# arm64 only, and that is deliberate. The image is built on the Mac and used on the Mac, so
# CI never builds it — an artifact nothing consumes is not worth proving (plan 003, M0).
#
# TODO(M1): this becomes multi-stage. `node-pty` installs as `prebuild || node-gyp rebuild`,
# and the day a prebuild is missing for the pinned base the fallback has to be able to
# succeed — which means python3, make and g++ present in a BUILDER stage and absent from
# this one (plan 005). The shape:
#
#     FROM node:22-bookworm-slim AS builder
#     RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++
#     WORKDIR /app
#     COPY package.json pnpm-lock.yaml ./
#     RUN corepack enable && pnpm install --frozen-lockfile
#
# then `COPY --from=builder /app/node_modules /app/node_modules` below. Written down now
# rather than discovered at M3, when everything already depends on the Dockerfile.
FROM node:22-bookworm-slim

# Pinned to the version running on the host. A build failure here means the pin needs
# bumping, which is the failure we want — not a silent drift between host and container.
ARG CLAUDE_CODE_VERSION=2.1.220

# curl earns its place: plan 004's `hook` mechanism needs something in the image that can
# make an HTTP request back to the server on container loopback, and no other plan owns
# that line. git earns its place because the credential split (plan 005) is "the agent
# commits, the human pushes" — committing happens in here.
RUN apt-get update && apt-get install -y --no-install-recommends \
        tmux \
        git \
        curl \
        ca-certificates \
        procps \
        less \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

# tmux defaults that the design depends on, set once here so an interactive session and a
# server-created session agree. The server still sets remain-on-exit per session at M1;
# this is the same decision seen from the other side, for sessions a human starts by hand.
#
# remain-on-exit: tmux destroys a session when its command exits by default, which would
# mean an agent that finished or crashed removed its own tab and its exit code with it —
# leaving the strip unable to tell "it is done" from "I lost it" (plans 001 and 002).
#
# exit-empty: the tmux SERVER exits when it holds no sessions, which is on by default and
# is the same failure one level up. `tmux start-server` then reports success and the
# server is gone before the next command runs — verified: the health check went unhealthy
# with "no server running" while the entrypoint had just logged that it was up. Everything
# here assumes a long-lived server that sessions come and go inside of, so it has to be off.
#
# history-limit: tmux is the scrollback store, so the depth is a product decision rather
# than a default worth inheriting.
RUN printf '%s\n' \
        'set -g remain-on-exit on' \
        'set -g exit-empty off' \
        'set -g history-limit 50000' \
        'set -g mouse on' \
    > /etc/tmux.conf

WORKDIR /app
COPY docker/entrypoint.sh /app/entrypoint.sh
COPY scripts/ /app/scripts/
RUN chmod +x /app/entrypoint.sh

# Non-root. Whether the uid must MATCH the host user is Linux-host advice — OrbStack maps
# ownership across VirtioFS itself, so files may come out correct regardless. Verify with
# one touch rather than inheriting the folklore (plan 005); the non-root part is not
# folklore and stays either way.
USER node

# CLAUDE_CONFIG_DIR is what makes the mount in compose land where the agent looks. Both
# .claude.json and .credentials.json live inside this one directory, which is why the
# host side is a single dedicated directory rather than a scatter of files.
ENV CLAUDE_CONFIG_DIR=/home/node/.claude \
    TMUX_SOCKET=agentdeck \
    AGENTDECK_PORT=7777

WORKDIR /workspace

ENTRYPOINT ["/app/entrypoint.sh"]
