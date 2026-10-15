// Controlled external clock for deterministic worker API fixtures.
export function testClock() {
  let elapsed = 0
  return {
    leaseMs: 1000000000,
    now: () => Date.now() + elapsed,
    wait: async (milliseconds: number, signal: AbortSignal) => {
      signal.throwIfAborted()
      elapsed += milliseconds
    },
  }
}
