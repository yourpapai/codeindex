import type { Database } from 'bun:sqlite'
import path from 'node:path'

import ts from 'typescript'

import type { OracleSource, OracleTarget } from './impact-types.js'

export interface TsProject {
  readonly service: ts.LanguageService
  readonly program: ts.Program
}

export const createTsProject = (tsconfigPath: string): TsProject => {
  const configFile = ts.readConfigFile(tsconfigPath, (filePath) => ts.sys.readFile(filePath))
  if (configFile.error !== undefined) {
    throw new Error(`Failed to read tsconfig: ${tsconfigPath}`)
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath))
  const versions = new Map(parsed.fileNames.map((f) => [path.resolve(f), '0']))
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...versions.keys()],
    getScriptVersion: (fileName) => versions.get(path.resolve(fileName)) ?? '0',
    getScriptSnapshot: (fileName) => {
      const text = ts.sys.readFile(fileName)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => path.dirname(tsconfigPath),
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (filePath) => ts.sys.fileExists(filePath),
    readFile: (filePath, encoding) => ts.sys.readFile(filePath, encoding),
    readDirectory: (rootDir, extensions, excludes, includes, depth) =>
      ts.sys.readDirectory(rootDir, extensions, excludes, includes, depth),
    directoryExists: (directoryName) => ts.sys.directoryExists(directoryName),
    getDirectories: (directoryName) => ts.sys.getDirectories(directoryName),
  }
  const service = ts.createLanguageService(host, ts.createDocumentRegistry())
  const program = service.getProgram()
  if (program === undefined) {
    throw new Error('Failed to construct ts.Program from language service')
  }
  return { service, program }
}

interface DbExportedSymbol {
  readonly qualifiedName: string
  readonly localName: string
  readonly filePath: string
  readonly startLine: number
}

const loadExportedSymbols = (db: Database): readonly DbExportedSymbol[] =>
  db
    .query<{ qualified_name: string; local_name: string; file_path: string; start_line: number }, []>(
      `SELECT qualified_name, local_name, file_path, start_line
       FROM symbols WHERE scope_tier = 'exported' ORDER BY qualified_name`,
    )
    .all()
    .map((r) => ({
      qualifiedName: r.qualified_name,
      localName: r.local_name,
      filePath: r.file_path,
      startLine: r.start_line,
    }))

const enclosingQualifiedName = (db: Database, filePath: string, line: number): string | null =>
  db
    .query<{ qualified_name: string }, [string, number, number]>(
      `SELECT qualified_name FROM symbols
       WHERE file_path = ? AND start_line <= ? AND end_line >= ?
       ORDER BY (end_line - start_line) ASC LIMIT 1`,
    )
    .get(filePath, line, line)?.qualified_name ?? null

type NamedDeclaration =
  | ts.FunctionDeclaration
  | ts.ClassDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | ts.EnumDeclaration
  | ts.VariableDeclaration
  | ts.MethodDeclaration

// True when `node` is one of the declaration forms that give a symbol its name
// (function / class, incl. abstract / interface / type-alias / variable declarator /
// method / enum) — i.e. a node with a `name` property comparable to an identifier.
const isNamedDeclaration = (node: ts.Node): node is NamedDeclaration =>
  ts.isFunctionDeclaration(node) ||
  ts.isClassDeclaration(node) ||
  ts.isInterfaceDeclaration(node) ||
  ts.isTypeAliasDeclaration(node) ||
  ts.isEnumDeclaration(node) ||
  ts.isVariableDeclaration(node) ||
  ts.isMethodDeclaration(node)

// True when `identifier` IS the name of its parent declaration, as opposed to some
// unrelated identifier that merely shares the same text nearby (an object-literal
// property key, a parameter, a plain reference) — see declarationOffset below.
const isDeclarationName = (identifier: ts.Identifier): boolean =>
  isNamedDeclaration(identifier.parent) && identifier.parent.name === identifier

