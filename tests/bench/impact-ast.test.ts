import { describe, expect, test } from 'bun:test'

import { shapeLabelForPosition } from '../../bench/impact-ast.js'

describe('shapeLabelForPosition', () => {
  test('type-position refs report as named-type (B7 relabel)', () => {
    expect(shapeLabelForPosition('type', 'bare-value')).toBe('named-type')
    expect(shapeLabelForPosition('type', 'call')).toBe('named-type')
  })

  test('value-position refs keep their classified shape', () => {
    expect(shapeLabelForPosition('value', 'bare-value')).toBe('bare-value')
    expect(shapeLabelForPosition('value', 'call')).toBe('call')
    expect(shapeLabelForPosition('value', 'heritage')).toBe('heritage')
  })

  test('type-position heritage keeps the heritage label (implements / interface extends)', () => {
    expect(shapeLabelForPosition('type', 'heritage')).toBe('heritage')
  })
})
