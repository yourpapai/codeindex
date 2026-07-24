// member (B2, resolved via this.m()): a scored method referenced through `this`.
export class Panel {
  helper(): number {
    return 1
  }
  render(): number {
    return this.helper()
  }
}
