export function DocsLaunching() {
  return (
    <div className="space-y-4">
      <p>
        Launching creates a new ERC-20 token, opens its curve, and (if you choose to) lets you
        buy some of it yourself in the same transaction, before anyone else can. Name and symbol
        are the only required fields. A description, an image, and links are optional, stored the
        same way described in <span className="font-semibold">Token details &amp; trust</span>.
      </p>
      <p>
        You also set the token's creator fee, from 0% to 10% of every buy and sell (it starts at
        0%), and where that fee goes: your wallet, another wallet, a Split, Buyback &amp; burn
        (paused for new launches for now), Distribute to holders, a Combo of those, or any
        address you paste. The builder checks a plugin's settings the way the plugin itself will, so a Split with a duplicate payee or a
        Combo that doesn't add up to 100% is caught before you sign. See{' '}
        <span className="font-semibold">Creator fees &amp; plugins</span> for what each one does.
        Your own first buy pays the creator fee like any other buy.
      </p>
      <p>
        Launching costs a flat USDC fee, currently 1 USDC, charged at creation. The form always
        shows the live number: it's a protocol setting, not something fixed in these docs, and
        it can change. The fee the form shows is the most the launch can charge you: if it went up
        between reading it and your transaction landing, the launch fails and costs you nothing
        but gas.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">What's permanent the moment you publish</h3>
      <p>
        A token's name and symbol are set in its contract and can never be changed by anyone,
        including its creator. The same goes for its creator fee and where the fee goes: there is
        no way to change either after launch, so a wrong address stays wrong for good. If you add a
        description, an image, or links, that file is stored
        by its own content address (a fingerprint of the exact bytes), and Architex has no
        mechanism to edit it afterward. Not a typo fix, not a swapped link, not a new image.
        Publishing a mistake means living with it publicly, or asking Architex to stop showing it
        on this site, which hides it here without deleting it from where it's stored. Read that
        twice before you click publish, not after.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">What you're promising buyers</h3>
      <p>
        Nobody at Architex checks a launch before it goes live. That's what permissionless means,
        and it cuts both ways: you don't need anyone's approval to launch, and buyers don't have
        anyone's approval standing behind what you told them. Whatever you write in the
        description and whatever links you attach are the whole of your reputation on this
        platform. See <span className="font-semibold">Risks</span> for what Architex will and
        won't do about a launch that turns out to be bad.
      </p>
    </div>
  )
}
