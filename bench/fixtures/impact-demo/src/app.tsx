import { bareUsed } from './bare'
import { Base, Iface } from './base'
import { Button } from './button'
import * as ns from './ns-target'
import { plainCalled } from './plain'

// jsx (B1, resolved) + call (resolved) + namespace (B5, missed) + bare-value (missed).
export function Screen(): unknown {
  const g = bareUsed
  return [<Button />, plainCalled(), ns.nsCalled(), g]
}

// heritage `extends` (B3, resolved value) + `implements` (type — B7 diagnostic).
export class Widget extends Base implements Iface {
  readonly id = 1
}
