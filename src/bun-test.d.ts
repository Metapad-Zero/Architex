declare module 'bun:test' {
  interface Matcher<T = unknown> {
    toBe(expected: T): void
    toEqual(expected: unknown): void
    toBeDefined(): void
    toBeGreaterThan(expected: number | bigint): void
    toBeLessThan(expected: number | bigint): void
    toThrow(expected?: string | RegExp): void
  }

  export function describe(name: string, callback: () => void): void
  export function beforeEach(callback: () => void | Promise<void>): void
  export function test(name: string, callback: () => void | Promise<void>): void
  export function expect<T>(value: T): Matcher<T>
}
