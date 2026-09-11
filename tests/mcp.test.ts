import { describe, expect, test } from 'bun:test'

import { createCodeindexServer } from '../src/mcp.js'
import { emptyOutlineResult } from './mcp/harness.js'

describe('createCodeindexServer', () => {
  test('registers the Tier 1 MCP tools', () => {
    const server = createCodeindexServer({
      codeSearch: () => Promise.resolve([]),
      codeSymbol: () => Promise.resolve([]),
      codeImpact: () => Promise.resolve({ resolution: { status: 'unresolved' as const }, results: [] }),
      codeOutline: (input) => Promise.resolve(emptyOutlineResult(input)),
      codeIndex: () =>
        Promise.resolve({
          filesIndexed: 0,
          filesFailed: 0,
          filesPruned: 0,
          skippedFiles: [],
          skippedFilesTotal: 0,
          symbolsIndexed: 0,
          referencesIndexed: 0,
          referencesUnresolved: 0,
          referencesRepaired: 0,
          elapsedMs: 0,
        }),
    })
    expect(server).toBeDefined()
  })
})
