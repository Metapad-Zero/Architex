import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'

interface ConnectSheetApi {
  isOpen: boolean
  open: () => void
  close: () => void
  triggerRef: RefObject<HTMLButtonElement>
}

const ConnectSheetContext = createContext<ConnectSheetApi | null>(null)

export function ConnectSheetProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => {
    setIsOpen(false)
    triggerRef.current?.focus()
  }, [])

  const value = useMemo(() => ({ isOpen, open, close, triggerRef }), [isOpen, open, close])

  return <ConnectSheetContext.Provider value={value}>{children}</ConnectSheetContext.Provider>
}

export function useConnectSheet() {
  const value = useContext(ConnectSheetContext)
  if (!value) throw new Error('useConnectSheet must be used within ConnectSheetProvider')
  return value
}
