/**
 * FORK REHEARSAL additions for transfers, on top of fork.ts's two pinned forks. Two more
 * substitutions, both fork-only and both explicit in every test that relies on them:
 *
 * 4. Each MessageTransmitterV2's attester set (Circle's two V2 keys, threshold 2) is overwritten with
 *    one local key at threshold 1, so the harness can attest. Signature checks, the destination-caller
 *    check, nonce replay protection and the mint through TokenMinterV2 are the deployed contracts'.
 * 5. Arc's USDC stand-in gains `burn`, which TokenMinterV2 calls on a deposit (ForkUsdcCctp). The real
 *    Arc USDC mints and burns through Arc precompiles anvil does not implement.
 */
import { createTestClient, createWalletClient, encodeAbiParameters, http, keccak256, numberToHex, pad, publicActions, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { linked } from '../contracts'
import { DEV, PINNED } from '../fork'
import { CCTP_TESTNET, messageTransmitterAbi } from './cctp'
import bundle from './fork-bytecode.json'

/** anvil development key #4, the fork's only CCTP attester. Never an attester anywhere real. */
export const FORK_ATTESTER_KEY = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' as Hex
/** MessageTransmitterV2 storage (circlefin/evm-cctp-contracts v2, proxy storage): see cctp.ts. */
const THRESHOLD_SLOT = 4n
const ATTESTERS_SLOT = 5n
const ATTESTER_INDEX_SLOT = 6n
const word = (n: bigint) => pad(numberToHex(n), { size: 32 })

function client(url: string) {
  return createTestClient({ mode: 'anvil', transport: http(url) }).extend(publicActions)
}

/** Replace the attester set with one local key, threshold 1, the way Attestable stores it. */
export async function localAttesterSet(url: string, transmitter: Address, attester: Address) {
  const test = client(url)
  const count = await test.readContract({ address: transmitter, abi: messageTransmitterAbi, functionName: 'getNumEnabledAttesters' })
  const index = (a: Address) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [a, ATTESTER_INDEX_SLOT]))
  const values = BigInt(keccak256(word(ATTESTERS_SLOT)))
  for (let i = 0n; i < count; i++) {
    const old = await test.readContract({ address: transmitter, abi: messageTransmitterAbi, functionName: 'getEnabledAttester', args: [i] })
    await test.setStorageAt({ address: transmitter, index: index(old), value: word(0n) })
    await test.setStorageAt({ address: transmitter, index: numberToHex(values + i, { size: 32 }), value: word(0n) })
  }
  await test.setStorageAt({ address: transmitter, index: numberToHex(values, { size: 32 }), value: pad(attester, { size: 32 }) })
  await test.setStorageAt({ address: transmitter, index: index(attester), value: word(1n) })
  await test.setStorageAt({ address: transmitter, index: word(ATTESTERS_SLOT), value: word(1n) })
  await test.setStorageAt({ address: transmitter, index: word(THRESHOLD_SLOT), value: word(1n) })
}

/** Arc USDC stand-in with `burn`, in place over ForkUsdc (same storage layout, balances kept). */
export async function burnableArcUsdc(url: string) {
  const test = client(url)
  const operator = privateKeyToAccount(DEV.operator)
  const wallet = createWalletClient({ account: operator, transport: http(url) })
  const hash = await wallet.sendTransaction({ account: operator, chain: null, data: linked(bundle.ForkUsdcCctp) })
  const receipt = await test.waitForTransactionReceipt({ hash })
  if (!receipt.contractAddress) throw new Error('ForkUsdcCctp deployment failed')
  await test.setCode({ address: PINNED.arc.usdc, bytecode: (await test.getCode({ address: receipt.contractAddress }))! })
}

/** Both substitutions on both forks. Returns the attester address the transmitters now trust. */
export async function forkCctp(arcUrl: string, baseUrl: string): Promise<Address> {
  const attester = privateKeyToAccount(FORK_ATTESTER_KEY).address
  await burnableArcUsdc(arcUrl)
  await localAttesterSet(arcUrl, CCTP_TESTNET.arc.messageTransmitter, attester)
  await localAttesterSet(baseUrl, CCTP_TESTNET.base.messageTransmitter, attester)
  return attester
}
