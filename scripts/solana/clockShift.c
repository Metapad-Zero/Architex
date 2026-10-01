/*
 * CLOCK FIXTURE for the Arc–Solana rehearsal's Solana half.
 *
 * The pinned NTT manager compares a queued transfer's stored release timestamp against the Clock
 * sysvar, and hard-codes RATE_LIMIT_DURATION at 24 hours. Agave's Clock is driven by the
 * stake-weighted vote timestamps and clamped to 150% of elapsed PoH, so it cannot be warped from
 * outside and `--warp-slot` panics in solana-test-validator 2.1.22. What a validator's clock *is*
 * derived from, ultimately, is CLOCK_REALTIME in its own process: the genesis creation time, the
 * epoch start timestamp and every vote timestamp. Offsetting that one source, consistently, for one
 * process, moves the whole chain's notion of now without touching a single account.
 *
 * Only CLOCK_REALTIME is offset. CLOCK_MONOTONIC and mach_absolute_time are left alone, so PoH
 * pacing, timeouts and the validator's own scheduling run at real speed; the only thing that moves
 * is the wall-clock date the validator believes it is.
 *
 * Built on demand by scripts/solana/clockShift.ts into output/equilibrium/, loaded with
 * DYLD_INSERT_LIBRARIES, and driven by CLOCK_SHIFT_SECONDS. Absent that variable it is a no-op, so
 * a validator started with the library but without the offset keeps real time.
 */
#include <stdlib.h>
#include <sys/time.h>
#include <time.h>

#define DYLD_INTERPOSE(_replacement, _replacee) \
  __attribute__((used)) static struct { const void *replacement; const void *replacee; } \
  _interpose_##_replacee __attribute__((section("__DATA,__interpose"))) = \
  { (const void *)(unsigned long)&_replacement, (const void *)(unsigned long)&_replacee };

/* Read once: getenv is not safe to call repeatedly from the threads that ask for the time. */
static long offset_seconds(void) {
  static long cached = 0;
  static int loaded = 0;
  if (!loaded) {
    const char *configured = getenv("CLOCK_SHIFT_SECONDS");
    cached = configured ? atol(configured) : 0;
    loaded = 1;
  }
  return cached;
}

static int shifted_gettimeofday(struct timeval *tp, void *tzp) {
  int result = gettimeofday(tp, tzp);
  if (result == 0 && tp != NULL) tp->tv_sec += offset_seconds();
  return result;
}

static int shifted_clock_gettime(clockid_t id, struct timespec *ts) {
  int result = clock_gettime(id, ts);
  if (result == 0 && ts != NULL && id == CLOCK_REALTIME) ts->tv_sec += offset_seconds();
  return result;
}

static __uint64_t shifted_clock_gettime_nsec_np(clockid_t id) {
  __uint64_t result = clock_gettime_nsec_np(id);
  if (result != 0 && id == CLOCK_REALTIME) result += (__uint64_t)offset_seconds() * 1000000000ULL;
  return result;
}

static time_t shifted_time(time_t *out) {
  time_t result = time(NULL) + offset_seconds();
  if (out != NULL) *out = result;
  return result;
}

DYLD_INTERPOSE(shifted_gettimeofday, gettimeofday)
DYLD_INTERPOSE(shifted_clock_gettime, clock_gettime)
DYLD_INTERPOSE(shifted_clock_gettime_nsec_np, clock_gettime_nsec_np)
DYLD_INTERPOSE(shifted_time, time)
