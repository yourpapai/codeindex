import { describe, expect, test } from 'bun:test'

import { parseListenUrl, startOpencodeServe, type SpawnedProcess } from '../../bench/agents/serve'

const makeFake = (
  lines: readonly string[],
  options: { readonly delayMs?: number; readonly exitCode?: number } = {},
): SpawnedProcess => {
  const encoder = new TextEncoder()
  const stdout = new ReadableStream<Uint8Array>({
    start(controller): void {
      const payload = lines.map((line) => `${line}\n`).join('')
      setTimeout(() => {
        controller.enqueue(encoder.encode(payload))
        controller.close()
      }, options.delayMs ?? 0)
    },
  })
  const exitCode = options.exitCode ?? 0
  return {
    stdout,
    kill: () => undefined,
    exited: new Promise((resolve) => {
      setTimeout(() => resolve(exitCode), (options.delayMs ?? 0) + 5)
    }),
  }
}

const makeNeverEndingFake = (): SpawnedProcess => {
  // never announces, never closes
  const stdout = new ReadableStream<Uint8Array>({
    start(): void {},
  })
  // never exits
  return {
    stdout,
    kill: () => undefined,
    exited: new Promise<number>(() => {}),
  }
}

describe('parseListenUrl', () => {
  test('extracts the URL from a listening line', () => {
    expect(parseListenUrl('opencode server listening on http://127.0.0.1:4567')).toBe('http://127.0.0.1:4567')
  })

  test('returns null for unrelated lines', () => {
    expect(parseListenUrl('booting...')).toBeNull()
    expect(parseListenUrl('')).toBeNull()
  })

  test('rejects a listening line with a malformed URL', () => {
    expect(parseListenUrl('opencode server listening on not-a-url')).toBeNull()
  })
})

describe('startOpencodeServe', () => {
  test('resolves with the announced URL', async () => {
    const server = await startOpencodeServe({ cwd: '/tmp', config: {}, startupTimeoutMs: 500 }, () =>
      makeFake(['opencode server listening on http://127.0.0.1:4567']),
    )
    expect(server.url).toBe('http://127.0.0.1:4567')
    await server.close()
  })

  test('skips unrelated startup output', async () => {
    const server = await startOpencodeServe({ cwd: '/tmp', config: {}, startupTimeoutMs: 500 }, () =>
      makeFake(['booting...', 'loading plugins', 'opencode server listening on http://127.0.0.1:4567']),
    )
    expect(server.url).toBe('http://127.0.0.1:4567')
    await server.close()
  })

  test('retries once and throws on persistent timeout', async () => {
    let spawns = 0
    const start = startOpencodeServe({ cwd: '/tmp', config: {}, startupTimeoutMs: 30, retries: 1 }, () => {
      spawns += 1
      return makeNeverEndingFake()
    })
    await expect(start).rejects.toThrow('timeout')
    expect(spawns).toBe(2)
  })

  test('throws when the process exits before announcing', async () => {
    const start = startOpencodeServe({ cwd: '/tmp', config: {}, startupTimeoutMs: 500 }, () =>
      makeFake(['booting...'], { exitCode: 1 }),
    )
    await expect(start).rejects.toThrow('exited')
  })

  test('close kills the underlying process', async () => {
    let killed = false
    const server = await startOpencodeServe({ cwd: '/tmp', config: {}, startupTimeoutMs: 500 }, () => {
      const fake = makeFake(['opencode server listening on http://127.0.0.1:4567'])
      const fakeWithKill = {
        ...fake,
        kill: (): void => {
          killed = true
        },
      }
      return fakeWithKill
    })
    await server.close()
    expect(killed).toBe(true)
  })
})
