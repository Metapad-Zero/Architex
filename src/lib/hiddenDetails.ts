/**
 * Details files the app will not show, by their address.
 *
 * A launch's details are permanent: the file is content-addressed and the launchpad keeps its address
 * for good. When a file should not be displayed (a link to an account that is not what it claims, an
 * image that should not be shown), this is the switch. It is a display decision only: the token and its
 * market are untouched, and it still shows its stamp, name and symbol, which come from the chain.
 * An address names content, not a copy of it, so pinning the same file again does not get round this.
 *
 * Read by the app before it fetches anything, and by our own file server before it serves anything.
 */
export const HIDDEN_DETAILS: ReadonlySet<string> = new Set([
  // "Arch Test" (0xd13a5676Acf317CDC2f8773982636Bc2653aEBE2, Arc Testnet): a test launch made while setting up
  // details. Its X link names @architex, which is not the project's account (the project is @architexdex).
  'bafkreihn7n5m36k76bvaa6p2xs5zv4qcjvjtf2ngxlmtma27fklpnewu44',
])

export function isHiddenDetails(cid: string): boolean {
  return HIDDEN_DETAILS.has(cid)
}
