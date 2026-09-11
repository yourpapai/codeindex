import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

import { createMcpRuntime } from '../cli.js'
import type { CodeindexConfig } from '../config.js'

export const DEFAULT_SERVE_PORT = 3456
export const SERVE_HOST = '127.0.0.1'
export const SERVE_PATH = '/mcp'

export const ServePortSchema = z.number().int().min(1).max(65535)

export interface ServeCliArgs {
  readonly port: number
  readonly path?: string
}

export const parseServeArgs = (argv: readonly string[]): ServeCliArgs => {
  let port: number | undefined
  let path: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--port') {
      const raw = argv[i + 1]
      i += 1
      if (raw === undefined) {
        throw new Error('--port requires a value')
      }
      const parsedNumber = Number(raw)
      const result = ServePortSchema.safeParse(parsedNumber)
      if (!result.success) {
        throw new Error(`Invalid --port: ${raw} (expected an integer between 1 and 65535)`)
      }
      port = result.data
      continue
    }
    if (arg === '--host') {
      // Reserved; bind address is always loopback.
      if (argv[i + 1] !== undefined) i += 1
      continue
    }
    if (!arg.startsWith('--') && path === undefined) {
      path = arg
    }
  }
  return { port: port ?? DEFAULT_SERVE_PORT, path }
}

export interface StartServeOptions {
  readonly port?: number
  readonly token?: string | null
  /** Pin JSON responses instead of SSE streams. Default true (design D6). */
  readonly enableJsonResponse?: boolean
}

export interface ServeHandle {
  readonly url: string
  readonly port: number
  readonly stop: () => Promise<void>
}

const isAddrInUse = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined
  if (code === 'EADDRINUSE') return true
  return error instanceof Error && /address already in use|EADDRINUSE/i.test(error.message)
}

export const startServe = async (
  config: CodeindexConfig,
  options: Readonly<StartServeOptions> = {},
): Promise<ServeHandle> => {
  const port = options.port ?? DEFAULT_SERVE_PORT
  const token = options.token ?? null
  const enableJsonResponse = options.enableJsonResponse ?? true
  const { createServer, watcher } = createMcpRuntime(config)
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>()

  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    if (url.pathname !== SERVE_PATH) {
      return new Response('Not Found', { status: 404 })
    }

    if (token !== null) {
      const header = req.headers.get('authorization')
      if (header === null || header !== `Bearer ${token}`) {
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer' },
        })
      }
    }

    const sessionId = req.headers.get('mcp-session-id')
    if (sessionId !== null) {
      const existing = transports.get(sessionId)
      if (existing === undefined) {
        return new Response('Session not found', { status: 404 })
      }
      return existing.handleRequest(req)
    }

    if (req.method !== 'POST') {
      return new Response('Bad Request', { status: 400 })
    }

    const server = createServer()
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport)
      },
      onsessionclosed: (id) => {
        transports.delete(id)
      },
      enableJsonResponse,
    })
    transport.onclose = (): void => {
      if (transport.sessionId !== undefined) {
        transports.delete(transport.sessionId)
      }
    }
    await server.connect(transport)
    return transport.handleRequest(req)
  }

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      hostname: SERVE_HOST,
      port,
      fetch,
    })
  } catch (error) {
    watcher.stop()
    if (isAddrInUse(error)) {
      throw new Error(
        `Port ${port} is already in use for repo ${config.repoRoot}. ` +
          `Another process (or worktree) may already be serving MCP on this port. ` +
          `Pass --port <n> to pick a free port.`,
      )
    }
    throw error
  }

  await watcher.start()

  const stop = async (): Promise<void> => {
    watcher.stop()
    for (const transport of [...transports.values()]) {
      await transport.close().catch(() => undefined)
    }
    transports.clear()
    server.stop()
  }

  const boundPort = server.port ?? port
  return {
    url: `http://${SERVE_HOST}:${boundPort}${SERVE_PATH}`,
    port: boundPort,
    stop,
  }
}

export const runServeCommand = async (
  config: CodeindexConfig,
  options: Readonly<StartServeOptions> = {},
): Promise<void> => {
  const handle = await startServe(config, options)
  console.error(`codeindex MCP server listening on ${handle.url}`)

  await new Promise<void>((resolve) => {
    let stopping = false
    const onSignal = (): void => {
      if (stopping) return
      stopping = true
      void handle.stop().finally(() => {
        resolve()
      })
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  })
}