const declarationOffset = (
  program: ts.Program,
  absFilePath: string,
  localName: string,
  startLine: number,
): number | null => {
  const sf = program.getSourceFile(absFilePath)
  if (sf === undefined) return null
  let offset: number | null = null
  const visit = (node: ts.Node): void => {
    if (offset !== null) return
    // Require the identifier to BE a declaration name, not merely text-equal to one
    // nearby (e.g. a same-named parameter, property key, or reference) — otherwise
    // getReferencesAtPosition runs at the wrong AST node entirely.
    if (ts.isIdentifier(node) && node.text === localName && isDeclarationName(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      // start_line proximity disambiguates multiple same-named declarations in the
      // file (e.g. overloads, or the same name declared in nested scopes).
      if (Math.abs(line - startLine) <= 1) offset = node.getStart(sf)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return offset
}

// Descend to the innermost node whose span contains `pos` (the reference identifier token).
const nodeAtPosition = (sf: ts.SourceFile, pos: number): ts.Node => {
  const find = (node: ts.Node): ts.Node => {
    const child = node.getChildren(sf).find((c) => pos >= c.getStart(sf) && pos < c.getEnd())
    return child === undefined ? node : find(child)
  }
  return find(sf)
}

// Classify a reference position as value or type. A HeritageClause ANYWHERE up the chain
// decides first: `implements` (and an interface's `extends`) are type; a class's `extends`
// is value — even though its base sits inside an ExpressionWithTypeArguments, which is
// itself a type-node (verified against tsc). Otherwise any type-node ancestor means type.
// Default value: the fail-safe never hides a value false-negative.
// Exported for the focused fixture test (tests/bench/impact-oracle.test.ts) — the trust-critical
// classifier is pinned directly against hand-built ASTs, not only through the full oracle pipeline.
export const classifyPosition = (sf: ts.SourceFile, pos: number): 'value' | 'type' => {
  const node = nodeAtPosition(sf, pos)
  for (let a: ts.Node | undefined = node; a !== undefined && !ts.isSourceFile(a); a = a.parent) {
    if (ts.isHeritageClause(a)) {
      if (a.token === ts.SyntaxKind.ImplementsKeyword) return 'type'
      return ts.isClassDeclaration(a.parent) || ts.isClassExpression(a.parent) ? 'value' : 'type'
    }
  }
  for (let a: ts.Node | undefined = node; a !== undefined && !ts.isSourceFile(a); a = a.parent) {
    if (ts.isTypeNode(a)) return 'type'
  }
  return 'value'
}

export const buildReferenceOracle = (
  db: Database,
  opts: Readonly<{ repoRoot: string; tsconfigPath: string; maxTargets?: number }>,
): readonly OracleTarget[] => {
  const { program, service } = createTsProject(opts.tsconfigPath)
  const symbols = loadExportedSymbols(db)
  // NOTE: `symbols` is ORDER BY qualified_name (loadExportedSymbols above), so this
  // slice takes a deterministic ALPHABETICAL PREFIX of exported symbols, not a
  // representative random sample. That's intentional for run-over-run regression
  // comparison (the same targets are scored every run, so deltas are attributable to
  // real changes rather than sampling noise) but it means the resulting FN/FP rates
  // are biased toward whatever symbol kinds/modules happen to sort first and should
  // NOT be read as a representative estimate across the whole repo. A representative
  // estimate would need a strided or seeded random sample — left for a future slice.
  const selected = opts.maxTargets === undefined ? symbols : symbols.slice(0, opts.maxTargets)
  return selected.map((symbol) => {
    const absFile = path.resolve(opts.repoRoot, symbol.filePath)
    const offset = declarationOffset(program, absFile, symbol.localName, symbol.startLine)
    const entries = offset === null ? [] : (service.getReferencesAtPosition(absFile, offset) ?? [])
    const byName = new Map<string, { value: boolean; type: boolean }>()
    for (const entry of entries) {
      const sf = program.getSourceFile(entry.fileName)
      if (sf === undefined) continue
      const pos = entry.textSpan.start
      const line = sf.getLineAndCharacterOfPosition(pos).line + 1
      const relPath = path.relative(opts.repoRoot, entry.fileName)
      const enclosing = enclosingQualifiedName(db, relPath, line)
      // Exclude module-scope refs (unnameable by code_impact) and self-references.
      if (enclosing === null || enclosing === symbol.qualifiedName) continue
      const position = classifyPosition(sf, pos)
      const agg = byName.get(enclosing) ?? { value: false, type: false }
      if (position === 'value') agg.value = true
      else agg.type = true
      byName.set(enclosing, agg)
    }
    const trueSources: readonly OracleSource[] = [...byName].map(([name, agg]) => ({
      name,
      position: agg.value && agg.type ? 'both' : agg.value ? 'value' : 'type',
    }))
    return { target: symbol.qualifiedName, trueSources }
  })
}
