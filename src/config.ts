import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

const CodeindexConfigSchema = z.object({
  roots: z.array(z.string().min(1)).default(['src']),
  exclude: z
    .array(z.string().min(1))
    .default(['node_modules', 'dist', '.git', 'coverage', '**/*.test.*', '**/*.spec.*']),
  languages: z.array(z.enum(['ts', 'tsx', 'js', 'jsx'])).default(['ts', 'tsx', 'js', 'jsx']),
  dbPath: z.string().min(1).default('.codeindex/index.db'),
  queriesPath: z.string().min(1).default('.codeindex/queries.db'),
  logQueries: z.boolean().default(true),
  indexLocals: z.boolean().default(true),
  indexVariables: z.boolean().default(true),
  includeDocComments: z.boolean().default(true),
  maxStoredBodyLines: z.number().int().positive().default(120),
  tsconfigPaths: z.array(z.string().min(1)).default(['tsconfig.json']),
})

export type CodeindexConfig = Readonly<
  z.infer<typeof CodeindexConfigSchema> & {
    repoRoot: string
    configPath: string
    dbPath: string
    queriesPath: string
    roots: readonly string[]
    tsconfigPaths: readonly string[]
  }
>

export const relativizeRoots = (config: CodeindexConfig): readonly string[] =>
  config.roots.map((entry) => path.relative(config.repoRoot, entry))

export const computeConfigIdentity = (config: CodeindexConfig): string => {
  const identity = {
    roots: relativizeRoots(config),
    exclude: config.exclude,
    languages: config.languages,
    indexLocals: config.indexLocals,
    indexVariables: config.indexVariables,
    includeDocComments: config.includeDocComments,
    maxStoredBodyLines: config.maxStoredBodyLines,
    tsconfigPaths: config.tsconfigPaths.map((entry) => path.relative(config.repoRoot, entry)),
  }
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

export interface LoadCodeindexConfigInput {
  configPath: string
  repoRoot?: string
}

export const loadCodeindexConfig = async (input: Readonly<LoadCodeindexConfigInput>): Promise<CodeindexConfig> => {
  const configPath = path.resolve(input.configPath)
  const configDir = path.dirname(configPath)
  const repoRoot = input.repoRoot === undefined ? configDir : path.resolve(input.repoRoot)
  const fileContents = await readFile(configPath, 'utf8')
  const parsed = CodeindexConfigSchema.parse(JSON.parse(fileContents) as unknown)
  const resolvedDbPath = path.resolve(repoRoot, parsed.dbPath)
  const resolvedQueriesPath = path.resolve(repoRoot, parsed.queriesPath)

  await mkdir(path.dirname(resolvedDbPath), { recursive: true })
  await mkdir(path.dirname(resolvedQueriesPath), { recursive: true })

  return {
    ...parsed,
    configPath,
    repoRoot,
    dbPath: resolvedDbPath,
    queriesPath: resolvedQueriesPath,
    roots: parsed.roots.map((entry) => path.resolve(repoRoot, entry)),
    tsconfigPaths: parsed.tsconfigPaths.map((entry) => path.resolve(repoRoot, entry)),
  }
}
