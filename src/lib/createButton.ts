export type CreateButtonState =
  | 'disconnected'
  | 'wrongChain'
  | 'invalid'
  | 'loadingFee'
  | 'insufficientBalance'
  | 'needsApproval'
  | 'approving'
  | 'ready'
  | 'pending'

export interface CreateButtonInput {
  connected: boolean
  onActiveChain: boolean
  phase: 'idle' | 'approving' | 'pending'
  valid: boolean
  feeKnown: boolean
  spendable: bigint
  totalUsdc: bigint
  allowance: bigint
  /** The amount of a confirmed approval that the allowance read may not show yet. */
  approvedAmount: bigint | undefined
}

export function allowanceLagging(allowance: bigint, approvedAmount: bigint | undefined): boolean {
  return approvedAmount !== undefined && allowance < approvedAmount
}

export function createButtonState(input: CreateButtonInput): CreateButtonState {
  if (!input.connected) return 'disconnected'
  if (!input.onActiveChain) return 'wrongChain'
  if (input.phase === 'approving' || allowanceLagging(input.allowance, input.approvedAmount)) return 'approving'
  if (input.phase === 'pending') return 'pending'
  if (!input.valid) return 'invalid'
  if (!input.feeKnown) return 'loadingFee'
  if (input.spendable < input.totalUsdc) return 'insufficientBalance'
  if (input.allowance < input.totalUsdc) return 'needsApproval'
  return 'ready'
}
