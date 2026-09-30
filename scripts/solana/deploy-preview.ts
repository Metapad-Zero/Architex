/**
 * Prices a Solana EQUILIBRIUM deployment before anyone is asked to approve it.
 *
 * Read-only. Program sizes and account sizes come from the local rehearsal record, which measured
 * what the actual programs created; rent and the Wormhole message fee are read live from the
 * chosen cluster. Nothing here signs, funds, deploys or broadcasts, and running it does not open a
 * route: it produces the numbers and the exact signer list an approval needs.
 *
 * Run: `bun run equilibrium:solana:preview` (defaults to mainnet-beta; `--cluster devnet` for the
 * devnet figures, which is where Wormhole's own SVM guide creates an NTT token).
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Connection, PublicKey } from '@solana/web3.js'
import { SOLANA_NTT } from '../../src/lib/equilibriumSolana'

const ROOT = resolve(import.meta.dirname, '../..')
const RECORD = join(ROOT, 'output/equilibrium/solana-rehearsal.json')

interface Rehearsal {
  pin: { svmCommit: string; svmVersion: string; evmCommit: string; evmVersion: string }
  accountSizes: Record<string, number>
  programBytes: { manager: number; transceiver: number }
}

const CLUSTERS = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
} as const
type Cluster = keyof typeof CLUSTERS

function clusterArg(): Cluster {
  const index = process.argv.indexOf('--cluster')
  const value = index === -1 ? 'mainnet-beta' : process.argv[index + 1]
  if (value !== 'mainnet-beta' && value !== 'devnet') throw new Error('Use --cluster mainnet-beta or --cluster devnet.')
  return value
}

const LAMPORTS = 1_000_000_000
const sol = (lamports: number) => Number((lamports / LAMPORTS).toFixed(6))

/** `solana program deploy` allocates twice the program length so a later upgrade fits in place. */
function programDataBytes(programBytes: number): number {
  return 45 + 2 * programBytes
}

