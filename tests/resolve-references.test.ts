import { describe, expect, test } from 'bun:test'

import { resolveReferenceCandidates } from '../src/resolver/resolve-references.js'

describe('resolveReferenceCandidates', () => {
  test('prefers exact module export matches over name-only fallback', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        {
          id: 1,
          qualifiedName: 'src/helper#helper',
          localName: 'helper',
          moduleKey: 'src/helper',
          exportNames: ['helper'],
        },
      ],
      moduleAliases: [{ aliasKey: 'src/helper', fileId: 10 }],
      files: [{ id: 10, moduleKey: 'src/helper' }],
      references: [
        {
          sourceQualifiedName: 'src/run-task#runTask',
          edgeType: 'imports',
          targetName: 'helper',
          targetExportName: 'helper',
          targetModuleSpecifier: './helper',
          lineNumber: 1,
        },
        {
          sourceQualifiedName: 'src/run-task#runTask',
          edgeType: 'calls',
          targetName: 'helper',
          targetExportName: null,
          targetModuleSpecifier: null,
          lineNumber: 3,
        },
      ],
      currentModuleKey: 'src/run-task',
    })

    expect(resolved).toEqual([
      expect.objectContaining({ edgeType: 'imports', targetSymbolId: 1, confidence: 'resolved' }),
      expect.objectContaining({ edgeType: 'calls', targetSymbolId: 1, confidence: 'resolved' }),
    ])
  })

  test('bridges a barrel re-export: import from a barrel then call resolves to the real symbol (B4)', () => {
    // src/commands/dashboard declares registerDashboardCommand; src/commands/index barrels it
    // (`export { registerDashboardCommand } from './dashboard'`); src/bot imports from the barrel
    // and calls it. Without re-export bridging the import dead-ends at the barrel file (file_resolved,
    // null symbol) and the call stays name_only.
    const resolved = resolveReferenceCandidates({
      symbols: [
        {
          id: 1,
          qualifiedName: 'src/commands/dashboard#registerDashboardCommand',
          localName: 'registerDashboardCommand',
          moduleKey: 'src/commands/dashboard',
          exportNames: ['registerDashboardCommand'],
        },
      ],
      moduleAliases: [],
      files: [
        { id: 10, moduleKey: 'src/commands/dashboard' },
        { id: 20, moduleKey: 'src/commands/index' },
      ],
      moduleExports: [
        {
          moduleKey: 'src/commands/dashboard',
          exportName: 'registerDashboardCommand',
          symbolId: 1,
          targetModuleSpecifier: null,
        },
        {
          moduleKey: 'src/commands/index',
          exportName: 'registerDashboardCommand',
          symbolId: null,
          targetModuleSpecifier: './dashboard',
        },
      ],
      references: [
        {
          sourceQualifiedName: 'src/bot#registerCommands',
          edgeType: 'imports',
          targetName: 'registerDashboardCommand',
          targetExportName: 'registerDashboardCommand',
          targetModuleSpecifier: './commands/index',
          lineNumber: 1,
        },
        {
          sourceQualifiedName: 'src/bot#registerCommands',
          edgeType: 'calls',
          targetName: 'registerDashboardCommand',
          targetExportName: null,
          targetModuleSpecifier: null,
          lineNumber: 5,
        },
      ],
      currentModuleKey: 'src/bot',
    })

    expect(resolved).toEqual([
      expect.objectContaining({ edgeType: 'imports', targetSymbolId: 1, confidence: 'resolved' }),
      expect.objectContaining({ edgeType: 'calls', targetSymbolId: 1, confidence: 'resolved' }),
    ])
  })

  test('a dead-end bare re-export (`export { x }` of a non-local binding) does not bridge or mis-resolve', () => {
    // src/support does `export { logProcessMessage }` (no `from`) — a re-export of an imported
    // binding, which records symbolId null + specifier null. The chain must dead-end (null), not
    // fabricate a wrong target. (This is papai's #7, the import-then-export form B4 defers.)
    const resolved = resolveReferenceCandidates({
      symbols: [
        {
          id: 2,
          qualifiedName: 'src/logging#logProcessMessage',
          localName: 'logProcessMessage',
          moduleKey: 'src/logging',
          exportNames: ['logProcessMessage'],
        },
      ],
      moduleAliases: [],
      files: [
        { id: 30, moduleKey: 'src/support' },
        { id: 40, moduleKey: 'src/logging' },
      ],
      moduleExports: [
        { moduleKey: 'src/support', exportName: 'logProcessMessage', symbolId: null, targetModuleSpecifier: null },
      ],
      references: [
        {
          sourceQualifiedName: 'src/orchestrator#processMessage',
          edgeType: 'imports',
          targetName: 'logProcessMessage',
          targetExportName: 'logProcessMessage',
          targetModuleSpecifier: './support',
          lineNumber: 1,
        },
      ],
      currentModuleKey: 'src/orchestrator',
    })

    // Import lands on the barrel file but finds no forwarding symbol → file_resolved, not resolved.
    expect(resolved).toEqual([
      expect.objectContaining({ edgeType: 'imports', targetSymbolId: null, confidence: 'file_resolved' }),
    ])
  })
})
