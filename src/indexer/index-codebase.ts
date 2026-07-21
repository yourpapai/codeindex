import type { Database } from 'bun:sqlite'
import { readFile } from 'node:fs/promises'

import type { CodeindexConfig } from '../config.js'
import { buildModuleIdentity, type ModuleAlias } from '../resolver/module-specifiers.js'
import { resolveReferenceCandidates } from '../resolver/resolve-references.js'
import {
  expandTsconfigAliasesForFile,
  loadTsconfigPathAliases,
  type TsconfigAliasRule,
} from '../resolver/tsconfig-paths.js'
import { openDatabase } from '../storage/db.js'
import {
  clearFileRows,
  insertFile,
  markParseFailure,
  persistAliases,
  persistModuleExports,
  persistSymbols,
  selectAllFiles,
  selectAllModuleAliases,
  selectAllSymbols,
  selectStoredSymbols,
} from '../storage/queries.js'
import { ensureSchema } from '../storage/schema.js'
import type { DiscoveredFile } from './discover.js'
import { extractReferenceCandidates, type ExtractReferenceCandidatesResult } from './extract-references.js'
import { extractSymbolsFromSource, type ExtractedSymbol } from './extract-symbols.js'
import { createParserLoader, type ParserLoader } from './parser.js'
import { resolveFilesToProcess, sha256 } from './resolve-files.js'
import { stampIndexProvenance } from './stamp-provenance.js'

export interface IndexSummary {
  readonly filesIndexed: number
  readonly filesFailed: number
  readonly filesPruned: number
  readonly symbolsIndexed: number
  readonly referencesIndexed: number
  readonly referencesUnresolved: number
  readonly elapsedMs: number
}

export type IndexPhase = 'init' | 'discover' | 'parse' | 'persist' | 'resolve' | 'provenance'

export interface IndexCodebaseInput {
  readonly config: CodeindexConfig
  readonly mode: 'full' | 'incremental'
  readonly onPhase?: (phase: IndexPhase, ms: number) => void
}

interface ParsedFileWorkItem {
  readonly fileId: number
  readonly moduleKey: string
  readonly referenceCandidates: ExtractReferenceCandidatesResult
}

interface ProcessedFileSuccess {
  readonly status: 'ok'
  readonly aliases: readonly ModuleAlias[]
  readonly file: DiscoveredFile
  readonly fileHash: string
  readonly language: string
  readonly moduleKey: string
  readonly referenceCandidates: ExtractReferenceCandidatesResult
  readonly symbols: readonly ExtractedSymbol[]
}

interface ProcessedFileFailure {
  readonly status: 'error'
  readonly file: DiscoveredFile
  readonly message: string
}

type ProcessedFile = ProcessedFileSuccess | ProcessedFileFailure

