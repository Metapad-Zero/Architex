/**
 * Guardian-side helpers for the local Solana rehearsal: sign a VAA with the substituted one-key
 * guardian set, then post it through the actual mainnet core bridge program running on the local
 * validator.
 *
 * The guardian key here is the public Wormhole development key. It is the SVM counterpart of the
 * one-key guardian set `NttRehearsal.t.sol` substitutes on its EVM fork, and it is the reason a
 * passing run is local evidence and not a public route: a real transfer needs the live Guardian
 * set to observe and sign it.
 */
import { keccak_256 } from '@noble/hashes/sha3'
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  PublicKey, Secp256k1Program, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY, TransactionInstruction,
} from '@solana/web3.js'
import { encodeVaaBody, leBytes, vaaBodyHash, type VaaBody } from '../../src/lib/equilibriumSolana'

/** Wormhole's published development guardian key; guardian set 0 in the checked-in fixture. */
export const DEV_GUARDIAN_KEY = 'cfb12303a19cde580bb4dd771639b0d26bc68353645571a8cff516ab2ee113a0'
export const DEV_GUARDIAN_ADDRESS = 'befa429d57cd18b7f8a4d91a2da9ab4af05d0fbe'

const enum CoreIndex { PostVaa = 2, VerifySignatures = 7 }

export interface SignedVaa { body: VaaBody; hash: Uint8Array; signature: Uint8Array; recoveryId: number }

/**
 * Guardians sign `keccak256(keccak256(body))`. The secp256k1 precompile hashes whatever message it
 * is given, so it is handed the single hash and applies the second itself.
 */
export function signVaa(body: VaaBody, guardianKey = DEV_GUARDIAN_KEY): SignedVaa {
  const hash = vaaBodyHash(body)
  const signed = secp256k1.sign(keccak_256(hash), guardianKey)
  return { body, hash, signature: signed.toCompactRawBytes(), recoveryId: signed.recovery }
}

/** The precompile instruction the core bridge reads back out of the instructions sysvar. */
export function secp256k1Instruction(vaa: SignedVaa, guardianAddress = DEV_GUARDIAN_ADDRESS): TransactionInstruction {
  return Secp256k1Program.createInstructionWithEthAddress({
    ethAddress: guardianAddress,
    message: Buffer.from(vaa.hash),
    signature: Buffer.from(vaa.signature),
    recoveryId: vaa.recoveryId,
    instructionIndex: 0,
  })
}

const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false })
const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true })

/**
 * Must sit at instruction index 1, directly after {@link secp256k1Instruction}: the bridge reads
 * the precompile instruction at its own index minus one.
 */
export function verifySignaturesInstruction(
  coreBridge: PublicKey, payer: PublicKey, guardianSet: PublicKey, signatureSet: PublicKey,
): TransactionInstruction {
  // One signer, at position 0 of the guardian set; the remaining eighteen slots are absent.
  const signers = new Int8Array(19).fill(-1)
  signers[0] = 0
  return new TransactionInstruction({
    programId: coreBridge,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      ro(guardianSet),
      { pubkey: signatureSet, isSigner: true, isWritable: true },
      ro(SYSVAR_INSTRUCTIONS_PUBKEY), ro(SYSVAR_RENT_PUBKEY), ro(SystemProgram.programId),
    ],
    data: Buffer.concat([Buffer.from([CoreIndex.VerifySignatures]), Buffer.from(signers.buffer)]),
  })
}

export function postVaaInstruction(
  coreBridge: PublicKey, payer: PublicKey, guardianSet: PublicKey, bridgeConfig: PublicKey,
  signatureSet: PublicKey, postedVaa: PublicKey, body: VaaBody, guardianSetIndex = 0,
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from([CoreIndex.PostVaa, 1]),
    Buffer.from(leBytes(BigInt(guardianSetIndex), 4)),
    Buffer.from(leBytes(BigInt(body.timestamp), 4)),
    Buffer.from(leBytes(BigInt(body.nonce), 4)),
    Buffer.from(leBytes(BigInt(body.emitterChain), 2)),
    Buffer.from(body.emitterAddress),
    Buffer.from(leBytes(body.sequence, 8)),
    Buffer.from([body.consistencyLevel]),
    Buffer.from(leBytes(BigInt(body.payload.length), 4)),
    Buffer.from(body.payload),
  ])
  return new TransactionInstruction({
    programId: coreBridge,
    keys: [
      ro(guardianSet), ro(bridgeConfig), ro(signatureSet), rw(postedVaa),
      { pubkey: payer, isSigner: true, isWritable: true },
      ro(SYSVAR_CLOCK_PUBKEY), ro(SYSVAR_RENT_PUBKEY), ro(SystemProgram.programId),
    ],
    data,
  })
}

/** The full serialized VAA, for the record a reviewer replays. */
export function serializeVaa(vaa: SignedVaa, guardianSetIndex = 0): Uint8Array {
  return Buffer.concat([
    Buffer.from([1]),
    Buffer.from(leBytes(BigInt(guardianSetIndex), 4).reverse()),
    Buffer.from([1, 0]),
    Buffer.from(vaa.signature),
    Buffer.from([vaa.recoveryId]),
    Buffer.from(encodeVaaBody(vaa.body)),
  ])
}
