/**
 * The handful of classic SPL Token and Associated Token instructions the Solana rehearsal needs,
 * encoded directly so the rehearsal has no client library between it and the program it drives.
 * Layouts follow the SPL Token program's instruction indices; all integers are little-endian.
 */
import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM, TOKEN_PROGRAM, leBytes } from '../../src/lib/equilibriumSolana'

export const MINT_SIZE = 82
export const TOKEN_ACCOUNT_SIZE = 165

const enum Index { Approve = 4, SetAuthority = 6, MintTo = 7, InitializeMint2 = 20 }
/** `AuthorityType` in the SPL Token program. Only mint authority is moved here. */
const MINT_TOKENS = 0

function ix(keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[], programId: PublicKey, data: Uint8Array): TransactionInstruction {
  return new TransactionInstruction({ keys, programId, data: Buffer.from(data) })
}
const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false })
const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true })
const signer = (pubkey: PublicKey) => ({ pubkey, isSigner: true, isWritable: false })
const signerRw = (pubkey: PublicKey) => ({ pubkey, isSigner: true, isWritable: true })

export async function createMintAccount(connection: Connection, payer: PublicKey, mint: PublicKey): Promise<TransactionInstruction> {
  return SystemProgram.createAccount({
    fromPubkey: payer, newAccountPubkey: mint, space: MINT_SIZE,
    lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE), programId: TOKEN_PROGRAM,
  })
}
/** No freeze authority: a spoke that can freeze holders is a different product decision. */
export function initializeMint2(mint: PublicKey, decimals: number, mintAuthority: PublicKey): TransactionInstruction {
  const data = new Uint8Array(1 + 1 + 32 + 1)
  data[0] = Index.InitializeMint2
  data[1] = decimals
  data.set(mintAuthority.toBytes(), 2)
  data[34] = 0
  return ix([rw(mint)], TOKEN_PROGRAM, data)
}
export function setMintAuthority(mint: PublicKey, current: PublicKey, next: PublicKey): TransactionInstruction {
  const data = new Uint8Array(1 + 1 + 1 + 32)
  data[0] = Index.SetAuthority
  data[1] = MINT_TOKENS
  data[2] = 1
  data.set(next.toBytes(), 3)
  return ix([rw(mint), signer(current)], TOKEN_PROGRAM, data)
}
export function mintTo(mint: PublicKey, destination: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  return ix([rw(mint), rw(destination), signer(authority)], TOKEN_PROGRAM, new Uint8Array([Index.MintTo, ...leBytes(amount, 8)]))
}
/** Approves the session authority for exactly one transfer's worth of tokens. */
export function approve(source: PublicKey, delegate: PublicKey, owner: PublicKey, amount: bigint): TransactionInstruction {
  return ix([rw(source), ro(delegate), signer(owner)], TOKEN_PROGRAM, new Uint8Array([Index.Approve, ...leBytes(amount, 8)]))
}
export function associatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM)[0]
}
/** The idempotent variant, so a resumed rehearsal does not fail on an account it already made. */
export function createAssociatedTokenAccount(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return ix(
    [signerRw(payer), rw(associatedTokenAddress(mint, owner)), ro(owner), ro(mint), ro(SystemProgram.programId), ro(TOKEN_PROGRAM)],
    ASSOCIATED_TOKEN_PROGRAM,
    new Uint8Array([1]),
  )
}

export interface MintState { decimals: number; supply: bigint; mintAuthority: PublicKey | null }
function readLe(data: Uint8Array, offset: number, width: number): bigint {
  let value = 0n
  for (let i = width - 1; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i])
  return value
}
export async function readMint(connection: Connection, mint: PublicKey): Promise<MintState> {
  const account = await connection.getAccountInfo(mint, 'confirmed')
  if (!account) throw new Error(`Mint ${mint.toBase58()} does not exist.`)
  const data = account.data
  return {
    decimals: data[44],
    supply: readLe(data, 36, 8),
    mintAuthority: readLe(data, 0, 4) === 1n ? new PublicKey(data.subarray(4, 36)) : null,
  }
}
export async function readTokenBalance(connection: Connection, account: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(account, 'confirmed')
  if (!info) return 0n
  return readLe(info.data, 64, 8)
}
