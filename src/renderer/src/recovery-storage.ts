// Storage holds reconnectable identity and user selection, never job progress.
export function readRecovery(key: string): unknown {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return value
  } catch {
    return null
  }
}

export function saveRecovery(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Worker-owned durable state remains available through the active queue.
  }
}

export function recoveryIds(key: string): string[] {
  const value = readRecovery(key)
  return Array.isArray(value)
    ? value.filter(
        (id): id is string =>
          typeof id === 'string' && id.length <= 200 && id.length > 0,
      )
    : []
}