const parseFile = async (
  config: CodeindexConfig,
  file: DiscoveredFile,
  parserLoader: ParserLoader,
  tsconfigAliases: readonly TsconfigAliasRule[],
): Promise<ProcessedFile> => {
  try {
    const source = await readFile(file.absolutePath, 'utf8')
    const fileHash = sha256(source)
    const { moduleKey, aliases } = buildModuleIdentity(file.relativePath)
    const parsed = await parserLoader.createParserForExtension(file.extension)
    const tree = parsed.parser.parse(source)
    if (tree === null) {
      throw new Error(`Failed to parse ${file.relativePath}`)
    }

    return {
      status: 'ok',
      aliases: [...aliases, ...expandTsconfigAliasesForFile(file.absolutePath, tsconfigAliases)],
      file,
      fileHash,
      language: parsed.language,
      moduleKey,
      referenceCandidates: extractReferenceCandidates({
        source,
        tree,
        relativeFilePath: file.relativePath,
        moduleKey,
      }),
      symbols: extractSymbolsFromSource({
        source,
        tree,
        relativeFilePath: file.relativePath,
        moduleKey,
        maxStoredBodyLines: config.maxStoredBodyLines,
        includeDocComments: config.includeDocComments,
        indexLocals: config.indexLocals,
        indexVariables: config.indexVariables,
      }),
    }
  } catch (error) {
    return {
      status: 'error',
      file,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

const persistProcessedFile = (db: Database, processedFile: ProcessedFileSuccess): ParsedFileWorkItem => {
  const fileId = insertFile(db, {
    filePath: processedFile.file.relativePath,
    moduleKey: processedFile.moduleKey,
    language: processedFile.language,
    fileHash: processedFile.fileHash,
  })

  clearFileRows(db, fileId)
  persistAliases(db, fileId, processedFile.aliases)
  persistSymbols(db, fileId, processedFile.file.relativePath, processedFile.moduleKey, processedFile.symbols)
  persistModuleExports(db, fileId, processedFile.referenceCandidates, selectStoredSymbols(db, fileId))

  return {
    fileId,
    moduleKey: processedFile.moduleKey,
    referenceCandidates: processedFile.referenceCandidates,
  }
}

const applyProcessedFiles = (
  db: Database,
  processedFiles: readonly ProcessedFile[],
): Readonly<{
  filesIndexed: number
  filesFailed: number
  symbolsIndexed: number
  parsedFiles: ParsedFileWorkItem[]
}> => {
  let filesIndexed = 0
  let filesFailed = 0
  let symbolsIndexed = 0
  const parsedFiles: ParsedFileWorkItem[] = []

  for (const processedFile of processedFiles) {
    if (processedFile.status === 'error') {
      filesFailed += 1
      markParseFailure(db, processedFile.file, processedFile.message)
      continue
    }

    parsedFiles.push(persistProcessedFile(db, processedFile))
    filesIndexed += 1
    symbolsIndexed += processedFile.symbols.length
  }

  return { filesIndexed, filesFailed, symbolsIndexed, parsedFiles }
}

const persistResolvedReferences = (
  db: Database,
  parsedFiles: readonly ParsedFileWorkItem[],
): Readonly<{ referencesIndexed: number; referencesUnresolved: number }> => {
  const allSymbols = selectAllSymbols(db)
  const allFiles = selectAllFiles(db)
  const allModuleAliases = selectAllModuleAliases(db)
  let referencesIndexed = 0
  let referencesUnresolved = 0

  for (const parsedFile of parsedFiles) {
    const resolvedReferences = resolveReferenceCandidates({
      symbols: allSymbols,
      moduleAliases: allModuleAliases,
      files: allFiles,
      references: parsedFile.referenceCandidates.references,
      currentModuleKey: parsedFile.moduleKey,
    })

    for (const reference of resolvedReferences) {
      db.query(
        'INSERT INTO symbol_references (source_symbol_id, source_file_id, target_symbol_id, target_file_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        reference.sourceSymbolId,
        parsedFile.fileId,
        reference.targetSymbolId,
        reference.targetFileId,
        reference.targetName,
        reference.targetExportName,
        reference.targetModuleSpecifier,
        reference.edgeType,
        reference.confidence,
        reference.lineNumber,
      )
      referencesIndexed += 1
      if (reference.targetSymbolId === null) {
        referencesUnresolved += 1
      }
    }
  }

  return { referencesIndexed, referencesUnresolved }
}

const emitPhase = (
  onPhase: ((phase: IndexPhase, ms: number) => void) | undefined,
  phase: IndexPhase,
  since: number,
): void => {
  if (onPhase !== undefined) {
    onPhase(phase, Date.now() - since)
  }
}

interface IndexPhasesResult {
  readonly filesIndexed: number
  readonly filesFailed: number
  readonly filesPruned: number
  readonly symbolsIndexed: number
  readonly referencesIndexed: number
  readonly referencesUnresolved: number
}

const runIndexPhases = async (db: Database, input: Readonly<IndexCodebaseInput>): Promise<IndexPhasesResult> => {
  ensureSchema(db)
  let mark = Date.now()
  const parserLoader = await createParserLoader()
  const tsconfigAliases = loadTsconfigPathAliases(input.config.tsconfigPaths)
  emitPhase(input.onPhase, 'init', mark)

  mark = Date.now()
  const { filesToProcess, filesPruned } = await resolveFilesToProcess(db, input.config, input.mode)
  emitPhase(input.onPhase, 'discover', mark)

  mark = Date.now()
  const processedFiles = await Promise.all(
    filesToProcess.map((file) => parseFile(input.config, file, parserLoader, tsconfigAliases)),
  )
  emitPhase(input.onPhase, 'parse', mark)

  mark = Date.now()
  const { filesIndexed, filesFailed, symbolsIndexed, parsedFiles } = applyProcessedFiles(db, processedFiles)
  emitPhase(input.onPhase, 'persist', mark)

  mark = Date.now()
  const { referencesIndexed, referencesUnresolved } = persistResolvedReferences(db, parsedFiles)
  emitPhase(input.onPhase, 'resolve', mark)

  mark = Date.now()
  stampIndexProvenance(db, input.config)
  emitPhase(input.onPhase, 'provenance', mark)

  return {
    filesIndexed,
    filesFailed,
    filesPruned,
    symbolsIndexed,
    referencesIndexed,
    referencesUnresolved,
  }
}

export const indexCodebase = async (input: Readonly<IndexCodebaseInput>): Promise<IndexSummary> => {
  const startedAt = Date.now()
  const db = openDatabase(input.config.dbPath)

  try {
    const result = await runIndexPhases(db, input)
    return {
      ...result,
      elapsedMs: Date.now() - startedAt,
    }
  } finally {
    db.close()
  }
}
