// Controlled external clock for deterministic worker API fixtures. Without an
// epoch, Date.now stays observable so fake-timer lease tests retain control.
export function testClock(epoch?: number) {
  let elapsed = 0
  const advance = (milliseconds: number) => {
    elapsed += milliseconds
  }
  return {
    leaseMs: 1000000000,
    now: () => (epoch ?? Date.now()) + elapsed,
    advance,
    wait: async (milliseconds: number, signal: AbortSignal) => {
      signal.throwIfAborted()
      advance(milliseconds)
    },
  }
}
