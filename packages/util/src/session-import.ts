/**
 * Splits an imported transcript into request-sized batches.
 *
 * A single 4,000-message session is tens of megabytes of JSON, and sending it as
 * one request can exceed a proxy or server body limit and lose the entire import.
 * Batches keep each request comfortably below common limits; a single oversized
 * message still travels alone rather than being dropped.
 */
export function batches<T>(
  messages: ReadonlyArray<T>,
  options: { readonly maxMessages?: number; readonly maxBytes?: number } = {},
): Array<ReadonlyArray<T>> {
  const maxMessages = options.maxMessages ?? 250
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  const encoder = new TextEncoder()
  const result: Array<ReadonlyArray<T>> = []
  let batch: T[] = []
  let bytes = 0

  for (const message of messages) {
    const size = encoder.encode(JSON.stringify(message)).length + 1
    if (batch.length > 0 && (batch.length >= maxMessages || bytes + size > maxBytes)) {
      result.push(batch)
      batch = []
      bytes = 0
    }
    batch.push(message)
    bytes += size
  }
  if (batch.length > 0) result.push(batch)
  return result
}
