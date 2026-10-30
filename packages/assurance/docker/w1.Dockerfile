FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e
LABEL ordertruth.w1.base="node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e"
ENV CI=true COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0 XDG_DATA_HOME=/tmp/xdg-data
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile && pnpm --version > /opt/w1-pnpm-version
# Context is constructed by validate-w1.ts from a permitted-source snapshot, never the whole checkout.
COPY . .
RUN mkdir -p /app/dist /app/node_modules/.vite /app/node_modules/.vite-temp \
 && chown node:node /app/dist /app/node_modules/.vite /app/node_modules/.vite-temp
USER node
CMD ["node", "--import", "tsx", "scripts/validate-w1.ts", "--inside"]
