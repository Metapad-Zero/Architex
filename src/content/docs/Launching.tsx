export function DocsLaunching() {
  return (
    <div className="space-y-4">
      <p>
        Launching creates a new ERC-20 token, opens its curve, and — if you choose to — lets you
        buy some of it yourself in the same transaction, before anyone else can. Name and symbol
        are the only required fields. A description, an image, and links are optional, stored the
        same way described in <span className="font-semibold">Token details &amp; trust</span>.
      </p>
      <p>
        Launching costs a flat USDC fee, currently 1 USDC, charged at creation. The form always
        shows the live number — it's a protocol setting, not something fixed in these docs, and
        it can change.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">What's permanent the moment you publish</h3>
      <p>
        A token's name and symbol are set in its contract and can never be changed by anyone,
        including its creator. If you add a description, an image, or links, that file is stored
        by its own content address — a fingerprint of the exact bytes — and Architex has no
        mechanism to edit it afterward. Not a typo fix, not a swapped link, not a new image.
        Publishing a mistake means living with it publicly, or asking Architex to stop showing it
        on this site, which hides it here without deleting it from where it's stored. Read that
        twice before you click publish, not after.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">What you're promising buyers</h3>
      <p>
        Nobody at Architex checks a launch before it goes live. That's what permissionless means,
        and it cuts both ways — you don't need anyone's approval to launch, and buyers don't have
        anyone's approval standing behind what you told them. Whatever you write in the
        description and whatever links you attach are the whole of your reputation on this
        platform. See <span className="font-semibold">Risks</span> for what Architex will and
        won't do about a launch that turns out to be bad.
      </p>
    </div>
  )
}
