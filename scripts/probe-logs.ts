import { createPublicClient, http, parseAbiItem } from 'viem'
import { arcTestnet } from 'viem/chains'
const c = createPublicClient({ chain: arcTestnet, transport: http('https://rpc.testnet.arc.io') })
const head = await c.getBlockNumber()
const pair = '0x02aF642cD63F193aa75Aee3de11999AF01247093'
for (const span of [500n, 2_000n, 10_000n]) {
  try {
    const logs = await c.getLogs({ address: pair, event: parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)'), fromBlock: head - span, toBlock: head })
    console.log('span', span.toString(), 'ok', logs.length)
  } catch (e) { const m = (e as Error).message; console.log('span', span.toString(), 'ERR:', m.split('\n').filter(l => /Details|message|error|range|limit|block/i.test(l)).slice(0,3).join(' | ').slice(0, 300)) }
}
// explorer API probe (blockscout-style)
for (const base of ['https://explorer.testnet.arc.io/api', 'https://testnet.arcscan.app/api']) {
  try {
    const r = await fetch(`${base}?module=logs&action=getLogs&address=${pair}&fromBlock=0&toBlock=latest&topic0=0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1`)
    const t = await r.text()
    console.log('explorer', base, r.status, t.slice(0, 200).replace(/\n/g,' '))
  } catch (e) { console.log('explorer', base, 'ERR', (e as Error).message.slice(0,100)) }
}
