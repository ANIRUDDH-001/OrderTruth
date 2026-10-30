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
