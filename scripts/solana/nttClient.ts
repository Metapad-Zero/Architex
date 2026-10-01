/**
 * Instruction builders and account readers for the pinned NTT manager and Wormhole transceiver
 * programs (`lib/ntt-svm`, commit 1a2a92ef7f289972b2d00dd1d58077d139fe68d7).
 *
 * Account order and instruction data follow the `#[derive(Accounts)]` structs at that commit, with
 * nested structs flattened where they are declared. Instruction data is Anchor's eight-byte
 * discriminator followed by Borsh-encoded arguments, so everything here is little-endian; the
 * big-endian NTT wire format lives in `src/lib/equilibriumSolana.ts` and never mixes with it.
 */
import {
  Keypair, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY,
  TransactionInstruction, type Connection,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM, TOKEN_PROGRAM, BPF_LOADER_UPGRADEABLE, anchorDiscriminator, leBytes,
  nttAddresses, transferArgsHash, type TrimmedAmount,
} from '../../src/lib/equilibriumSolana'

export const BURNING = 1
export const LOCKING = 0

const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false })
const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true })
const signer = (pubkey: PublicKey) => ({ pubkey, isSigner: true, isWritable: false })
const signerRw = (pubkey: PublicKey) => ({ pubkey, isSigner: true, isWritable: true })
const bool = (value: boolean) => Uint8Array.from([value ? 1 : 0])

function data(name: string, ...args: Uint8Array[]): Buffer {
  return Buffer.concat([Buffer.from(anchorDiscriminator(name)), ...args.map((arg) => Buffer.from(arg))])
}

export type Addresses = ReturnType<typeof nttAddresses>

/** One configured NTT deployment: the two program ids, the mint, and every address they derive. */
export class NttDeployment {
  readonly at: Addresses
  constructor(
    readonly manager: PublicKey,
    readonly transceiver: PublicKey,
    readonly coreBridge: PublicKey,
    readonly mint: PublicKey,
  ) {
    this.at = nttAddresses(manager, transceiver, coreBridge)
  }

