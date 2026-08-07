# ScottyLabs Invites — single image for both the app (API + SPA) and mcp services.
# The mcp service runs the same image with APP_MODE=mcp.
FROM node:22-alpine

WORKDIR /app
RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/contract/package.json packages/contract/
COPY apps/backend/package.json apps/backend/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY packages ./packages
COPY apps ./apps

RUN pnpm --filter @scottylabs-invites/web build

ENV NODE_ENV=production
ENV WEB_DIST=/app/apps/web/dist

WORKDIR /app/apps/backend
CMD ["pnpm", "start"]
