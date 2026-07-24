// member (B2, missed): a scored method referenced via `this`.
export class Panel {
  helper(): number {
    return 1
  }
  render(): number {
    return this.helper()
  }
}
