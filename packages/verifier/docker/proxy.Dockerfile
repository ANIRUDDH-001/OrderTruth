# OrderTruth v3 Gate A fault proxy (plan Task 10). Node 22.18.0, built-in type stripping, no dependencies beyond node: builtins.
FROM node:22.18.0-bookworm-slim
WORKDIR /app
COPY packages/verifier/src/proxy.ts packages/verifier/src/proxy-main.ts packages/verifier/src/
USER node
CMD ["node", "--experimental-strip-types", "--no-warnings", "packages/verifier/src/proxy-main.ts"]
