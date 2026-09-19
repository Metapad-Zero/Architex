import type { Hex, TypedDataDefinition } from 'viem'
import type { TxRequest } from './signingIntent'

/**
 * The bridge between the browser-wallet connector and the confirm sheet. The connector asks for an
 * unlock with the exact request it is about to sign; the sheet shows it, takes the passkey or the
 * password, and resolves with the decrypted key for that one signature. Requests are answered one
 * at a time in arrival order.
 */
export type SigningRequest =
  | { kind: 'transaction'; tx: TxRequest }
  | { kind: 'typedData'; typed: TypedDataDefinition }
  | { kind: 'message'; message: Hex }
  | { kind: 'reveal' }

export type UnlockHandler = (request: SigningRequest) => Promise<Hex>

let handler: UnlockHandler | undefined
let queue: Promise<unknown> = Promise.resolve()

export function setUnlockHandler(next: UnlockHandler | undefined): void {
  handler = next
}

export function requestUnlock(request: SigningRequest): Promise<Hex> {
  const turn = queue.then(() => {
    if (!handler) throw new Error('The browser wallet cannot ask for confirmation on this page.')
    return handler(request)
  })
  queue = turn.catch(() => undefined)
  return turn
}
