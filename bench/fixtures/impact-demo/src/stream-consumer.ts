import { streamCalled } from './stream'

export function handleEvents(): unknown {
  const stream = new ReadableStream({
    start(): void {
      streamCalled()
    },
    cancel(): void {
      streamCalled()
    },
  })
  return stream
}
