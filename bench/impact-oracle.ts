import type { Database } from 'bun:sqlite'
import path from 'node:path'

import ts from 'typescript'

import type { OracleSource, OracleTarget, Shape } from './impact-types.js'

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

// Descend to the innermost node whose span contains `pos` (the reference identifier token).
const nodeAtPosition = (sf: ts.SourceFile, pos: number): ts.Node => {
  const find = (node: ts.Node): ts.Node => {
    const child = node.getChildren(sf).find((c) => pos >= c.getStart(sf) && pos < c.getEnd())
    return child === undefined ? node : find(child)
  }
  return find(sf)
}

// Mirror the indexer's isNamedScopeBoundary + nextEnclosingSymbol: nearest enclosing NAMED
// function/class/method, or arrow/function-expression bound to a named variable declarator
// (a plain `const x = f()` declarator and unnamed callbacks are transparent). Null = module scope.
// (Known minor, errs safe: a NAMED function-expression bare callback, e.g. `setTimeout(function
// foo(){}, 0)`, is a boundary in the indexer but skipped here, attributed to the boundary above;
// vanishingly rare, deliberately deferred.)
const nearestNamedBoundary = (node: ts.Node): ts.Node | null => {
  for (let a: ts.Node | undefined = node.parent; a !== undefined && !ts.isSourceFile(a); a = a.parent) {
    if ((ts.isFunctionDeclaration(a) || ts.isClassDeclaration(a)) && a.name !== undefined) return a
    if (ts.isMethodDeclaration(a)) return a
    const isNamedVarBoundary =
      (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) &&
      ts.isVariableDeclaration(a.parent) &&
      ts.isIdentifier(a.parent.name)
    if (isNamedVarBoundary) return a.parent
  }
  return null
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

// Classify the receiver of a property access: an `import * as ns` binding is a namespace
// reference (B5); `this` or a local value/parameter/variable is a member reference (B2);
// an unresolved receiver is neutral `property-unknown` (never biases a candidate bucket).
const classifyReceiver = (receiver: ts.Expression, checker: ts.TypeChecker): Shape => {
  if (receiver.kind === ts.SyntaxKind.ThisKeyword) return 'member'
  const symbol = checker.getSymbolAtLocation(receiver)
  if (symbol === undefined) return 'property-unknown'
  const declarations = symbol.declarations ?? []
  if (declarations.some((d) => ts.isNamespaceImport(d))) return 'namespace'
  return 'member'
}

// Classify a VALUE-position reference by its syntactic form — the reason code_impact does or does not resolve it. Only
// called for refs classifyPosition labelled 'value'. Heritage is checked first (a class's `extends` base sits under an
// ExpressionWithTypeArguments); then JSX tag, property-access (member/namespace via the receiver), element-access,
// bare call, `new X()` (a NewExpression, distinct from a CallExpression — the shipped resolver doesn't emit an edge
// for it either, but it's tracked as its own 'construct' shape rather than folded into 'call' or left to fall through
// to 'bare-value', since a plain call is resolved and a constructor call is not), and finally a bare value identifier.
export const classifyShape = (sf: ts.SourceFile, pos: number, checker: ts.TypeChecker): Shape => {
  const node = nodeAtPosition(sf, pos)
  for (let a: ts.Node | undefined = node; a !== undefined && !ts.isSourceFile(a); a = a.parent) {
    if (ts.isHeritageClause(a)) return 'heritage'
  }
  const parent = node.parent
  if (
    parent !== undefined &&
    (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) &&
    parent.tagName === node
  ) {
    return 'jsx'
  }
  if (parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return classifyReceiver(parent.expression, checker)
  }
  if (parent !== undefined && ts.isElementAccessExpression(parent)) return 'other'
  if (parent !== undefined && ts.isCallExpression(parent) && parent.expression === node) return 'call'
  if (parent !== undefined && ts.isNewExpression(parent) && parent.expression === node) return 'construct'
  return 'bare-value'
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
      const relPath = path.relative(opts.repoRoot, entry.fileName)
      // Nearest named scope boundary, not the innermost symbol (Slice 4a).
      const enclosing = attributeReferenceSource(db, sf, pos, relPath, symbol.qualifiedName)
      if (enclosing === null) continue
      const position = classifyPosition(sf, pos)
      const agg = byName.get(enclosing) ?? { value: false, type: false, shapes: new Set<Shape>() }
      if (position === 'value') {
        agg.value = true
        agg.shapes.add(classifyShape(sf, pos, checker))
      } else {
        agg.type = true
      }
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
