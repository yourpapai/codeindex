import type { Database } from 'bun:sqlite'
import path from 'node:path'

import ts from 'typescript'

import { classifyPosition, classifyShape, nodeAtPosition } from './impact-ast.js'
import type { OracleSource, OracleTarget, Shape } from './impact-types.js'

// Re-exported so the focused classifier tests (tests/bench/impact-oracle.test.ts) keep importing
// them from the oracle entrypoint; the implementations now live in impact-ast.ts.
export { classifyPosition, classifyShape } from './impact-ast.js'

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

// Scored targets are `exported` symbols PLUS `member`-tier methods. Members are included so
// this.method() / obj.method() misses (B2) are measurable — they resolve to member-tier symbols
// that exported-only scoring never saw. Functional repos (0 members) are unaffected.
const loadScoredSymbols = (db: Database): readonly DbExportedSymbol[] =>
  db
    .query<{ qualified_name: string; local_name: string; file_path: string; start_line: number }, []>(
      `SELECT qualified_name, local_name, file_path, start_line
       FROM symbols WHERE scope_tier IN ('exported', 'member') ORDER BY qualified_name`,
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

// True when the identifier at `pos` IS the *name* of a declaration (a method/property/variable/
// function/class/interface/enum/type-alias/parameter/object-literal-member), as opposed to a use
// site. `tsc`'s getReferencesAtPosition unifies every implementation of a shared interface member
// into one symbol — so find-references on one `Migration.up` returns the interface signature PLUS
// every sibling migration's `up` DECLARATION. Those sibling declarations are not uses; counting them
// fabricates cross-implementation references (papai: 102 spurious bare-value FNs across 3 migration
// targets, ~18 points of the value gate). A declaration is never an incoming reference, so we skip
// any entry that lands on a declaration name (Slice 5a).
const isReferenceAtDeclarationName = (sf: ts.SourceFile, pos: number): boolean => {
  const node = nodeAtPosition(sf, pos)
  if (!ts.isIdentifier(node)) return false
  const p = node.parent
  if (
    ts.isFunctionDeclaration(p) ||
    ts.isClassDeclaration(p) ||
    ts.isMethodDeclaration(p) ||
    ts.isMethodSignature(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isPropertySignature(p) ||
    ts.isPropertyAssignment(p) ||
    ts.isShorthandPropertyAssignment(p) ||
    ts.isVariableDeclaration(p) ||
    ts.isParameter(p) ||
    ts.isInterfaceDeclaration(p) ||
    ts.isEnumDeclaration(p) ||
    ts.isTypeAliasDeclaration(p)
  ) {
    return p.name === node
  }
  return false
}

// Mirror the indexer's isNamedScopeBoundary + nextEnclosingSymbol: nearest enclosing NAMED
// function/class/method, or arrow/function-expression bound to a named variable declarator
// (a plain `const x = f()` declarator and unnamed callbacks are transparent). Null = module scope.
// A named function-expression bare callback (`register(function inner(){})`) is transparent on BOTH
// sides: extract-symbols emits no symbol for it, so extract-references no longer treats it as a
// boundary either — the reference belongs to the nearest real enclosing symbol, which is what this
// finds. (The pinning test in tests/bench/impact-oracle.test.ts confirms that agreement.)
const nearestNamedBoundary = (node: ts.Node): ts.Node | null => {
  for (let a: ts.Node | undefined = node.parent; a !== undefined && !ts.isSourceFile(a); a = a.parent) {
    if ((ts.isFunctionDeclaration(a) || ts.isClassDeclaration(a)) && a.name !== undefined) return a
    if (ts.isMethodDeclaration(a)) return a
    // A constructor body is its own symbol row (`Class>constructor`) on the indexer side, so a
    // reference inside it belongs to the constructor, NOT the enclosing class. Without this, the
    // oracle attributes a `new Foo()` / `this.x = f()` call in a constructor to `Foo` while
    // code_impact reports `Foo>constructor` — a spurious value/`call` false negative (Slice 5a).
    if (ts.isConstructorDeclaration(a)) return a
    const isNamedVarBoundary =
      (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) &&
      ts.isVariableDeclaration(a.parent) &&
      ts.isIdentifier(a.parent.name)
    if (isNamedVarBoundary) return a.parent
  }
  return null
}

// Deterministically down-sample `items` to at most `maxTargets` by taking evenly-spaced indices across the WHOLE list
// (index floor(i * N / M) for i in [0, M)), rather than a contiguous alphabetical prefix. The pick stays deterministic
// — same list + same `maxTargets` always yield the same indices — so run-over-run regression deltas remain
// attributable to real changes rather than sampling noise (the property the old `.slice(0, maxTargets)` prefix was
// chosen for). Unlike that prefix, a stride reaches the tail of the sorted symbol list, so member-tier methods,
// namespace imports and `new X()` constructors that sort past a cutoff (e.g. papai's `client/shared/*`) still enter
// the scored set. Indices floor(i*N/M) are strictly increasing for 0 <= i < M <= N, so the sample contains M distinct
// items. See the Reassessment Gate memo, whose alphabetical-prefix caveat this removes.
export const strideSample = <T>(items: readonly T[], maxTargets: number): readonly T[] => {
  if (maxTargets <= 0) return []
  if (maxTargets >= items.length) return items
  const out: T[] = []
  for (let i = 0; i < maxTargets; i += 1) {
    const item = items[Math.floor((i * items.length) / maxTargets)]
    if (item !== undefined) out.push(item)
  }
  return out
}

// The codeindex symbol at the nearest named boundary's start line (null: module-scope/self-ref).
const attributeReferenceSource = (
  db: Database,
  sf: ts.SourceFile,
  pos: number,
  relPath: string,
  selfQualifiedName: string,
): string | null => {
  const boundary = nearestNamedBoundary(nodeAtPosition(sf, pos))
  if (boundary === null) return null
  const boundaryLine = sf.getLineAndCharacterOfPosition(boundary.getStart(sf)).line + 1
  const enclosing = enclosingQualifiedName(db, relPath, boundaryLine)
  return enclosing === null || enclosing === selfQualifiedName ? null : enclosing
}

export const buildReferenceOracle = (
  db: Database,
  opts: Readonly<{ repoRoot: string; tsconfigPath: string; maxTargets?: number }>,
): readonly OracleTarget[] => {
  const { program, service } = createTsProject(opts.tsconfigPath)
  const checker = program.getTypeChecker()
  const symbols = loadScoredSymbols(db)
  // `symbols` is ORDER BY qualified_name (loadScoredSymbols above). When a target budget is set we
  // take a deterministic STRIDED sample across that whole sorted list (strideSample), not a
  // contiguous alphabetical prefix: the stride is still fixed run-over-run (so regression deltas
  // stay attributable to real changes), but it spreads targets across every module the sort
  // interleaves — so member/namespace/construct-bearing directories that sort past a prefix cutoff
  // (e.g. papai's `client/shared/*`) still enter the scored set. Without a budget every symbol is
  // scored (codeindex's own gated run), so no sampling applies.
  const selected = opts.maxTargets === undefined ? symbols : strideSample(symbols, opts.maxTargets)
  return selected.map((symbol) => {
    const absFile = path.resolve(opts.repoRoot, symbol.filePath)
    const offset = declarationOffset(program, absFile, symbol.localName, symbol.startLine)
    const entries = offset === null ? [] : (service.getReferencesAtPosition(absFile, offset) ?? [])
    const byName = new Map<string, { value: boolean; type: boolean; shapes: Set<Shape> }>()
    for (const entry of entries) {
      const sf = program.getSourceFile(entry.fileName)
      if (sf === undefined) continue
      const pos = entry.textSpan.start
      // A declaration name is not a use — skip sibling interface-member declarations tsc unifies
      // into the target symbol (Slice 5a; see isReferenceAtDeclarationName).
      if (isReferenceAtDeclarationName(sf, pos)) continue
      const relPath = path.relative(opts.repoRoot, entry.fileName)
      // Nearest named scope boundary, not the innermost symbol (Slice 4a).
      const enclosing = attributeReferenceSource(db, sf, pos, relPath, symbol.qualifiedName)
      if (enclosing === null) continue
      const position = classifyPosition(sf, pos)
      const agg = byName.get(enclosing) ?? { value: false, type: false, shapes: new Set<Shape>() }
      if (position === 'value') {
        agg.value = true
      } else {
        agg.type = true
      }
      agg.shapes.add(classifyShape(sf, pos, checker))
      byName.set(enclosing, agg)
    }
    const trueSources: readonly OracleSource[] = [...byName].map(([name, agg]) => ({
      name,
      position: agg.value && agg.type ? 'both' : agg.value ? 'value' : 'type',
      shapes: [...agg.shapes],
    }))
    return { target: symbol.qualifiedName, trueSources }
  })
}
