import { concat, decodeEventLog, encodePacked, keccak256, numberToHex, type Hex, type Log } from 'viem'
import { sign } from 'viem/accounts'
import { coreAbi } from './contracts'

/** A Wormhole message as the core contract published it on the source chain. */
export interface Published { emitterChain: number; emitter: Hex; sequence: bigint; nonce: number; payload: Hex; consistencyLevel: number; timestamp: number }

/** Where a signed VAA for a published message comes from. `null` means not signed yet: pending, not absent. */
export interface VaaSource {
  readonly kind: 'local-guardian' | 'wormholescan'
  signed(message: Published): Promise<Hex | null>
}

export function publishedFrom(logs: Log[], core: Hex, emitterChain: number, timestamp: number): Published[] {
  return logs.filter((log) => log.address.toLowerCase() === core.toLowerCase()).flatMap((log) => {
    try {
      const event = decodeEventLog({ abi: coreAbi, data: log.data, topics: log.topics })
      if (event.eventName !== 'LogMessagePublished') return []
      const { sender, sequence, nonce, payload, consistencyLevel } = event.args
      return [{ emitterChain, emitter: `0x${sender.slice(2).toLowerCase().padStart(64, '0')}` satisfies Hex, sequence, nonce, payload, consistencyLevel, timestamp }]
    } catch { return [] }
  })
}

export function body(m: Published): Hex {
  return encodePacked(['uint32', 'uint32', 'uint16', 'bytes32', 'uint64', 'uint8', 'bytes'], [m.timestamp, m.nonce, m.emitterChain, m.emitter, m.sequence, m.consistencyLevel, m.payload])
}

/**
 * FORK ONLY. Signs with a one-key Guardian set the fork harness wrote into each core contract.
 * It exercises the destination's real VAA verification, peer checks and replay protection; it
 * does not prove that the public Guardian network attests the route.
 */
export function localGuardian(privateKey: Hex, guardianSetIndex: number): VaaSource {
  return {
    kind: 'local-guardian',
    async signed(m) {
      const observation = body(m)
      const digest = keccak256(keccak256(observation))
      const signature = await sign({ hash: digest, privateKey })
      const v = Number(signature.v ?? 27n) - 27
      return concat([encodePacked(['uint8', 'uint32', 'uint8', 'uint8'], [1, guardianSetIndex, 1, 0]), signature.r, signature.s, numberToHex(v, { size: 1 }), observation])
    },
  }
}

/** Public Guardian attestations. 404 while the Guardians have not signed yet. */
export function wormholescan(api: string, fetcher: typeof fetch = fetch): VaaSource {
  return {
    kind: 'wormholescan',
    async signed(m) {
      const response = await fetcher(`${api}/api/v1/vaas/${m.emitterChain}/${m.emitter.slice(2)}/${m.sequence}`)
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`Wormholescan ${response.status}`)
      const json = await response.json() as { data?: { vaa?: string } }
      if (!json.data?.vaa) return null
      return `0x${Buffer.from(json.data.vaa, 'base64').toString('hex')}`
    },
  }
}
