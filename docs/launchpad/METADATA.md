# Token details (metadata)

The launchpad stores **one string** per token, at most 256 bytes, fixed at creation. That string is
`ipfs://<cid>`: the address of a small JSON file. The file names the token's image the same way.

```
on-chain   ipfs://bafkrei…            (66 bytes)
             └─ JSON file              name, symbol, description, image, external_link, twitter, telegram
                  └─ ipfs://bafkrei…   the image, at most 256 KB
```

## Why it can be trusted

An IPFS address is a fingerprint of the content. Both files are kept to one IPFS block (256 KiB), and
the address of a one-block file is just a framed SHA-256 of its bytes (`src/lib/cid.ts`). So:

- **Nobody can swap it after launch.** Not the creator, not the pinning service, not a gateway, not us.
  The app hashes whatever a gateway returns and compares it with the address before using it. Pinata's
  own gateways have a "hot swap" feature that maps one address to other content; the check defeats it.
- **The server is not trusted either.** The browser builds the same file, works out the address it must
  have, and refuses an answer that names any other (`src/lib/saveDetails.ts`).
- **Creators cannot track visitors.** Nothing is ever loaded from a host a creator chose. Images are
  fetched from gateways we pick, verified, and shown as `blob:` URLs. The earlier design loaded any
  `https` image URL, which let one creator log the IP of every visitor to the launch list.
- **Addresses the app cannot verify are ignored.** Older `Qm…` addresses, chunked files (`bafybei…`),
  paths and gateway links are not displayed. The token still shows its stamp, name and symbol, which
  always come from the chain, never from the file.

## The file

Written in one fixed key order with no spare whitespace, so the same details always give the same
bytes and the same address. Field names follow ERC-7572 plus the `twitter` / `telegram` keys other
launchpad tooling uses; `website` is accepted as an alias when reading.

| Field | Rule |
| --- | --- |
| `name`, `symbol` | Informational. The app shows the on-chain values |
| `description` | Plain text, 280 characters, no control characters |
| `image` | `ipfs://` + a one-block address. PNG, JPEG, WebP or GIF by its byte signature; SVG refused |
| `external_link` | A plain `https` link: no credentials, no port. Shown as its real host, in punycode |
| `twitter` | Always `https://x.com/<handle>` |
| `telegram` | Always `https://t.me/<name>` |

Everything in a file is a stranger's input. A field that fails its rule is dropped; the rest survives.
Links open with `rel="noopener noreferrer nofollow ugc"`, and the page says the text is the creator's.

Images are redrawn in the creator's browser to at most 512px and re-encoded (`src/lib/prepareImage.ts`).
That keeps them in one block, and it means a photo's EXIF data, including its GPS position, never
leaves their machine.

## Set-up (owner)

1. In Pinata, create an API key limited to **Files: Write** and **Files: Read**. Not an Admin key.
   Of the three values it shows, only the **JWT** is used.
2. Add it to Vercel yourself. Never paste it into chat, the repository or `.env.local`:

   ```bash
   vercel env add PINATA_JWT production
   ```

3. Optional but recommended: your gateway host (Pinata → Gateways, `some-words-123.mypinata.cloud`).
   It is not a secret. It makes a new launch's image appear at once instead of when the public
   gateways find it:

   ```bash
   vercel env add IPFS_GATEWAY production
   ```

4. Redeploy. `GET /api/metadata` then answers `{"enabled":true,…}` and the create form shows its
   Details fields. Until then the form offers name and symbol only, and everything else works.

## Pieces

| | |
| --- | --- |
| `src/lib/cid.ts` | One-block addresses: compute, parse, verify. Tested against IPFS's well-known addresses |
| `src/lib/tokenMetadata.ts` | The format: canonical writer, strict reader, link cleaning, image sniffing |
| `src/lib/ipfs.ts` | Verified reads through gateways: size cap, timeout, hash check, fallbacks |
| `src/lib/prepareImage.ts`, `saveDetails.ts` | The creator's side: resize and re-encode, save, check the answer |
| `server/metadataService.ts` | The upload service. Same-origin JSON only, size caps, byte sniffing, a per-address limit; it rebuilds the file from checked fields and only reports a verified address |
| `server/pinata.ts` | The pinning provider. Swapping providers means writing this one file |
| `api/metadata.ts` | The Vercel function. Imports carry `.js` extensions because Vercel runs native Node modules |
| `server/devMetadata.ts` | `vite dev` only: an in-memory pinning service and `/ipfs/` gateway, so the whole flow runs locally with no key |
| `scripts/metadata-cleanup.ts` | Lists pinned files no token points to; unpins them only with `--delete` |

## Abuse

Anyone can call the upload endpoint. It accepts little, and an upload is worth nothing without a launch,
which costs the launch fee. The per-address limit is best effort (each server instance counts for itself).
If the endpoint is ever hammered, add a rate-limit rule in Vercel's firewall for `POST /api/metadata`;
orphaned files are found and removed with the cleanup script. Moderation is a display decision in the
app (hide an image or a description), never a change to the token, which stays permissionless.

## Not done

- Details cannot be edited after launch. That is deliberate; it is what makes them trustworthy.
- The token contract does not expose its own `contractURI()` (ERC-7572). Adding it would let explorers
  describe a token without knowing the launchpad, but it touches reviewed code and needs a redeploy.
- A `tokenlist.json` of graduated tokens, which is where wallets read logos from.
