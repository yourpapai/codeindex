import { Button } from './button'
import { Base, Iface } from './base'
import { plainCalled } from './plain'
import { bareUsed } from './bare'
import * as ns from './ns-target'

// jsx (B1, resolved) + call (resolved) + namespace (B5, missed) + bare-value (missed).
export function Screen(): unknown {
  const g = bareUsed
  return [<Button />, plainCalled(), ns.nsCalled(), g]
}

// heritage `extends` (B3, resolved value) + `implements` (type — B7 diagnostic).
export class Widget extends Base implements Iface {
  readonly id = 1
}

// member (B2, missed): a scored method referenced via `this`.
export class Panel {
  helper(): number {
    return 1
  }
  render(): number {
    return this.helper()
  }
}
