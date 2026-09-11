import { afterEach, describe, expect, test } from 'bun:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { loadConfigForPath } from '../../src/cli.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { CodeSearchOutputSchema } from '../../src/mcp/tools.js'
import { makeTempRepo, type TempRepo } from './protocol-harness.js'

const repos: TempRepo[] = []
const clients: Client[] = []
const stops: Array<() => Promise<void>> = []

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

describe('http protocol round-trip', () => {
  test('listTools, code_search structured payload, and session id after initialize', async () => {
    const { startServe } = await import('../../src/mcp/serve.js')
    const repo = makeTempRepo({ prefix: 'codeindex-http-roundtrip-', symbolName: 'httpBeacon' })
    repos.push(repo)

    const config = await loadConfigForPath(repo.dir)
    await indexCodebase({ config, mode: 'full' })

    const handle = await startServe(config, { port: 0 })
    stops.push(handle.stop)

    const transport = new StreamableHTTPClientTransport(new URL(handle.url))
    const client = new Client({ name: 'http-roundtrip-test', version: '0.0.0' })
    clients.push(client)
    await client.connect(transport)

    expect(transport.sessionId).toBeTruthy()

    const tools = await client.listTools()
    const names = tools.tools.map((tool) => tool.name).sort()
    expect(names).toEqual(['code_impact', 'code_index', 'code_search', 'code_symbol'])

    const search = await client.callTool({ name: 'code_search', arguments: { query: 'httpBeacon' } })
    expect(search.isError).not.toBe(true)
    const payload = CodeSearchOutputSchema.parse(search.structuredContent)
    expect(payload.resultCount).toBeGreaterThanOrEqual(1)
    expect(payload.results.some((row) => row.qualifiedName === 'src/thing#httpBeacon')).toBe(true)
  })

  test('non-/mcp paths return 404', async () => {
    const { startServe } = await import('../../src/mcp/serve.js')
    const repo = makeTempRepo({ prefix: 'codeindex-http-404-' })
    repos.push(repo)
    const config = await loadConfigForPath(repo.dir)
    const handle = await startServe(config, { port: 0 })
    stops.push(handle.stop)

    const response = await fetch(`http://127.0.0.1:${handle.port}/health`)
    expect(response.status).toBe(404)
  })
})
