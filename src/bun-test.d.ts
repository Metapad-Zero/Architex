declare module 'bun:test' {
  interface Matcher<T = unknown> {
    not: Matcher<T>
    toBe(expected: T): void
    toEqual(expected: unknown): void
    toBeDefined(): void
    toBeNull(): void
    toBeGreaterThan(expected: number | bigint): void
    toBeLessThan(expected: number | bigint): void
    toContain(expected: unknown): void
    toHaveLength(expected: number): void
    toThrow(expected?: string | RegExp): void
    rejects: { toThrow(expected?: string | RegExp): Promise<void> }
  }

  export function describe(name: string, callback: () => void): void
  export function beforeEach(callback: () => void | Promise<void>): void
  export function afterEach(callback: () => void | Promise<void>): void
  export function test(name: string, callback: () => void | Promise<void>): void
  export function expect<T>(value: T): Matcher<T>
}
