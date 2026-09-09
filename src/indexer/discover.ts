import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import ignore from 'ignore'

import type { SupportedLanguage } from '../types.js'

export interface DiscoverSourceFilesInput {
  readonly repoRoot: string
  readonly roots: readonly string[]
  readonly exclude: readonly string[]
  readonly languages: readonly SupportedLanguage[]
  readonly maxFileSizeBytes: number
}

export interface DiscoverResult {
  readonly files: readonly DiscoveredFile[]
  readonly skippedFiles: readonly string[]
}

export interface IndexablePathFilter {
  readonly isIndexable: (relativePath: string) => boolean
}

// The event-side counterpart of discoverSourceFiles: an identical predicate over one
// relative path — extension, exclude/gitignore matcher, and root containment. Used by
// the MCP watcher so an fs.watch event passes exactly the rules discovery applies.
export const createIndexablePathFilter = async (
  input: Readonly<DiscoverSourceFilesInput>,
): Promise<IndexablePathFilter> => {
  const matcher = ignore()
    .add(await readGitignore(input.repoRoot))
    .add([...input.exclude])
  const supportedExtensions = supportedExtensionsFor(input.languages)
  return {
    isIndexable: (relativePath: string): boolean => {
      if (!supportedExtensions.has(path.extname(relativePath))) return false
      if (matcher.ignores(relativePath)) return false
      return input.roots.some((root) => {
        const rel = path.relative(root, path.join(input.repoRoot, relativePath))
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
      })
    },
  }
}

export interface DiscoveredFile {
  readonly absolutePath: string
  readonly relativePath: string
  readonly extension: string
}

const supportedExtensionsFor = (languages: readonly SupportedLanguage[]): ReadonlySet<string> =>
  new Set(languages.map((language) => `.${language}`))

const readGitignore = async (repoRoot: string): Promise<string> => {
  try {
    return await readFile(path.join(repoRoot, '.gitignore'), 'utf8')
  } catch (error) {
    if (isEnoent(error)) return ''
    console.error(
      `codeindex: .gitignore exists but could not be read (${error instanceof Error ? error.message : String(error)}) — proceeding without ignore rules`,
    )
    return ''
  }
}

const isEnoent = (err: unknown): boolean =>
  err !== null && typeof err === 'object' && 'code' in err && err.code === 'ENOENT'

const walk = async (dir: string, repoRoot: string, matcher: ReturnType<typeof ignore>): Promise<readonly string[]> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch((err: unknown) => {
    if (isEnoent(err)) return null
    throw err
  })
  if (entries === null) return []
  const discovered = await Promise.all(
    entries.map((entry): Promise<readonly string[]> => {
      const absolutePath = path.join(dir, entry.name)
      const relativePath = path.relative(repoRoot, absolutePath)

      if (matcher.ignores(relativePath)) {
        return Promise.resolve([])
      }
      if (entry.isDirectory()) {
        return walk(absolutePath, repoRoot, matcher)
      }
      if (entry.isFile()) {
        return Promise.resolve([absolutePath])
      }
      return Promise.resolve([])
    }),
  )

  return discovered.flat()
}

export const discoverSourceFiles = async (input: Readonly<DiscoverSourceFilesInput>): Promise<DiscoverResult> => {
  const matcher = ignore()
    .add(await readGitignore(input.repoRoot))
    .add([...input.exclude])
  const supportedExtensions = supportedExtensionsFor(input.languages)
  const files = await Promise.all(input.roots.map((root) => walk(root, input.repoRoot, matcher)))

  const candidates = files
    .flat()
    .map((absolutePath) => {
      const relativePath = path.relative(input.repoRoot, absolutePath)
      return {
        absolutePath,
        relativePath,
        extension: path.extname(absolutePath),
      }
    })
    .filter((entry) => supportedExtensions.has(entry.extension))
    .filter((entry) => !matcher.ignores(entry.relativePath))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))

  // A stat can fail when a file vanishes between walk and stat (TOCTOU). Catch per entry and drop
  // it — a vanished file is equivalent to an excluded file — instead of letting one failure reject
  // the whole pass, mirroring the parse phase's per-file failure contract.
  const sized = await Promise.all(
    candidates.map(async (entry) => {
      try {
        return { entry, size: (await stat(entry.absolutePath)).size }
      } catch {
        return null
      }
    }),
  )
  const kept: DiscoveredFile[] = []
  const skippedFiles: string[] = []
  for (const sizedEntry of sized) {
    if (sizedEntry === null) continue
    if (sizedEntry.size > input.maxFileSizeBytes) {
      skippedFiles.push(sizedEntry.entry.relativePath)
      continue
    }
    kept.push(sizedEntry.entry)
  }
  return { files: kept, skippedFiles }
}
