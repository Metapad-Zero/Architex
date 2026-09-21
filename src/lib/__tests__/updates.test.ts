import { describe, expect, test } from 'bun:test'
import { isUnread, latestId, PRODUCT_UPDATES, visibleUpdates } from '../updates'

describe('product updates', () => {
  test('newest item is the latest id', () => {
    expect(latestId(PRODUCT_UPDATES)).toBe('creator-fees')
  })

  test('hides the launch items when the Launch view is off', () => {
    const items = visibleUpdates(false)
    expect(items.some((item) => item.requiresLaunch)).toBe(false)
    expect(items.map((item) => item.id)).toEqual(['docs', 'bridge'])
  })

  test('keeps the launch items when the Launch view is on, creator fees first', () => {
    expect(visibleUpdates(true).map((item) => item.id)).toEqual(['creator-fees', 'docs', 'bridge', 'launch'])
  })

  test('is unread when nothing has been dismissed', () => {
    expect(isUnread(visibleUpdates(true), undefined)).toBe(true)
  })

  test('is read once the latest id has been stored', () => {
    const items = visibleUpdates(true)
    expect(isUnread(items, latestId(items))).toBe(false)
  })

  test('comes back for everyone who dismissed the stack before creator fees shipped', () => {
    expect(isUnread(visibleUpdates(true), 'docs')).toBe(true)
    expect(isUnread(visibleUpdates(true), 'launch')).toBe(true)
  })

  test('stays read where the Launch view is still off, so nothing reappears until v1.3 is live', () => {
    expect(isUnread(visibleUpdates(false), 'docs')).toBe(false)
  })
})
