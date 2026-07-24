import { describe, expect, test } from 'bun:test'

import { extractReferenceCandidates } from '../../src/indexer/extract-references.js'
import { createParserLoader } from '../../src/indexer/parser.js'

describe('extractReferenceCandidates', () => {
  test('captures imports, reexports, and call references', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = [
      "import { helper } from './helper.js'",
      "export { helper as publicHelper } from './helper.js'",
      'export function runTask() {',
      '  return helper()',
      '}',
    ].join('\n')

    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const result = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/run-task.ts',
      moduleKey: 'src/run-task',
    })

    expect(result.moduleExports).toEqual([
      {
        exportName: 'publicHelper',
        exportKind: 'reexport',
        localName: 'helper',
        targetModuleSpecifier: './helper.js',
      },
      {
        exportName: 'runTask',
        exportKind: 'named',
        localName: 'runTask',
        targetModuleSpecifier: null,
      },
    ])

    const importHelper = result.references.filter((ref) => ref.edgeType === 'imports').at(0)
    expect(importHelper).toBeDefined()
    expect(importHelper!.targetName).toBe('helper')
    expect(importHelper!.targetModuleSpecifier).toBe('./helper.js')

    const callHelper = result.references.filter((ref) => ref.edgeType === 'calls').at(0)
    expect(callHelper).toBeDefined()
    expect(callHelper!.targetName).toBe('helper')
  })

  test('aliased named import uses alias as targetName and original as targetExportName', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = [
      "import { helper as localHelper } from './helper.js'",
      'export function runTask() {',
      '  return localHelper()',
      '}',
    ].join('\n')

    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const result = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/run-task.ts',
      moduleKey: 'src/run-task',
    })

    const importRef = result.references.filter((ref) => ref.edgeType === 'imports').at(0)
    expect(importRef).toBeDefined()
    expect(importRef!.targetName).toBe('localHelper')
    expect(importRef!.targetExportName).toBe('helper')
    expect(importRef!.targetModuleSpecifier).toBe('./helper.js')

    const callRef = result.references.filter((ref) => ref.edgeType === 'calls').at(0)
    expect(callRef).toBeDefined()
    expect(callRef!.targetName).toBe('localHelper')
  })

  test('export default function records exportName "default" and exportKind "default"', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = 'export default function helper() { return 1 }'

    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { moduleExports } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/helper.ts',
      moduleKey: 'src/helper',
    })

    expect(moduleExports).toEqual([
      {
        exportName: 'default',
        exportKind: 'default',
        localName: 'helper',
        targetModuleSpecifier: null,
      },
    ])
  })

  test('anonymous default export function records exportName "default" with localName null', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = 'export default function() { return 1 }'

    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { moduleExports } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/handler.ts',
      moduleKey: 'src/handler',
    })

    expect(moduleExports).toEqual([
      {
        exportName: 'default',
        exportKind: 'default',
        localName: null,
        targetModuleSpecifier: null,
      },
    ])
  })

  test('default import records an import edge with targetExportName "default"', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = ["import helper from './helper.js'", 'export function runTask() {', '  return helper()', '}'].join(
      '\n',
    )

    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/run-task.ts',
      moduleKey: 'src/run-task',
    })

    const importRef = references.filter((ref) => ref.edgeType === 'imports').at(0)
    expect(importRef).toBeDefined()
    expect(importRef!.targetName).toBe('helper')
    expect(importRef!.targetExportName).toBe('default')
    expect(importRef!.targetModuleSpecifier).toBe('./helper.js')
  })

  test('export class, abstract class, const, interface, type, and enum emit module export candidates', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = [
      'export class Greeter {}',
      'export abstract class Base {}',
      'export const MAX = 100',
      'export interface Config { timeout: number }',
      'export type ID = string',
      'export enum Direction { Up, Down }',
    ].join('\n')

    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { moduleExports } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/types.ts',
      moduleKey: 'src/types',
    })

    expect(moduleExports).toEqual([
      { exportName: 'Greeter', exportKind: 'named', localName: 'Greeter', targetModuleSpecifier: null },
      { exportName: 'Base', exportKind: 'named', localName: 'Base', targetModuleSpecifier: null },
      { exportName: 'MAX', exportKind: 'named', localName: 'MAX', targetModuleSpecifier: null },
      { exportName: 'Config', exportKind: 'named', localName: 'Config', targetModuleSpecifier: null },
      { exportName: 'ID', exportKind: 'named', localName: 'ID', targetModuleSpecifier: null },
      { exportName: 'Direction', exportKind: 'named', localName: 'Direction', targetModuleSpecifier: null },
    ])
  })

  test('export default class records exportName "default"', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')

    const tree = parsed.parser.parse('export default class Handler {}')
    expect(tree).not.toBeNull()

    const { moduleExports } = extractReferenceCandidates({
      source: 'export default class Handler {}',
      tree: tree!,
      relativeFilePath: 'src/handler.ts',
      moduleKey: 'src/handler',
    })

    expect(moduleExports).toEqual([
      { exportName: 'default', exportKind: 'default', localName: 'Handler', targetModuleSpecifier: null },
    ])
  })

  test('export default anonymous class records exportName "default" with localName null', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')

    const tree = parsed.parser.parse('export default class {}')
    expect(tree).not.toBeNull()

    const { moduleExports } = extractReferenceCandidates({
      source: 'export default class {}',
      tree: tree!,
      relativeFilePath: 'src/handler.ts',
      moduleKey: 'src/handler',
    })

    expect(moduleExports).toEqual([
      { exportName: 'default', exportKind: 'default', localName: null, targetModuleSpecifier: null },
    ])
  })

  test('calls inside class methods are attributed to the member qualified name', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = [
      'export class Service {',
      '  run() {',
      '    return helper()',
      '  }',
      '}',
      'function helper() { return 1 }',
    ].join('\n')

    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/service.ts',
      moduleKey: 'src/service',
    })

    const callRef = references.filter((ref) => ref.edgeType === 'calls').at(0)
    expect(callRef).toBeDefined()
    expect(callRef!.targetName).toBe('helper')
    expect(callRef!.sourceQualifiedName).toBe('src/service#Service>run')
  })

  test('calls inside abstract class methods are attributed to the member qualified name', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = [
      'export abstract class Base {',
      '  process() {',
      '    return helper()',
      '  }',
      '}',
      'function helper() { return 1 }',
    ].join('\n')

    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/base.ts',
      moduleKey: 'src/base',
    })

    const callRef = references.filter((ref) => ref.edgeType === 'calls').at(0)
    expect(callRef).toBeDefined()
    expect(callRef!.targetName).toBe('helper')
    expect(callRef!.sourceQualifiedName).toBe('src/base#Base>process')
  })

  test('calls inside anonymous default-exported class methods are attributed to the member qualified name', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = [
      'export default class {',
      '  run() {',
      '    return helper()',
      '  }',
      '}',
      'function helper() { return 1 }',
    ].join('\n')

    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/test.ts',
      moduleKey: 'src/test',
    })

    const callRef = references.filter((ref) => ref.edgeType === 'calls').at(0)
    expect(callRef).toBeDefined()
    expect(callRef!.targetName).toBe('helper')
    expect(callRef!.sourceQualifiedName).toBe('src/test#default>run')
  })

  test('calls inside arrow-function const are attributed to the owning symbol', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = ['export const run = () => {', '  return helper()', '}', 'function helper() { return 1 }'].join('\n')

    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/run.ts',
      moduleKey: 'src/run',
    })

    const callRef = references.filter((ref) => ref.edgeType === 'calls').at(0)
    expect(callRef).toBeDefined()
    expect(callRef!.targetName).toBe('helper')
    expect(callRef!.sourceQualifiedName).toBe('src/run#run')
  })

  test('calls inside function-expression const are attributed to the owning symbol', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = ['export const run = function() {', '  return helper()', '}', 'function helper() { return 1 }'].join(
      '\n',
    )

    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/run.ts',
      moduleKey: 'src/run',
    })

    const callRef = references.filter((ref) => ref.edgeType === 'calls').at(0)
    expect(callRef).toBeDefined()
    expect(callRef!.targetName).toBe('helper')
    expect(callRef!.sourceQualifiedName).toBe('src/run#run')
  })

  test('calls inside named function-expression const are attributed to the owning symbol', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = [
      'export const run = function inner() {',
      '  return helper()',
      '}',
      'function helper() { return 1 }',
    ].join('\n')

    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/run.ts',
      moduleKey: 'src/run',
    })

    const callRef = references.filter((ref) => ref.edgeType === 'calls').at(0)
    expect(callRef).toBeDefined()
    expect(callRef!.targetName).toBe('helper')
    expect(callRef!.sourceQualifiedName).toBe('src/run#run')
  })

  test('re-export without a matching import records a reference to the source module', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = ["export { foo } from './foo.js'", "export { bar as baz } from './bar.js'"].join('\n')

    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const result = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/index.ts',
      moduleKey: 'src/index',
    })

    const reexports = result.references.filter((ref) => ref.edgeType === 'reexports')
    expect(reexports).toHaveLength(2)
    expect(reexports[0]!.targetName).toBe('foo')
    expect(reexports[0]!.targetModuleSpecifier).toBe('./foo.js')
    expect(reexports[1]!.targetName).toBe('bar')
    expect(reexports[1]!.targetModuleSpecifier).toBe('./bar.js')
  })

  test('captures capitalized JSX tags as reference edges; skips intrinsic and member tags', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.tsx')
    const source = [
      "import { Button } from './button.js'",
      'export function App() {',
      '  return <div><Button /><Panel>hi</Panel></div>',
      '}',
    ].join('\n')
    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()
    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/app.tsx',
      moduleKey: 'src/app',
    })
    const jsx = references.filter((ref) => ref.edgeType === 'references')
    const names = jsx.map((ref) => ref.targetName)
    expect(names).toContain('Button')
    // closing tag must NOT double-count
    expect(names).toContain('Panel')
    expect(names.filter((n) => n === 'Panel')).toHaveLength(1)
    expect(names).not.toContain('div')
    expect(jsx.find((ref) => ref.targetName === 'Button')!.sourceQualifiedName).toBe('src/app#App')
  })

  test('skips member-expression JSX tags (namespace case, deferred to B5)', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.tsx')
    const source = ["import * as UI from './ui.js'", 'export function App() {', '  return <UI.Panel />', '}'].join('\n')
    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()
    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/app.tsx',
      moduleKey: 'src/app',
    })
    expect(references.filter((ref) => ref.edgeType === 'references')).toHaveLength(0)
  })

  test('captures class extends and implements as heritage edges', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = [
      "import { Base } from './base.js'",
      "import { Left, Right } from './ifaces.js'",
      'export class Widget extends Base implements Left, Right {}',
    ].join('\n')
    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()
    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/widget.ts',
      moduleKey: 'src/widget',
    })
    const ext = references.filter((ref) => ref.edgeType === 'extends')
    expect(ext).toHaveLength(1)
    expect(ext[0]!.targetName).toBe('Base')
    expect(ext[0]!.sourceQualifiedName).toBe('src/widget#Widget')
    const impl = references.filter((ref) => ref.edgeType === 'implements')
    expect(impl.map((ref) => ref.targetName)).toEqual(['Left', 'Right'])
    expect(impl[0]!.sourceQualifiedName).toBe('src/widget#Widget')
  })

  test('this.m() emits a calls reference to the bare method name with a this receiver', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = [
      'export class C {',
      '  foo(): number { return this.bar() }',
      '  bar(): number { return 1 }',
      '}',
    ].join('\n')
    const tree = parsed.parser.parse(source)
    const result = extractReferenceCandidates({ source, tree: tree!, relativeFilePath: 'src/c.ts', moduleKey: 'src/c' })

    const thisCall = result.references.filter((r) => r.edgeType === 'calls').find((r) => r.targetName === 'bar')
    expect(thisCall).toBeDefined()
    expect(thisCall!.receiver).toBe('this')
    expect(thisCall!.sourceQualifiedName).toBe('src/c#C>foo')
  })

  test('obj.m() is left as a whole-member-expression targetName with no receiver (deferred)', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = ['export function run(obj: { baz(): number }): number {', '  return obj.baz()', '}'].join('\n')
    const tree = parsed.parser.parse(source)
    const result = extractReferenceCandidates({ source, tree: tree!, relativeFilePath: 'src/r.ts', moduleKey: 'src/r' })

    const objCall = result.references.find((r) => r.edgeType === 'calls')
    expect(objCall!.targetName).toBe('obj.baz')
    expect(objCall!.receiver).toBeUndefined()
  })
})
