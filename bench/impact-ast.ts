import ts from 'typescript'

import type { Shape } from './impact-types.js'

// The pure, DB-free syntactic layer of the reference oracle: given a SourceFile and a byte offset,
// locate the token and classify it. Extracted from impact-oracle.ts so each file stays focused (and
// under the max-lines cap) — impact-oracle.ts owns the DB-attribution + program-driving half.

// Descend to the innermost node whose span contains `pos` (the reference identifier token).
export const nodeAtPosition = (sf: ts.SourceFile, pos: number): ts.Node => {
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

// B7 relabel: type-position refs used to fall through classifyShape's value-form checks to
// 'bare-value' (the Slice 6 Unit 0 memo's labeling caveat). With the type-ref edge landed, the
// type tier reports as 'named-type'. Heritage keeps its own label (classifyShape returns it for
// any HeritageClause ancestor, including type-position implements / interface extends).
// Diagnostic-only — shape maps size coverage; no gate reads them.
export const shapeLabelForPosition = (position: 'value' | 'type', shape: Shape): Shape =>
  position === 'type' && shape !== 'heritage' ? 'named-type' : shape
