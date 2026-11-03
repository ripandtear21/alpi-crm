# Staging-сервер и выкладка

Type: task
Status: blocked 2026-11-03T23:28Z
Blocked reason: Нужен аккаунт Hetzner Cloud, сервер staging и секреты для GitHub Actions
Waits: owner
Blocked by: 09
Source: .scratch/crm-mvp/spec.md, раздел 12, эпик 1

## Что сделать

Владелец: аккаунт и проект Hetzner Cloud, сервер staging (самый дешёвый тариф, ЕС), SSH-доступ и секреты для GitHub Actions. Агент: скрипт подготовки сервера (Docker, пользователь, firewall), `docker-compose.prod.yml`, workflow выкладки на staging при слиянии в main, миграции шагом выкладки, TLS через Caddy.

## Where in code

deploy/**, .github/workflows/deploy-staging.yml, docker-compose.prod.yml.

## Done when

- [ ] После слияния в main staging обновляется автоматически, `/health` отвечает 200 по HTTPS (вставить ответ curl).
- [ ] Секреты только в секретах GitHub и на сервере.
