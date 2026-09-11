// Unique among exports, but a class member shares the bare name `alpha`.
export const alpha = 1

export class Theme {
  alpha(): number {
    return 2
  }
}
