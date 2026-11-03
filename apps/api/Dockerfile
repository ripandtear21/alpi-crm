# Образ API. Собирается из корня репозитория: docker build -f apps/api/Dockerfile .
FROM node:24-slim AS build
RUN npm install -g pnpm@11.22.0
WORKDIR /repo
# Копируем выборочно, чтобы в образ не попали node_modules и .env с машины разработчика.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared
RUN pnpm install --frozen-lockfile --filter @alpi/api...
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
