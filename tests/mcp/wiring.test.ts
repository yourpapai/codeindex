import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildMcpDeps, loadConfigForPath } from '../../src/cli.js'
import { createCodeindexServer } from '../../src/mcp/server.js'
import { CodeIndexOutputSchema, CodeSearchOutputSchema } from '../../src/mcp/tools.js'
import { connectClient } from './harness.js'

const tempDirs: string[] = []

const makeRepo = (symbolName: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-wiring-'))
  tempDirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  writeFileSync(path.join(dir, 'src', 'thing.ts'), `export const ${symbolName} = (): number => 1\n`)
  return dir
}

afterEach(() => {
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
