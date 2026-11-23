import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { READY_PREFIX, STACK_ENV, type StackInfo } from './support/env.ts'

// Поднимает стенд (e2e/support/stack.ts) отдельным процессом и возвращает функцию остановки —
// Playwright вызывает её после всех тестов, в том числе упавших. Адрес клиента и файл учётных
// данных уходят тестам через переменную окружения: её наследуют процессы-исполнители.

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const STACK = path.join(ROOT, 'e2e/support/stack.ts')
/** Журнал стенда (PostgreSQL, сид, API) — рядом с трассировками, в артефакт CI. */
const LOG_FILE = path.join(ROOT, 'test-results/stack.log')
const START_TIMEOUT_MS = 180_000
const STOP_TIMEOUT_MS = 30_000

export default async function globalSetup() {
  await mkdir(path.dirname(LOG_FILE), { recursive: true })
  const logFile = createWriteStream(LOG_FILE)
  // stdin — канал управления: его закрытие останавливает стенд. Если раннер упадёт, ОС закроет
  // канал сама, и PostgreSQL не останется висеть.
  const stack = spawn(process.execPath, [STACK], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  stack.stderr.pipe(logFile)
  const exited = new Promise<number | null>((resolve) => stack.once('exit', resolve))

  const info = await new Promise<StackInfo>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(
      () => reject(new Error(`стенд не поднялся за ${START_TIMEOUT_MS / 1000} с, см. ${LOG_FILE}`)),
      START_TIMEOUT_MS,
    )
    stack.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const line = buffer.split('\n').find((l) => l.startsWith(READY_PREFIX))
      if (!line) return
      clearTimeout(timer)
      resolve(JSON.parse(line.slice(READY_PREFIX.length)) as StackInfo)
    })
    void exited.then((code) => {
      clearTimeout(timer)
      reject(new Error(`стенд завершился с кодом ${code} до готовности, см. ${LOG_FILE}`))
    })
  }).catch(async (error: unknown) => {
    await stopStack()
    throw error
  })

  process.env[STACK_ENV] = JSON.stringify(info)

  async function stopStack() {
    if (stack.exitCode !== null) return
    stack.stdin.end()
    const code = await Promise.race([exited, delay(STOP_TIMEOUT_MS).then(() => 'timeout')])
    if (code === 'timeout') {
      // Стенд не остановился сам — гасим всё его дерево процессов, вместе с PostgreSQL.
      if (process.platform === 'win32' && stack.pid !== undefined) {
        spawn('taskkill', ['/pid', String(stack.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        stack.kill('SIGKILL')
      }
    }
  }

  return async () => {
    await stopStack()
    logFile.end()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
