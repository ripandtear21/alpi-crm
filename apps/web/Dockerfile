# Образ клиента: статика SPA за Caddy, который же проксирует /api/* на API и выпускает TLS.
# Собирается из корня репозитория: docker build -f apps/web/Dockerfile .
FROM node:24-slim AS build
RUN npm install -g pnpm@11.22.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
RUN pnpm install --frozen-lockfile --filter @alpi/web...
RUN pnpm --filter @alpi/web build

FROM caddy:2
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
