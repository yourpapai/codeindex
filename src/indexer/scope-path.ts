import type { Node as SyntaxNode } from 'web-tree-sitter'

// A boundary is a node that OWNS a symbol row (see extract-symbols' declarationTypes). A named
// function expression used as a bare callback (`register(function inner(){})`) is deliberately NOT
// included: extract-symbols emits no symbol for it, so treating it as a boundary here would attribute
// references to a phantom `outer>inner` source that no symbol backs. Such references belong to the
// nearest REAL enclosing symbol. Function/arrow expressions bound to a variable declarator ARE
// boundaries — the declarator itself is the symbol row.
export const isNamedScopeBoundary = (node: SyntaxNode): boolean =>
  node.type === 'function_declaration' ||
  node.type === 'class_declaration' ||
  node.type === 'abstract_class_declaration' ||
  node.type === 'method_definition' ||
  (node.type === 'variable_declarator' &&
    (node.childForFieldName('value')?.type === 'arrow_function' ||
      node.childForFieldName('value')?.type === 'function_expression'))

// A non-boundary variable_declarator still owns a path segment in extract-symbols' qualified names
// (`const stream = new ReadableStream({ start(){…} })` → `…>stream>start`). Its name rides as a
// PENDING segment: it joins the path only when a nested boundary is minted beneath it, so plain
// `const body = f()` stays transparent (the Slice 4a indexer/oracle agreement) and a direct
// reference in the initializer attributes to the enclosing symbol, not the declarator.
export const pendingSegmentsFor = (node: SyntaxNode, pending: readonly string[]): readonly string[] => {
  if (node.type !== 'variable_declarator') return pending
  const name = node.childForFieldName('name')?.text
  return name === undefined ? pending : [...pending, name]
}

// Mint a boundary's qualified name from the enclosing path, the pending declarator segments threaded
// through non-boundary declarators, and the boundary's own name.
export const nextEnclosingSymbol = (
  moduleKey: string,
  node: SyntaxNode,
  enclosingSymbol: string | null,
  pending: readonly string[],
): string | null => {
  const functionName = node.childForFieldName('name')?.text
  if (functionName === undefined) return enclosingSymbol
  const path = pending.length === 0 ? functionName : `${pending.join('>')}>${functionName}`
  return enclosingSymbol === null ? `${moduleKey}#${path}` : `${enclosingSymbol}>${path}`
}