async function main(): Promise<void> {
  let rehearsal: Rehearsal
  try {
    rehearsal = JSON.parse(readFileSync(RECORD, 'utf8')) as Rehearsal
  } catch {
    throw new Error('No rehearsal record. Run `bun run equilibrium:solana` first: this preview prices the accounts that run measured.')
  }
  const cluster = clusterArg()
  const connection = new Connection(CLUSTERS[cluster], 'confirmed')

  const programs = await Promise.all((['manager', 'transceiver'] as const).map(async (name) => {
    const bytes = rehearsal.programBytes[name]
    const dataBytes = programDataBytes(bytes)
    return {
      program: name, bytes, programDataBytes: dataBytes,
      programAccountSol: sol(await connection.getMinimumBalanceForRentExemption(36)),
      programDataSol: sol(await connection.getMinimumBalanceForRentExemption(dataBytes)),
      // The upload buffer is the same size and is refunded on success. An abandoned deploy strands
      // it until `solana program close` recovers it, so it has to be budgeted, not assumed.
      transientBufferSol: sol(await connection.getMinimumBalanceForRentExemption(dataBytes)),
    }
  }))

  const accounts = await Promise.all(Object.entries(rehearsal.accountSizes).map(async ([account, bytes]) => ({
    account, bytes, rentSol: sol(await connection.getMinimumBalanceForRentExemption(bytes)),
  })))

  const bridge = await connection.getAccountInfo(PublicKey.findProgramAddressSync([new TextEncoder().encode('Bridge')], new PublicKey(SOLANA_NTT.coreBridge))[0], 'finalized')
  if (!bridge) throw new Error(`No Wormhole core bridge config on ${cluster}.`)
  const messageFeeLamports = Number(bridge.data.subarray(16, 24).reduce((value, byte, index) => value + BigInt(byte) * (1n << BigInt(8 * index)), 0n))

  const oneTimeSol = Number((
    programs.reduce((sum, item) => sum + item.programAccountSol + item.programDataSol, 0)
    + accounts.reduce((sum, item) => sum + item.rentSol, 0)
  ).toFixed(6))
  const peakSol = Number((oneTimeSol + programs.reduce((sum, item) => sum + item.transientBufferSol, 0)).toFixed(6))

  const preview = {
    generatedAt: new Date().toISOString(),
    cluster,
    status: 'preview only. Nothing was signed, funded, deployed or broadcast.',
    pin: rehearsal.pin,
    evidence: 'Sizes are measured from the local validator rehearsal; rent and message fee are read from the named cluster. No EQUILIBRIUM mint, manager, transceiver or pool exists on any public cluster.',

    /** Who has to sign, and what each key can still do afterwards. */
    signers: [
      { role: 'payer', signs: 'every deployment and configuration transaction', holds: `about ${peakSol} SOL at peak`, afterwards: 'no standing authority' },
      { role: 'program upgrade authority', signs: 'both program deploys, and `initialize` as the manager `deployer`', afterwards: 'can replace either program at will. This is the strongest key in the deployment and must be the approved custody, not a hot key.' },
      { role: 'manager owner', signs: '`set_peer`, `register_transceiver`, `set_threshold`, `set_paused`, `set_outbound_limit`, `set_inbound_limit`, `set_wormhole_peer`', afterwards: 'can add a peer, change the threshold, pause the spoke and change rate limits. Set to the same approved custody as the upgrade authority unless a split is approved explicitly.' },
      { role: 'temporary mint authority', signs: 'mint creation and the one-time `SetAuthority` to the manager token authority PDA', afterwards: 'nothing. After the handover the PDA is the only mint authority and no key can mint.' },
    ],
    mint: {
      decimals: SOLANA_NTT.decimals,
      initialSupply: '0. The spoke is minted only by a credited transfer.',
      mintAuthority: 'the manager `token_authority` PDA, set before `initialize`, which the program checks in burning mode',
      freezeAuthority: 'none. A spoke that can freeze holders is a separate product decision and is not part of this preview.',
      tokenProgram: 'classic SPL Token. Token-2022 transfer hooks are out of scope here.',
    },
    programs,
    accounts,
    funding: {
      oneTimeRentSol: oneTimeSol,
      peakRequirementSol: peakSol,
      note: 'Rent is recoverable by closing the accounts, except that closing the programs is irreversible in practice. Add transaction fees and a working balance on top.',
      wormholeMessageFeeLamports: messageFeeLamports,
      perOutboundTransfer: `${messageFeeLamports} lamports to the Wormhole fee collector, plus the payer's transaction fees, for each published transfer.`,
      quoteInventory: 'NTT moves the canonical token only. USDC pool inventory and SOL for gas have to be pre-positioned separately; SVM CCTP is a separate decision and stays closed.',
    },
    limits: {
      outbound: 'set to the approved ceiling with `set_outbound_limit`; it refills over 24 hours',
      inbound: 'set per peer chain with `set_inbound_limit`. A claim above the limit is queued, not lost, and cannot be released before its timestamp. The rehearsal exercises exactly this.',
      threshold: '1 authenticated Wormhole transceiver. That relies on Guardian verification, not on one Guardian.',
    },
    recovery: [
      'A claim approved but not released survives a crash: it is an on-chain inbox item addressed by the message digest. Re-run `release_inbound_mint`; a second release is refused as TransferAlreadyRedeemed.',
      'A debit whose message was never published leaves an outbox item. Re-run `release_wormhole_outbound` with the same outbox item; a second publication is refused as MessageAlreadySent.',
      'A debit whose message was published and never credited stays backed on the hub as a pending claim. It is redeemed by delivering the same VAA; it is never re-issued.',
      '`set_paused` stops credits and debits without touching any balance. Pausing is also the precondition for moving the mint authority back out of the manager.',
      'A stranded upload buffer is recovered with `solana program close --buffers`. Do that before retrying a failed deploy, or the rent is lost.',
      'Losing the upgrade authority key means the programs can never be fixed; losing the owner key means peers, limits and pause can never be changed. Both need the approved custody and a tested recovery path before anything is funded.',
    ],
    blockers: [
      'Each deployment needs its own program ids: the pinned `declare_id!` values are the upstream defaults, so the programs must be rebuilt against freshly generated keypairs before any public deploy.',
      'No Arc hub exists. The peer addresses the rehearsal uses are generated for the run; a real `set_peer` needs the deployed Arc manager and transceiver addresses.',
      'The PumpSwap pool path is derived and closed. Opening it needs an approved index, creator, quote mint and quote inventory, and the current global config fees re-read at that moment.',
      'Wormhole publishes Solana devnet, not Solana testnet, for NTT token creation. A public rehearsal goes to devnet first.',
    ],
  }

  const out = join(ROOT, 'output/equilibrium')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `solana-deployment-preview-${cluster}.json`), `${JSON.stringify(preview, null, 2)}\n`)
  console.log(JSON.stringify(preview, null, 2))
}

await main()
