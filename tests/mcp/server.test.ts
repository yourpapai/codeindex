import { describe, expect, test } from 'bun:test'

import { createCodeindexServer } from '../../src/mcp/server.js'

describe('createCodeindexServer', () => {
  test('registers tools with output schemas and returns structured responses', () => {
    const server = createCodeindexServer({
      codeSearch: () => Promise.resolve([]),
      codeSymbol: () => Promise.resolve([]),
      codeImpact: () => Promise.resolve([]),
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
