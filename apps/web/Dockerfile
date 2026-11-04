# Образ клиента: статика SPA за Caddy, который же проксирует /api/* на API и выпускает TLS.
# Собирается из корня репозитория: docker build -f apps/web/Dockerfile .
FROM node:24-slim AS build
RUN npm install -g pnpm@11.22.0
WORKDIR /repo
# Сначала только lockfile: pnpm fetch скачивает пакеты в хранилище по нему одному,
# и этот слой пересобирается лишь при смене зависимостей.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
# Затем рабочее пространство целиком: pnpm-workspace.yaml перечисляет все apps/* и packages/*,
# и --frozen-lockfile сверяет lockfile со всеми пакетами. node_modules, сборки и .env
# с машины разработчика сюда не попадают — их отсекает .dockerignore.
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter @alpi/web...
RUN pnpm --filter @alpi/web build

FROM caddy:2
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
