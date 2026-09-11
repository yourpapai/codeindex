import { Button } from './button'
import { alpha } from './colors'
import { Helper as HelperA } from './helper-a'
import { Helper as HelperB } from './helper-b'
import { Toast } from './toast'

export function useAlpha(): number {
  return alpha
}

export function useHelpers(): string {
  return HelperA() + HelperB()
}

export function useUi(): string {
  return new Toast().Action() + new Button().Action()
}
