import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildMcpDeps, createMcpSession, loadConfigForPath } from '../../src/cli.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { createCodeindexServer } from '../../src/mcp/server.js'
import { CodeIndexOutputSchema, CodeSearchOutputSchema } from '../../src/mcp/tools.js'
import type { IndexWatcher } from '../../src/mcp/watcher.js'
import { connectClient } from './harness.js'

const tempDirs: string[] = []
const watchers: IndexWatcher[] = []

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const waitForArmed = async (watcher: IndexWatcher): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (!watcher.isArmed()) {
    if (Date.now() > deadline) {
      throw new Error(`watcher did not arm: ${JSON.stringify(watcher.getState())}`)
    }
    await delay(15)
  }
}

const makeRepo = (symbolName: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-wiring-'))
  tempDirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  writeFileSync(path.join(dir, 'src', 'thing.ts'), `export const ${symbolName} = (): number => 1\n`)
  return dir
}

afterEach(() => {
  for (const watcher of watchers.splice(0)) {
    watcher.stop()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('code_index targets the server-bound repo', () => {
  test('indexing then searching through the protocol finds the bound repo symbol', async () => {
    const repoA = makeRepo('boundRepoBeacon')
    const config = await loadConfigForPath(repoA)
    const client = await connectClient(createCodeindexServer(buildMcpDeps(config)))

    const indexResult = await client.callTool({ name: 'code_index', arguments: { mode: 'full' } })
    expect(indexResult.isError).not.toBe(true)
    const summary = CodeIndexOutputSchema.parse(indexResult.structuredContent)
    expect(summary.filesIndexed).toBeGreaterThanOrEqual(1)

    const searchResult = await client.callTool({ name: 'code_search', arguments: { query: 'boundRepoBeacon' } })
    const payload = CodeSearchOutputSchema.parse(searchResult.structuredContent)
    expect(payload.resultCount).toBeGreaterThanOrEqual(1)
    expect(payload.results.some((row) => row.qualifiedName === 'src/thing#boundRepoBeacon')).toBe(true)
  })
})

describe('server session boot', () => {
  test('a dirty index serves immediately with possibly_stale and flips to fresh after catch-up', async () => {
    const dir = makeRepo('catchUpBeacon')
    const config = await loadConfigForPath(dir)
    await indexCodebase({ config, mode: 'full' })
    writeFileSync(path.join(dir, 'src', 'thing.ts'), 'export const catchUpBeacon = (): number => 2\n')

    const { server, watcher } = createMcpSession(config)
    watchers.push(watcher)
    const client = await connectClient(server)

    const before = await client.callTool({ name: 'code_search', arguments: { query: 'catchUpBeacon' } })
    const beforePayload = CodeSearchOutputSchema.parse(before.structuredContent)
    expect(beforePayload.indexFreshness).toBe('possibly_stale')
    expect(beforePayload.results.length).toBeGreaterThanOrEqual(1)
    expect(beforePayload.results.every((row) => row.freshness === 'possibly_stale')).toBe(true)

    void watcher.start()
    await waitForArmed(watcher)

    const after = await client.callTool({ name: 'code_search', arguments: { query: 'catchUpBeacon' } })
    const afterPayload = CodeSearchOutputSchema.parse(after.structuredContent)
    expect(afterPayload.indexFreshness).toBe('fresh')
    expect(afterPayload.results.length).toBeGreaterThanOrEqual(1)
    expect(afterPayload.results.every((row) => row.freshness === 'fresh')).toBe(true)
  })
})