  /**
   * `deployer` must be the manager program's upgrade authority, and in burning mode the mint's
   * authority must already be the `token_authority` PDA. Both are checked on chain.
   */
  initialize(payer: PublicKey, deployer: PublicKey, chainId: number, limit: bigint, mode: number): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.manager,
      keys: [
        signerRw(payer), signer(deployer), ro(this.at.programData(this.manager)), rw(this.at.config),
        ro(this.mint), rw(this.at.outboxRateLimit), ro(this.at.tokenAuthority),
        // Anchor signals an absent optional account with the program's own id.
        ro(this.manager),
        rw(this.custody()), ro(TOKEN_PROGRAM), ro(ASSOCIATED_TOKEN_PROGRAM), ro(BPF_LOADER_UPGRADEABLE),
        ro(SystemProgram.programId),
      ],
      data: data('initialize', leBytes(BigInt(chainId), 2), leBytes(limit, 8), Uint8Array.from([mode])),
    })
  }

  /** The custody account is the token authority's associated token account for the mint. */
  custody(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [this.at.tokenAuthority.toBytes(), TOKEN_PROGRAM.toBytes(), this.mint.toBytes()],
      ASSOCIATED_TOKEN_PROGRAM,
    )[0]
  }

  setPeer(payer: PublicKey, owner: PublicKey, chainId: number, peer: Uint8Array, limit: bigint, peerDecimals: number): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.manager,
      keys: [
        signerRw(payer), signer(owner), ro(this.at.config), rw(this.at.peer(chainId)),
        rw(this.at.inboxRateLimit(chainId)), ro(SystemProgram.programId),
      ],
      data: data('set_peer', leBytes(BigInt(chainId), 2), peer, leBytes(limit, 8), Uint8Array.from([peerDecimals])),
    })
  }

  registerTransceiver(payer: PublicKey, owner: PublicKey): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.manager,
      keys: [
        rw(this.at.config), signer(owner), signerRw(payer), ro(this.transceiver),
        rw(this.at.registeredTransceiver(this.transceiver)), ro(SystemProgram.programId),
      ],
      data: data('register_transceiver'),
    })
  }

  setThreshold(owner: PublicKey, threshold: number): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.manager,
      keys: [signer(owner), rw(this.at.config)],
      data: data('set_threshold', Uint8Array.from([threshold])),
    })
  }

  setPaused(owner: PublicKey, paused: boolean): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.manager,
      keys: [signer(owner), rw(this.at.config)],
      data: data('set_paused', bool(paused)),
    })
  }

  setOutboundLimit(owner: PublicKey, limit: bigint): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.manager,
      keys: [ro(this.at.config), signer(owner), rw(this.at.outboxRateLimit)],
      data: data('set_outbound_limit', leBytes(limit, 8)),
    })
  }

  setInboundLimit(owner: PublicKey, chainId: number, limit: bigint): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.manager,
      keys: [ro(this.at.config), signer(owner), rw(this.at.inboxRateLimit(chainId))],
      data: data('set_inbound_limit', leBytes(limit, 8), leBytes(BigInt(chainId), 2)),
    })
  }

  /**
   * Burns from custody and records an outbox item. The session authority is seeded by these exact
   * arguments, so the SPL approval that precedes this call authorizes this transfer only.
   */
  transferBurn(
    payer: PublicKey, from: PublicKey, fromOwner: PublicKey, outboxItem: PublicKey,
    amount: bigint, recipientChain: number, recipient: Uint8Array, shouldQueue: boolean,
  ): { instruction: TransactionInstruction; sessionAuthority: PublicKey } {
    const sessionAuthority = this.at.sessionAuthority(fromOwner, transferArgsHash(amount, recipientChain, recipient, shouldQueue))
    return {
      sessionAuthority,
      instruction: new TransactionInstruction({
        programId: this.manager,
        keys: [
          // Transfer (common)
          signerRw(payer), ro(this.at.config), rw(this.mint), rw(from), ro(TOKEN_PROGRAM),
          { pubkey: outboxItem, isSigner: true, isWritable: true },
          rw(this.at.outboxRateLimit), rw(this.custody()), ro(SystemProgram.programId),
          // TransferBurn
          rw(this.at.inboxRateLimit(recipientChain)), ro(this.at.peer(recipientChain)),
          ro(sessionAuthority), ro(this.at.tokenAuthority),
        ],
        data: data('transfer_burn', leBytes(amount, 8), leBytes(BigInt(recipientChain), 2), recipient, bool(shouldQueue)),
      }),
    }
  }

  /** Publishes the outbox item through the core bridge. Refuses a second publication. */
  releaseWormholeOutbound(payer: PublicKey, outboxItem: PublicKey, revertOnDelay: boolean): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.transceiver,
      keys: [
        signerRw(payer), ro(this.at.config), rw(outboxItem),
        ro(this.at.registeredTransceiver(this.transceiver)),
        rw(this.at.wormholeMessage(outboxItem)), ro(this.at.emitter),
        // WormholeAccounts
        rw(this.at.coreBridgeConfig), rw(this.at.feeCollector), rw(this.at.sequence),
        ro(this.coreBridge), ro(SystemProgram.programId), ro(SYSVAR_CLOCK_PUBKEY), ro(SYSVAR_RENT_PUBKEY),
        // manager program, then the PDA it signs the mark-as-released CPI with
        ro(this.manager), ro(this.at.outboxItemSigner),
      ],
      data: data('release_wormhole_outbound', bool(revertOnDelay)),
    })
  }

  setWormholePeer(payer: PublicKey, owner: PublicKey, chainId: number, peer: Uint8Array): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.transceiver,
      keys: [
        ro(this.at.config), signer(owner), signerRw(payer), rw(this.at.transceiverPeer(chainId)),
        ro(SystemProgram.programId),
      ],
      data: data('set_wormhole_peer', leBytes(BigInt(chainId), 2), peer),
    })
  }

  /** Validates a posted VAA against the registered transceiver peer and records it once. */
  receiveWormholeMessage(payer: PublicKey, postedVaa: PublicKey, emitterChain: number, messageId: Uint8Array): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.transceiver,
      keys: [
        signerRw(payer), ro(this.at.config), ro(this.at.transceiverPeer(emitterChain)), ro(postedVaa),
        rw(this.at.transceiverMessage(emitterChain, messageId)), ro(SystemProgram.programId),
      ],
      data: data('receive_wormhole_message'),
    })
  }

  /** Votes the validated message into a content-addressed inbox item. Idempotent by construction. */
  redeem(payer: PublicKey, emitterChain: number, messageId: Uint8Array, digest: Uint8Array): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.manager,
      keys: [
        signerRw(payer), ro(this.at.config), ro(this.at.peer(emitterChain)),
        ro(this.at.transceiverMessage(emitterChain, messageId)),
        ro(this.at.registeredTransceiver(this.transceiver)), ro(this.mint),
        rw(this.at.inboxItem(digest)), rw(this.at.inboxRateLimit(emitterChain)),
        rw(this.at.outboxRateLimit), ro(SystemProgram.programId),
      ],
      data: data('redeem'),
    })
  }

  releaseInboundMint(payer: PublicKey, digest: Uint8Array, recipientTokenAccount: PublicKey, revertWhenNotReady: boolean): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.manager,
      keys: [
        // ReleaseInbound (common)
        signerRw(payer), ro(this.at.config), rw(this.at.inboxItem(digest)), rw(recipientTokenAccount),
        ro(this.at.tokenAuthority), rw(this.mint), ro(TOKEN_PROGRAM), rw(this.custody()),
        // absent optional multisig token authority
        ro(this.manager),
      ],
      data: data('release_inbound_mint', bool(revertWhenNotReady)),
    })
  }
}

