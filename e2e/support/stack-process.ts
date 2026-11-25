import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { READY_PREFIX, type StackInfo } from './env.ts'

// Запуск стенда (e2e/support/stack.ts) отдельным процессом: своя база embedded PostgreSQL,
// pnpm seed, API и клиент. Им пользуются global-setup.ts (общий стенд сценария crm-deals) и
// сценарии, которым нужна своя база (fields-acceptance.spec.ts).

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const STACK = path.join(ROOT, 'e2e/support/stack.ts')
const START_TIMEOUT_MS = 180_000
const STOP_TIMEOUT_MS = 30_000

export interface RunningStack {
  info: StackInfo
  /** Гасит стенд вместе с PostgreSQL; повторный вызов ничего не делает. */
  stop: () => Promise<void>
}

/**
 * Поднимает стенд и ждёт строку готовности. `logFile` — журнал стенда (PostgreSQL, сид, API),
 * путь от корня репозитория: рядом с трассировками, в артефакт CI.
 */
export async function startStack(logFile: string): Promise<RunningStack> {
  const logPath = path.join(ROOT, logFile)
  await mkdir(path.dirname(logPath), { recursive: true })
  const log = createWriteStream(logPath)
  // stdin — канал управления: его закрытие останавливает стенд. Если раннер упадёт, ОС закроет
  // канал сама, и PostgreSQL не останется висеть.
  const stack = spawn(process.execPath, [STACK], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  stack.stderr.pipe(log)
  const exited = new Promise<number | null>((resolve) => stack.once('exit', resolve))

  async function stop() {
    if (stack.exitCode === null) {
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
    log.end()
  }

  const info = await new Promise<StackInfo>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(
      () => reject(new Error(`стенд не поднялся за ${START_TIMEOUT_MS / 1000} с, см. ${logFile}`)),
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
      reject(new Error(`стенд завершился с кодом ${code} до готовности, см. ${logFile}`))
    })
  }).catch(async (error: unknown) => {
    await stop()
    throw error
  })

  return { info, stop }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
