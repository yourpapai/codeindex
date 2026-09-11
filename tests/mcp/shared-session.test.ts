import { afterEach, describe, expect, test } from 'bun:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { loadConfigForPath } from '../../src/cli.js'
import { indexCodebase, type IndexSummary } from '../../src/indexer/index-codebase.js'
import { CodeIndexOutputSchema, CodeSearchOutputSchema } from '../../src/mcp/tools.js'
import { makeTempRepo, type TempRepo } from './protocol-harness.js'

const repos: TempRepo[] = []
const clients: Client[] = []
const stops: Array<() => Promise<void>> = []

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => undefined)
  }
  for (const stop of stops.splice(0)) {
    await stop().catch(() => undefined)
  }
  for (const repo of repos.splice(0)) {
    repo.cleanup()
  }
})

const connectHttp = async (url: string): Promise<Client> => {
  const transport = new StreamableHTTPClientTransport(new URL(url))
  const client = new Client({ name: 'shared-session-test', version: '0.0.0' })
  clients.push(client)
  await client.connect(transport)
  return client
}

describe('shared process session model', () => {
  test('two concurrent HTTP clients serialize through one reindex queue', async () => {
    const { startServe } = await import('../../src/mcp/serve.js')
    const repo = makeTempRepo({ prefix: 'codeindex-shared-session-', symbolName: 'sharedBeacon' })
    repos.push(repo)
    const config = await loadConfigForPath(repo.dir)

    let active = 0
    let maxActive = 0
    const handle = await startServe(config, {
      port: 0,
      indexRunner: async (input): Promise<IndexSummary> => {
        active += 1
        maxActive = Math.max(maxActive, active)
        try {
          await delay(60)
          return await indexCodebase({ config, mode: input.mode })
        } finally {
          active -= 1
        }
      },
    })
    stops.push(handle.stop)

    const clientA = await connectHttp(handle.url)
    const clientB = await connectHttp(handle.url)

    const [a, b] = await Promise.all([
      clientA.callTool({ name: 'code_index', arguments: { mode: 'full' } }),
      clientB.callTool({ name: 'code_index', arguments: { mode: 'full' } }),
    ])

    const summaryA = CodeIndexOutputSchema.parse(a.structuredContent)
    const summaryB = CodeIndexOutputSchema.parse(b.structuredContent)
    expect(summaryA.filesIndexed).toBeGreaterThanOrEqual(1)
    expect(summaryB.filesIndexed).toBeGreaterThanOrEqual(1)
    expect(maxActive).toBe(1)

    const searchA = await clientA.callTool({ name: 'code_search', arguments: { query: 'sharedBeacon' } })
    const searchB = await clientB.callTool({ name: 'code_search', arguments: { query: 'sharedBeacon' } })
    const payloadA = CodeSearchOutputSchema.parse(searchA.structuredContent)
    const payloadB = CodeSearchOutputSchema.parse(searchB.structuredContent)
    expect(payloadA.results.some((row) => row.qualifiedName === 'src/thing#sharedBeacon')).toBe(true)
    expect(payloadB.results.some((row) => row.qualifiedName === 'src/thing#sharedBeacon')).toBe(true)
  })
})
