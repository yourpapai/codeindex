import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'

import { createMcpRuntime, type CreateMcpRuntimeOptions } from '../cli.js'
import type { CodeindexConfig } from '../config.js'

export const DEFAULT_SERVE_PORT = 3456
export const SERVE_HOST = '127.0.0.1'
export const SERVE_PATH = '/mcp'
export const MIN_TOKEN_LENGTH = 32

export const ServePortSchema = z.number().int().min(1).max(65535)

export const validateServeToken = (token: string): string => {
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`Serve token must be at least ${MIN_TOKEN_LENGTH} characters (got ${token.length})`)
  }
  return token
}

export const loadServeToken = (): string | null => {
  const fromEnv = process.env['CODEINDEX_TOKEN']
  if (fromEnv !== undefined && fromEnv !== '') {
    return validateServeToken(fromEnv)
  }
  const filePath = process.env['CODEINDEX_TOKEN_FILE']
  if (filePath !== undefined && filePath !== '') {
    return validateServeToken(readFileSync(filePath, 'utf8').trim())
  }
  return null
}

const tokensMatch = (presented: string, expected: string): boolean => {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    // Equalize work on length mismatch; never leak via early return alone.
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

const bearerAuthorized = (header: string | null, token: string): boolean => {
  if (header === null) return false
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return false
  return tokensMatch(header.slice(prefix.length), token)
}

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
  /** Test seam: replace the process-level reindex runner. */
  readonly indexRunner?: CreateMcpRuntimeOptions['indexRunner']
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

const unauthorized = (): Response =>
  new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Bearer' },
  })

const createSessionTransport = (
  transports: Map<string, WebStandardStreamableHTTPServerTransport>,
  enableJsonResponse: boolean,
): WebStandardStreamableHTTPServerTransport => {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: (): string => randomUUID(),
    onsessioninitialized: (id: string): void => {
      transports.set(id, transport)
    },
    onsessionclosed: (id: string): void => {
      transports.delete(id)
    },
    enableJsonResponse,
  })
  transport.onclose = (): void => {
    if (transport.sessionId !== undefined) {
      transports.delete(transport.sessionId)
    }
  }
  return transport
}

interface ServeFetchContext {
  readonly token: string | null
  readonly enableJsonResponse: boolean
  readonly transports: Map<string, WebStandardStreamableHTTPServerTransport>
  readonly createServer: () => McpServer
}

const createServeFetch = (context: Readonly<ServeFetchContext>): ((req: Request) => Promise<Response>) => {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    if (url.pathname !== SERVE_PATH) {
      return new Response('Not Found', { status: 404 })
    }
    if (context.token !== null && !bearerAuthorized(req.headers.get('authorization'), context.token)) {
      return unauthorized()
    }

    const sessionId = req.headers.get('mcp-session-id')
    if (sessionId !== null) {
      const existing = context.transports.get(sessionId)
      if (existing === undefined) {
        return new Response('Session not found', { status: 404 })
      }
      return existing.handleRequest(req)
    }
    if (req.method !== 'POST') {
      return new Response('Bad Request', { status: 400 })
    }

    const server = context.createServer()
    const transport = createSessionTransport(context.transports, context.enableJsonResponse)
    await server.connect(transport)
    return transport.handleRequest(req)
  }
}

const bindServe = (
  port: number,
  fetchHandler: (req: Request) => Promise<Response>,
  onFail: () => void,
  repoRoot: string,
): ReturnType<typeof Bun.serve> => {
  try {
    return Bun.serve({
      hostname: SERVE_HOST,
      port,
      fetch: fetchHandler,
    })
  } catch (error) {
    onFail()
    if (isAddrInUse(error)) {
      throw new Error(
        `Port ${port} is already in use for repo ${repoRoot}. ` +
          `Another process (or worktree) may already be serving MCP on this port. ` +
          `Pass --port <n> to pick a free port.`,
        { cause: error },
      )
    }
    throw error
  }
}

export const startServe = async (
  config: CodeindexConfig,
  options: Readonly<StartServeOptions> = {},
): Promise<ServeHandle> => {
  const port = options.port ?? DEFAULT_SERVE_PORT
  const { createServer, watcher } = createMcpRuntime(config, {
    indexRunner: options.indexRunner,
  })
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>()
  const fetchHandler = createServeFetch({
    token: options.token ?? null,
    enableJsonResponse: options.enableJsonResponse ?? true,
    transports,
    createServer,
  })
  const server = bindServe(
    port,
    fetchHandler,
    (): void => {
      watcher.stop()
    },
    config.repoRoot,
  )
  await watcher.start()

  const stop = async (): Promise<void> => {
    watcher.stop()
    await Promise.all([...transports.values()].map((transport) => transport.close().catch(() => undefined)))
    transports.clear()
    void server.stop()
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
