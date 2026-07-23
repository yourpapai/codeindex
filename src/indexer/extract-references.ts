import type { Node as SyntaxNode, Tree } from 'web-tree-sitter'

import {
  collectExportCandidates,
  normalizeSpecifier,
  type ModuleExportCandidate,
  type ReferenceCandidate,
} from './collect-export-candidates.js'

export type { ModuleExportCandidate, ReferenceCandidate }

export interface ExtractReferenceCandidatesInput {
  readonly source: string
  readonly tree: Tree
  readonly relativeFilePath: string
  readonly moduleKey: string
}

export interface ExtractReferenceCandidatesResult {
  readonly moduleExports: readonly ModuleExportCandidate[]
  readonly references: readonly ReferenceCandidate[]
}

const visitChildren = (
  node: SyntaxNode,
  enclosingSymbol: string | null,
  visit: (child: SyntaxNode, childEnclosingSymbol: string | null) => void,
): void => {
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index)
    if (child !== null) visit(child, enclosingSymbol)
  }
}

const nextEnclosingSymbol = (moduleKey: string, node: SyntaxNode, enclosingSymbol: string | null): string | null => {
  const functionName = node.childForFieldName('name')?.text
  if (functionName === undefined) return enclosingSymbol
  return enclosingSymbol === null ? `${moduleKey}#${functionName}` : `${enclosingSymbol}>${functionName}`
}

const isNamedScopeBoundary = (node: SyntaxNode): boolean =>
  node.type === 'function_declaration' ||
  (node.type === 'function_expression' && node.parent?.type !== 'variable_declarator') ||
  node.type === 'class_declaration' ||
  node.type === 'abstract_class_declaration' ||
  node.type === 'method_definition' ||
  (node.type === 'variable_declarator' &&
    (node.childForFieldName('value')?.type === 'arrow_function' ||
      node.childForFieldName('value')?.type === 'function_expression'))

const collectImportReference = (node: SyntaxNode, references: ReferenceCandidate[]): void => {
  const exportedName = node.childForFieldName('name')?.text ?? node.text
  const localName = node.childForFieldName('alias')?.text ?? exportedName
  const importStatement = node.parent?.parent?.parent
  references.push({
    sourceQualifiedName: null,
    edgeType: 'imports',
    targetName: localName,
    targetExportName: exportedName,
    targetModuleSpecifier: normalizeSpecifier(importStatement?.childForFieldName('source')),
    lineNumber: node.startPosition.row + 1,
  })
}

const collectCallReference = (
  node: SyntaxNode,
  enclosingSymbol: string | null,
  references: ReferenceCandidate[],
): void => {
  const functionNode = node.childForFieldName('function')
  references.push({
    sourceQualifiedName: enclosingSymbol,
    edgeType: 'calls',
    targetName: functionNode?.text ?? node.text,
    targetExportName: null,
    targetModuleSpecifier: null,
    lineNumber: node.startPosition.row + 1,
  })
}

const collectJsxReference = (
  node: SyntaxNode,
  enclosingSymbol: string | null,
  references: ReferenceCandidate[],
): void => {
  const nameNode = node.childForFieldName('name')
  // Only bare, capitalized identifiers are component references: lowercase tags are intrinsic
  // host elements (<div>); member-expression tags (<Foo.Bar/>) are the namespace case, deferred with B5.
  if (nameNode === null || nameNode.type !== 'identifier') return
  const tag = nameNode.text
  const first = tag.charAt(0)
  if (first === '' || first !== first.toUpperCase()) return
  references.push({
    sourceQualifiedName: enclosingSymbol,
    edgeType: 'references',
    targetName: tag,
    targetExportName: null,
    targetModuleSpecifier: null,
    lineNumber: node.startPosition.row + 1,
  })
}

export const extractReferenceCandidates = (
  input: Readonly<ExtractReferenceCandidatesInput>,
): ExtractReferenceCandidatesResult => {
  const moduleExports: ModuleExportCandidate[] = []
  const references: ReferenceCandidate[] = []
  const visit = (node: SyntaxNode, enclosingSymbol: string | null): void => {
    if (node.type === 'export_statement') {
      collectExportCandidates(node, enclosingSymbol, input.moduleKey, moduleExports, references, visit)
      return
    }
    if (node.type === 'import_specifier') collectImportReference(node, references)
    if (node.type === 'identifier' && node.parent?.type === 'import_clause') {
      const importStatement = node.parent.parent
      references.push({
        sourceQualifiedName: null,
        edgeType: 'imports',
        targetName: node.text,
        targetExportName: 'default',
        targetModuleSpecifier: normalizeSpecifier(importStatement?.childForFieldName('source')),
        lineNumber: node.startPosition.row + 1,
      })
    }
    if (isNamedScopeBoundary(node)) {
      visitChildren(node, nextEnclosingSymbol(input.moduleKey, node, enclosingSymbol), visit)
      return
    }
    if (node.type === 'call_expression') collectCallReference(node, enclosingSymbol, references)
    if (node.type === 'jsx_opening_element' || node.type === 'jsx_self_closing_element') {
      collectJsxReference(node, enclosingSymbol, references)
    }
    visitChildren(node, enclosingSymbol, visit)
  }

  visit(input.tree.rootNode, null)
  return { moduleExports, references }
}
