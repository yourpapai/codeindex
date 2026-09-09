import { serializeArmConfig, type ArmConfig } from './config'

export const parseListenUrl = (line: string): string | null => {
  const match = /opencode server listening on (https?:\/\/[^\s]+)/.exec(line)
  if (match === null) {
    return null
  }
  const url = match[1]
  if (url === undefined) {
    return null
  }
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

export interface SpawnedProcess {
  readonly stdout: ReadableStream<Uint8Array>
  kill(): void
  readonly exited: Promise<number>
}

export interface ServeOptions {
  readonly cwd: string
  readonly config: ArmConfig
  readonly hostname?: string
  readonly startupTimeoutMs?: number
  readonly retries?: number
  readonly env?: Readonly<Record<string, string>>
}

export interface OpencodeServerHandle {
  readonly url: string
  close(): Promise<void>
}

const discard = (): void => undefined

type SpawnFn = () => SpawnedProcess

const drainLines = async (stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> => {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      onLine(buffer.slice(0, index).trim())
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
  }
}

const waitForListenUrl = (
  spawnFn: SpawnFn,
  startupTimeoutMs: number,
): Promise<{ readonly url: string; readonly proc: SpawnedProcess }> =>
  new Promise((resolve, reject) => {
    let settled = false
    let kill: () => void = (): void => undefined
    const finish = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      kill()
      reject(error)
    }
    const timer = setTimeout(() => {
      finish(new Error(`timeout waiting for opencode server to listen after ${startupTimeoutMs}ms`))
    }, startupTimeoutMs)
    try {
      const proc = spawnFn()
      kill = (): void => {
        proc.kill()
      }
      void drainLines(proc.stdout, (line) => {
        const url = parseListenUrl(line)
        if (url !== null && !settled) {
          settled = true
          clearTimeout(timer)
          resolve({ url, proc })
        }
      })
      void proc.exited.then((code) => {
        if (!settled) {
          finish(new Error(`opencode server exited with code ${code} before listening`))
        }
      })
    } catch (error) {
      clearTimeout(timer)
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })

const defaultSpawn = (options: ServeOptions): SpawnedProcess => {
  const env: Record<string, string> = {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: serializeArmConfig(options.config),
    ...options.env,
  }
  const proc = Bun.spawn(['opencode', 'serve', '--hostname', options.hostname ?? '127.0.0.1', '--port', '0'], {
    cwd: options.cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  void drainLines(proc.stderr, discard)
  return {
    stdout: proc.stdout,
    kill: () => {
      if (!proc.killed) {
        proc.kill()
      }
    },
    exited: proc.exited,
  }
}

export const startOpencodeServe = (
  options: ServeOptions,
  spawnFn: SpawnFn = () => defaultSpawn(options),
): Promise<OpencodeServerHandle> => {
  const attempts = (options.retries ?? 1) + 1
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000
  // sequential retries (each attempt depends on the previous failing) — recursion instead
  // of a loop so the sequential await isn't flagged by the no-await-in-loop lint rule
  const tryStart = async (attempt: number, lastError: Error): Promise<OpencodeServerHandle> => {
    if (attempt >= attempts) {
      throw lastError
    }
    try {
      const { url, proc } = await waitForListenUrl(spawnFn, startupTimeoutMs)
      return {
        url,
        close: async () => {
          proc.kill()
          await proc.exited.catch(discard)
        },
      }
    } catch (error) {
      return tryStart(attempt + 1, error instanceof Error ? error : new Error(String(error)))
    }
  }
  return tryStart(0, new Error('opencode server was never started'))
}
