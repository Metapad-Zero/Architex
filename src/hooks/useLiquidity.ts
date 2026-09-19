import { useCallback, useState } from 'react'
import { parseSignature, type Address, type Hash } from 'viem'
import { useAccount, usePublicClient, useSignTypedData, useWriteContract } from 'wagmi'
import { activeChain } from '../chain'
import { isUserRejection, revertReason } from '../lib/errors'
import { pushRecent, type RecentEntry } from '../lib/recent'
import { erc20Abi, pairAbi, routerAbi } from '../lib/abi'
import { minReceived } from '../lib/amm'
import { deployment } from '../lib/deployment'

export interface LiquidityStatus {
  kind: 'pending' | 'confirmed' | 'failed' | 'cancelled'
  label: string
  hash?: Hash
  reason?: string
}

interface AddLiquidityArgs {
  tokenA: Address
  tokenB: Address
  amountA: bigint
  amountB: bigint
  slippageBps: number
  deadlineMinutes: number
}

interface RemoveLiquidityArgs {
  pair: Address
  tokenA: Address
  tokenB: Address
  liquidity: bigint
  amountA: bigint
  amountB: bigint
  routerAllowance: bigint
  slippageBps: number
  deadlineMinutes: number
}

export function useLiquidity(onConfirmed: () => void | Promise<void>) {
  const { address: account } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const { signTypedDataAsync } = useSignTypedData()
  const [status, setStatus] = useState<LiquidityStatus | undefined>()

  const waitFor = useCallback(
    async (hash: Hash, pendingLabel: string, confirmedLabel: string, kind?: RecentEntry['kind']) => {
      if (!publicClient) throw new Error('No public client')
      setStatus({ kind: 'pending', label: pendingLabel, hash })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('Transaction reverted')
      setStatus({ kind: 'confirmed', label: confirmedLabel, hash })
      if (kind) pushRecent(activeChain.id, { hash, kind, summary: confirmedLabel })
      await onConfirmed()
    },
    [onConfirmed, publicClient],
  )

  const approve = useCallback(
    async (token: Address, amount: bigint, symbol: string) => {
      try {
        setStatus({ kind: 'pending', label: `Approving ${symbol}…` })
        const hash = await writeContractAsync({
          address: token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [deployment.router, amount],
        })
        await waitFor(hash, `Approving ${symbol}…`, `${symbol} approved`)
      } catch (error) {
        if (isUserRejection(error)) {
          setStatus({ kind: 'cancelled', label: 'Transaction cancelled' })
        } else {
          setStatus({ kind: 'failed', label: 'Failed', reason: revertReason(error) })
        }
      }
    },
    [waitFor, writeContractAsync],
  )

  const addLiquidity = useCallback(
    async ({ tokenA, tokenB, amountA, amountB, slippageBps, deadlineMinutes }: AddLiquidityArgs) => {
      if (!account) return
      try {
        setStatus({ kind: 'pending', label: 'Adding liquidity…' })
        const deadline = BigInt(Math.floor(Date.now() / 1_000) + deadlineMinutes * 60)
        const hash = await writeContractAsync({
          address: deployment.router,
          abi: routerAbi,
          functionName: 'addLiquidity',
          args: [
            tokenA,
            tokenB,
            amountA,
            amountB,
            minReceived(amountA, slippageBps),
            minReceived(amountB, slippageBps),
            account,
            deadline,
          ],
        })
        await waitFor(hash, 'Adding liquidity…', 'Added liquidity', 'add')
      } catch (error) {
        if (isUserRejection(error)) {
          setStatus({ kind: 'cancelled', label: 'Transaction cancelled' })
        } else {
          setStatus({ kind: 'failed', label: 'Failed', reason: revertReason(error) })
        }
      }
    },
    [account, waitFor, writeContractAsync],
  )

  const removeLiquidity = useCallback(
    async ({
      pair,
      tokenA,
      tokenB,
      liquidity,
      amountA,
      amountB,
      routerAllowance,
      slippageBps,
      deadlineMinutes,
    }: RemoveLiquidityArgs) => {
      if (!account || !publicClient) return
      const deadline = BigInt(Math.floor(Date.now() / 1_000) + deadlineMinutes * 60)
      const commonArgs = [
        tokenA,
        tokenB,
        liquidity,
        minReceived(amountA, slippageBps),
        minReceived(amountB, slippageBps),
        account,
        deadline,
      ] as const

      try {
        setStatus({ kind: 'pending', label: 'Signing permit…' })
        try {
          // The EIP-712 domain name is the LP token's own name(): deployments made before the
          // rename say "ArcSwap LP", newer ones "Architex LP" — reading it keeps both valid.
          const [nonce, domainName] = await Promise.all([
            publicClient.readContract({ address: pair, abi: pairAbi, functionName: 'nonces', args: [account] }),
            publicClient.readContract({ address: pair, abi: pairAbi, functionName: 'name' }),
          ])
          const signature = await signTypedDataAsync({
            domain: {
              name: domainName,
              version: '1',
              chainId: activeChain.id,
              verifyingContract: pair,
            },
            types: {
              Permit: [
                { name: 'owner', type: 'address' },
                { name: 'spender', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
              ],
            },
            primaryType: 'Permit',
            message: { owner: account, spender: deployment.router, value: liquidity, nonce, deadline },
          })
          const { v, r, s } = parseSignature(signature)
          const hash = await writeContractAsync({
            address: deployment.router,
            abi: routerAbi,
            functionName: 'removeLiquidityWithPermit',
            args: [...commonArgs, false, Number(v), r, s],
          })
          await waitFor(hash, 'Removing liquidity…', 'Removed liquidity', 'remove')
          return
        } catch (permitError) {
          if (isUserRejection(permitError)) throw permitError
        }

        if (routerAllowance < liquidity) {
          const approvalHash = await writeContractAsync({
            address: pair,
            abi: erc20Abi,
            functionName: 'approve',
            args: [deployment.router, liquidity],
          })
          await publicClient.waitForTransactionReceipt({ hash: approvalHash })
        }
        const hash = await writeContractAsync({
          address: deployment.router,
          abi: routerAbi,
          functionName: 'removeLiquidity',
          args: commonArgs,
        })
        await waitFor(hash, 'Removing liquidity…', 'Removed liquidity', 'remove')
      } catch (error) {
        if (isUserRejection(error)) {
          setStatus({ kind: 'cancelled', label: 'Transaction cancelled' })
        } else {
          setStatus({ kind: 'failed', label: 'Failed', reason: revertReason(error) })
        }
      }
    },
    [account, publicClient, signTypedDataAsync, waitFor, writeContractAsync],
  )

  return { status, approve, addLiquidity, removeLiquidity, clearStatus: () => setStatus(undefined) }
}
