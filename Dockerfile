FROM node:20-slim AS base

# Common paths
ENV PATH="/root/.bun/bin:/home/node/.bun/bin:$PATH"

############################
# Builder
############################
FROM base AS builder

# Build tooling only in builder
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    git \
    python3 \
    make \
    g++ && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install bun (build stage only)
RUN npm install -g bun

WORKDIR /app

# Install deps with cache-friendly layering
# Copy package.json, lockfile, AND scripts needed for postinstall
COPY package.json bun.lock* ./
COPY scripts/patch-telegraf.cjs ./scripts/
RUN bun install --frozen-lockfile

# Copy source and build
COPY . .
RUN bun run build

############################
# Runtime
############################
FROM base AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Install bun in runtime to satisfy any bun-shebang scripts
RUN npm install -g bun

# Ensure writable data dir for eliza (pglite, state)
RUN mkdir -p /app/.eliza && chown -R node:node /app /home/node

# Copy runtime artifacts only
COPY --from=builder /app/package.json /app/bun.lock* ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/index.html ./index.html
# Optional: copy .eliza if present (commented out to avoid build failures when missing)
# COPY --from=builder /app/.eliza ./ .eliza

# Wrapper to use local elizaos binary from node_modules
RUN echo '#!/bin/bash\nexec /app/node_modules/.bin/elizaos "$@"' > /usr/local/bin/elizaos && \
    chmod +x /usr/local/bin/elizaos

# Drop privileges
USER node

EXPOSE 3000

CMD ["elizaos", "start"]