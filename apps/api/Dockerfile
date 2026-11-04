# Образ API. Собирается из корня репозитория: docker build -f apps/api/Dockerfile .
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
RUN pnpm install --offline --frozen-lockfile --filter @alpi/api...
RUN pnpm --filter @alpi/api build
# Пакеты рабочего пространства (@alpi/*) уже встроены в dist/index.js, в образ идут только зависимости npm.
RUN pnpm --filter @alpi/api deploy --prod --legacy /out \
  && cp -r apps/api/dist /out/dist

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
