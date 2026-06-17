# Engram brain viewer — multi-stage. The builder compiles the workspace + the
# React frontend; the runtime ships node:slim + the built app and serves the API
# and static assets on ONE port. Build tooling (vite) stays in the builder stage.
FROM node:22-slim AS builder
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY pnpm-lock.yaml* ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm --filter @engram/shared build \
 && pnpm --filter @engram/memory build \
 && pnpm --filter @engram/viewer build

FROM node:22-slim AS runtime
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
# Copy the fully built+installed workspace. The server runs via tsx (a workspace
# dev dep); the heavy frontend build artifacts are the static dist-web only.
COPY --from=builder /app /app
ENV VIEWER_PORT=8080
ENV ENGRAM_INFRA=alibaba
EXPOSE 8080
CMD ["pnpm", "--filter", "@engram/viewer", "start"]
