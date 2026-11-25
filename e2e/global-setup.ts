import { STACK_ENV } from './support/env.ts'
import { startStack } from './support/stack-process.ts'

// Поднимает общий стенд (e2e/support/stack-process.ts) и возвращает функцию остановки —
// Playwright вызывает её после всех тестов, в том числе упавших. Адрес клиента и файл учётных
// данных уходят тестам через переменную окружения: её наследуют процессы-исполнители.

export default async function globalSetup() {
  const stack = await startStack('test-results/stack.log')
  process.env[STACK_ENV] = JSON.stringify(stack.info)
  return stack.stop
}
