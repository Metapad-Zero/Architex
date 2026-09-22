export function DocsMetadata() {
  return (
    <div className="space-y-4">
      <p>
        A token's on-chain record can hold exactly one string beyond its name and symbol: an
        address pointing at a small file on IPFS, which in turn names an image. Everything you
        see on a token's page (description, image, website, X, Telegram) comes from that one
        file.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Why an IPFS address can be trusted</h3>
      <p>
        An IPFS address isn't a link to somewhere content happens to live right now, the way a
        normal URL is. It's a fingerprint of the exact bytes, computed from them directly. Swap
        even one character in the file and the address changes with it. That means nobody can
        quietly replace a token's description or image after the fact: not the creator, not the
        service that stores the file, not a gateway serving it back. Architex checks this on
        every read: the app computes the address of whatever bytes it's about to show and
        refuses to show them if they don't match what the token actually points at.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Why images get redrawn</h3>
      <p>
        An uploaded image is resized and re-encoded in your own browser before it's stored, which
        keeps it small enough to verify the same way as the text, and, as a side effect, strips
        anything hidden in the original file, including a photo's location data. Nothing about
        an image survives upload except what it looks like.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Permanence cuts both ways</h3>
      <p>
        The property that makes this trustworthy (nobody can change it later) is the same
        property that makes a mistake permanent. If Architex's own display shows something it
        shouldn't (a wrong link, an image that shouldn't be shown), the only remedy is to stop
        showing that specific file on this site. That doesn't delete it from IPFS, and it doesn't
        touch the token itself, which keeps trading exactly as it did before. See{' '}
        <span className="font-semibold">Risks</span> for what does and doesn't get taken down,
        and why.
      </p>
    </div>
  )
}
