/**
 * The native popover calls throw on a detached element, on a repeated toggle, and (through the
 * `:popover-open` selector) in browsers without the API. A sheet that fails to open is an
 * inconvenience; an exception inside a React effect is a blank app. These never throw.
 */
export function showPopover(panel: HTMLElement | null): void {
  try {
    if (panel?.isConnected && 'showPopover' in panel && !panel.matches(':popover-open')) panel.showPopover()
  } catch {
    // The sheet stays closed; the trigger can be pressed again.
  }
}

export function hidePopover(panel: HTMLElement | null): void {
  try {
    if (panel?.isConnected && 'hidePopover' in panel && panel.matches(':popover-open')) panel.hidePopover()
  } catch {
    // Already closed.
  }
}
