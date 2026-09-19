import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'architex-settings'

interface SwapSettings {
  slippageBps: number
  deadlineMinutes: number
}

const defaults: SwapSettings = { slippageBps: 50, deadlineMinutes: 20 }

function loadSettings(): SwapSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return defaults
    const value = JSON.parse(stored) as Partial<SwapSettings>
    return {
      slippageBps:
        typeof value.slippageBps === 'number' && value.slippageBps >= 1 && value.slippageBps <= 5_000
          ? Math.round(value.slippageBps)
          : defaults.slippageBps,
      deadlineMinutes:
        typeof value.deadlineMinutes === 'number' && value.deadlineMinutes >= 1 && value.deadlineMinutes <= 180
          ? Math.round(value.deadlineMinutes)
          : defaults.deadlineMinutes,
    }
  } catch {
    return defaults
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<SwapSettings>(loadSettings)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // Storage can be unavailable in private browsing; in-memory settings still work.
    }
  }, [settings])

  const setSlippageBps = useCallback((value: number) => {
    setSettings((current) => ({ ...current, slippageBps: Math.min(5_000, Math.max(1, Math.round(value))) }))
  }, [])

  const setDeadlineMinutes = useCallback((value: number) => {
    setSettings((current) => ({ ...current, deadlineMinutes: Math.min(180, Math.max(1, Math.round(value))) }))
  }, [])

  return { ...settings, setSlippageBps, setDeadlineMinutes }
}
