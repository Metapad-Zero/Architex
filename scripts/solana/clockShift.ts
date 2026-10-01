/**
 * Builds and describes the Solana clock fixture: see `scripts/solana/clockShift.c` for why a
 * validator's clock can only be moved from underneath it.
 *
 * The library is compiled on demand rather than committed, because a dylib in the tree is a binary
 * nobody reviews. If it cannot be built — no clang, not macOS, a `DYLD_INSERT_LIBRARIES` the loader
 * refuses — `prepareClockShift` says so in words and the caller records the step as not executed
 * instead of failing. A fixture that silently did nothing would be worse than an absent one: the
 * release would be attempted against an unadvanced clock and refused, and the refusal would look
 * like a finding.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../..')
const SOURCE = join(ROOT, 'scripts/solana/clockShift.c')

export type ClockShift =
  | { available: true; library: string; label: string }
  | { available: false; why: string }

/** Compiles the interposer into `output/equilibrium`, reusing it when it is newer than its source. */
export function prepareClockShift(): ClockShift {
  if (process.platform !== 'darwin') {
    return { available: false, why: `the clock fixture interposes DYLD_INSERT_LIBRARIES, which exists only on macOS; this host is ${process.platform}` }
  }
  const out = join(ROOT, 'output/equilibrium')
  const library = join(out, 'clockShift.dylib')
  try {
    mkdirSync(out, { recursive: true })
    if (!existsSync(library) || statSync(library).mtimeMs < statSync(SOURCE).mtimeMs) {
      execFileSync('clang', ['-dynamiclib', '-O2', '-Wall', '-Werror', '-o', library, SOURCE], { stdio: 'pipe' })
    }
  } catch (error) {
    return { available: false, why: `could not build the clock interposer: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` }
  }
  return {
    available: true,
    library,
    label: 'scripts/solana/clockShift.c, loaded into the validator with DYLD_INSERT_LIBRARIES and offsetting CLOCK_REALTIME only',
  }
}

/**
 * The environment a validator is started with to believe it is `seconds` later than it is.
 *
 * Returned as a fresh object rather than mutating `process.env`, so the offset reaches exactly the
 * one child it is meant for; a harness whose own clock moved would mis-stamp every record it wrote.
 */
export function clockShiftEnvironment(shift: ClockShift, seconds: number): Record<string, string> {
  if (!shift.available) throw new Error(`The clock fixture is unavailable: ${shift.why}`)
  if (!Number.isInteger(seconds) || seconds < 0) throw new Error(`A clock offset must be a whole number of seconds, not ${seconds}.`)
  return { DYLD_INSERT_LIBRARIES: shift.library, CLOCK_SHIFT_SECONDS: String(seconds) }
}
