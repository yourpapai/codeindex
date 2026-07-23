import type { Node as SyntaxNode } from 'web-tree-sitter'

import type { ExportKind, ReferenceEdgeType } from '../types.js'

export interface ModuleExportCandidate {
  readonly exportName: string
  readonly exportKind: ExportKind
  readonly localName: string | null
  readonly targetModuleSpecifier: string | null
}

export interface ReferenceCandidate {
  readonly sourceQualifiedName: string | null
  readonly edgeType: ReferenceEdgeType
  readonly targetName: string
  readonly targetExportName: string | null
  readonly targetModuleSpecifier: string | null
  readonly lineNumber: number
}

export const normalizeSpecifier = (node: SyntaxNode | null | undefined): string | null => {
  const text = node?.text
  if (text === undefined) return null
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1)
  }
  return text
}

const pushExportSpecifier = (
  child: SyntaxNode,
  sourceSpecifier: string | null,
  moduleExports: ModuleExportCandidate[],
  references: ReferenceCandidate[],
): void => {
  const localName = child.childForFieldName('name')?.text ?? null
  moduleExports.push({
    exportName: child.childForFieldName('alias')?.text ?? localName ?? child.text,
    exportKind: sourceSpecifier === null ? 'named' : 'reexport',
    localName,
    targetModuleSpecifier: sourceSpecifier,
  })
  if (sourceSpecifier === null) return
  const targetName = localName ?? child.text
  references.push({
    sourceQualifiedName: null,
    edgeType: 'reexports',
    targetName,
    targetExportName: targetName,
    targetModuleSpecifier: sourceSpecifier,
    lineNumber: child.startPosition.row + 1,
  })
}

const hasDefaultKeyword = (node: SyntaxNode): boolean => {
  for (let i = 0; i < node.childCount; i += 1) {
    if (node.child(i)?.type === 'default') return true
  }
  return false
}

const pushNamedExportCandidate = (
  exportStatement: SyntaxNode,
  declarationNode: SyntaxNode,
  moduleExports: ModuleExportCandidate[],
): void => {
  const localName = declarationNode.childForFieldName('name')?.text
  const isDefault = hasDefaultKeyword(exportStatement)
  if (localName !== undefined) {
    moduleExports.push({
      exportName: isDefault ? 'default' : localName,
      exportKind: isDefault ? 'default' : 'named',
      localName,
      targetModuleSpecifier: null,
    })
  } else if (isDefault) {
    moduleExports.push({ exportName: 'default', exportKind: 'default', localName: null, targetModuleSpecifier: null })
  }
}

const pushLexicalExportCandidates = (
  exportStatement: SyntaxNode,
  lexicalDecl: SyntaxNode,
  moduleExports: ModuleExportCandidate[],
): void => {
  const isDefault = hasDefaultKeyword(exportStatement)
  for (let i = 0; i < lexicalDecl.namedChildCount; i += 1) {
    const declarator = lexicalDecl.namedChild(i)
    if (declarator?.type !== 'variable_declarator') continue
    const localName = declarator.childForFieldName('name')?.text
    if (localName === undefined) continue
    moduleExports.push({
      exportName: isDefault ? 'default' : localName,
      exportKind: isDefault ? 'default' : 'named',
      localName,
      targetModuleSpecifier: null,
    })
  }
}

const handleFunctionExportChild = (
  exportStatement: SyntaxNode,
  child: SyntaxNode,
  enclosingSymbol: string | null,
  moduleKey: string,
  moduleExports: ModuleExportCandidate[],
  visit: (node: SyntaxNode, enc: string | null) => void,
): void => {
  pushNamedExportCandidate(exportStatement, child, moduleExports)
  const isAnonymousDefault = child.childForFieldName('name') === null && hasDefaultKeyword(exportStatement)
  const newEnclosing = isAnonymousDefault
    ? enclosingSymbol === null
      ? `${moduleKey}#default`
      : `${enclosingSymbol}>default`
    : enclosingSymbol
  visit(child, newEnclosing)
}

const collectExportClauseSpecifiers = (
  clauseNode: SyntaxNode,
  sourceSpecifier: string | null,
  moduleExports: ModuleExportCandidate[],
  references: ReferenceCandidate[],
): void => {
  for (let i = 0; i < clauseNode.namedChildCount; i += 1) {
    const child = clauseNode.namedChild(i)
    if (child?.type === 'export_specifier') pushExportSpecifier(child, sourceSpecifier, moduleExports, references)
  }
}

const NAMED_TYPE_EXPORT_KINDS = new Set(['interface_declaration', 'type_alias_declaration', 'enum_declaration'])
export const collectExportCandidates = (
  node: SyntaxNode,
  enclosingSymbol: string | null,
  moduleKey: string,
  moduleExports: ModuleExportCandidate[],
  references: ReferenceCandidate[],
  visit: (child: SyntaxNode, childEnclosingSymbol: string | null) => void,
): void => {
  const sourceSpecifier = normalizeSpecifier(node.childForFieldName('source'))
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index)
    if (child === null) continue
    if (child.type === 'function_declaration' || child.type === 'function_expression') {
      handleFunctionExportChild(node, child, enclosingSymbol, moduleKey, moduleExports, visit)
      continue
    }
    if (child.type === 'class_declaration' || child.type === 'abstract_class_declaration' || child.type === 'class') {
      handleFunctionExportChild(node, child, enclosingSymbol, moduleKey, moduleExports, visit)
      continue
    }
    if (NAMED_TYPE_EXPORT_KINDS.has(child.type)) {
      pushNamedExportCandidate(node, child, moduleExports)
      visit(child, enclosingSymbol)
      continue
    }
    if (child.type === 'lexical_declaration') {
      pushLexicalExportCandidates(node, child, moduleExports)
      visit(child, enclosingSymbol)
      continue
    }
    if (child.type === 'export_specifier') {
      pushExportSpecifier(child, sourceSpecifier, moduleExports, references)
      continue
    }
    if (child.type === 'export_clause') {
      collectExportClauseSpecifiers(child, sourceSpecifier, moduleExports, references)
      continue
    }
    visit(child, enclosingSymbol)
  }
}