/* ------------------------------------------------------------------ account readers */

function readLe(bytes: Uint8Array, offset: number, width: number, signed = false): bigint {
  let value = 0n
  for (let i = width - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[offset + i])
  if (signed && value >= 1n << BigInt(8 * width - 1)) value -= 1n << BigInt(8 * width)
  return value
}

export interface ConfigState {
  owner: PublicKey; mint: PublicKey; mode: number; chainId: number
  threshold: number; enabledTransceivers: bigint; paused: boolean; custody: PublicKey
}
/** Borsh reads fields in declaration order, so `pending_owner`'s option tag shifts what follows. */
export function decodeConfig(raw: Uint8Array): ConfigState {
  let at = 8 + 1
  const owner = new PublicKey(raw.subarray(at, at + 32)); at += 32
  const hasPending = raw[at] === 1; at += 1 + (hasPending ? 32 : 0)
  const mint = new PublicKey(raw.subarray(at, at + 32)); at += 32 + 32
  const mode = raw[at]; at += 1
  const chainId = Number(readLe(raw, at, 2)); at += 2
  at += 1
  const threshold = raw[at]; at += 1
  const enabledTransceivers = readLe(raw, at, 16); at += 16
  const paused = raw[at] === 1; at += 1
  return { owner, mint, mode, chainId, threshold, enabledTransceivers, paused, custody: new PublicKey(raw.subarray(at, at + 32)) }
}

export interface OutboxItemState {
  amount: TrimmedAmount; sender: PublicKey; recipientChain: number
  recipientNttManager: Uint8Array; recipientAddress: Uint8Array; releaseTimestamp: bigint; released: bigint
}
export function decodeOutboxItem(raw: Uint8Array): OutboxItemState {
  return {
    amount: { amount: readLe(raw, 8, 8), decimals: raw[16] },
    sender: new PublicKey(raw.subarray(17, 49)),
    recipientChain: Number(readLe(raw, 49, 2)),
    recipientNttManager: raw.subarray(51, 83),
    recipientAddress: raw.subarray(83, 115),
    releaseTimestamp: readLe(raw, 115, 8, true),
    released: readLe(raw, 123, 16),
  }
}

export type ReleaseStatus = 'not_approved' | 'release_after' | 'released'
export interface InboxItemState { amount: bigint; recipient: PublicKey; status: ReleaseStatus; releaseAfter: bigint | null }
export function decodeInboxItem(raw: Uint8Array): InboxItemState {
  const amount = readLe(raw, 10, 8)
  const recipient = new PublicKey(raw.subarray(18, 50))
  const tag = raw[66]
  return {
    amount, recipient,
    status: tag === 0 ? 'not_approved' : tag === 1 ? 'release_after' : 'released',
    releaseAfter: tag === 1 ? readLe(raw, 67, 8, true) : null,
  }
}

export async function fetchAccount(connection: Connection, address: PublicKey): Promise<Uint8Array> {
  const account = await connection.getAccountInfo(address, 'confirmed')
  if (!account) throw new Error(`Account ${address.toBase58()} does not exist.`)
  return account.data
}
export function newOutboxItem(): Keypair { return Keypair.generate() }
