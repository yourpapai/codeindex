import { afterEach, describe, expect, test } from 'bun:test'

import { loadConfigForPath } from '../src/cli.js'
import { DEFAULT_SERVE_PORT, parseServeArgs, startServe } from '../src/mcp/serve.js'
import { makeTempRepo, type TempRepo } from './mcp/protocol-harness.js'

const repos: TempRepo[] = []
const stops: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop().catch(() => undefined)
  }
  for (const repo of repos.splice(0)) {
    repo.cleanup()
  }
})

describe('serve --port validation', () => {
  test('default port constant is 3456', () => {
    expect(DEFAULT_SERVE_PORT).toBe(3456)
  })

  test('omitted --port uses the default', () => {
    expect(parseServeArgs([]).port).toBe(3456)
    expect(parseServeArgs(['--host', 'ignored']).port).toBe(3456)
  })

  test('accepts a valid port', () => {
    expect(parseServeArgs(['--port', '8080']).port).toBe(8080)
  })

  test('rejects port 0', () => {
    expect(() => parseServeArgs(['--port', '0'])).toThrow(/port/i)
  })

  test('rejects port 65536', () => {
    expect(() => parseServeArgs(['--port', '65536'])).toThrow(/port/i)
  })

  test('rejects a non-integer port', () => {
    expect(() => parseServeArgs(['--port', 'abc'])).toThrow(/port/i)
    expect(() => parseServeArgs(['--port', '1.5'])).toThrow(/port/i)
  })

  test('rejects a missing --port value', () => {
    expect(() => parseServeArgs(['--port'])).toThrow(/--port/i)
  })
})

describe('serve EADDRINUSE', () => {
  test('names repoRoot and suggests --port', async () => {
    const repo = makeTempRepo({ prefix: 'codeindex-cli-serve-addr-' })
    repos.push(repo)
    const config = await loadConfigForPath(repo.dir)

    const first = await startServe(config, { port: 0 })
    stops.push(first.stop)

    await expect(startServe(config, { port: first.port })).rejects.toThrow(
      new RegExp(`${repo.dir.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}.*--port`),
    )
  })
})
