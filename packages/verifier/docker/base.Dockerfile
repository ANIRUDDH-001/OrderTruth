# OrderTruth v3 Gate A images. Build context: repository root.
# Only files allowlisted in base.Dockerfile.dockerignore reach the build (no .env, .work, .git or node_modules).

# --- smoke: Checkpoint 0 (Task 0.2). Independent of all later TypeScript, tests and configuration. ---
FROM node:22.18.0-bookworm-slim AS smoke
ENV CI=true COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile && pnpm --version > /app/.pnpm-version
COPY packages/guard/sql/guard-v1.sql packages/guard/sql/guard-v1.sql
COPY packages/verifier/smoke/smoke.mjs packages/verifier/smoke/smoke.mjs
USER node
CMD ["node", "packages/verifier/smoke/smoke.mjs"]

# --- qualify: Checkpoint 1+ supported-runtime qualification (Node 22.18.0). Same pinned frozen-lockfile install. ---
FROM node:22.18.0-bookworm-slim AS qualify
ENV CI=true COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0 npm_config_verify_deps_before_run=false
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile && pnpm --version > /app/.pnpm-version
COPY tsconfig.json vite.config.ts vite.console.config.ts vite.judge.config.ts vite.owner.config.ts vitest.config.ts vitest.postgres.config.ts vitest.v3-postgres.config.ts ./
COPY src/ src/
COPY web/ web/
COPY scripts/ scripts/
COPY packages/ packages/
COPY tests/ tests/
COPY packages/verifier/smoke/qualify-in-container.sh /usr/local/bin/qualify-in-container
# Normalize line endings in case a Windows checkout converted them. Vitest writes its bundled config beside the
# config file and caches under node_modules/.vite, so only those two locations become writable by the run user.
RUN sed -i 's/\r$//' /usr/local/bin/qualify-in-container \
 && chown node:node /app && mkdir -p node_modules/.vite && chown -R node:node node_modules/.vite
USER node
CMD ["bash", "/usr/local/bin/qualify-in-container"]
