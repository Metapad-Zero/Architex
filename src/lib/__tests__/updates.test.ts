import { describe, expect, test } from 'bun:test'
import { isUnread, latestId, PRODUCT_UPDATES, visibleUpdates } from '../updates'

describe('product updates', () => {
  test('newest item is the latest id', () => {
    expect(latestId(PRODUCT_UPDATES)).toBe('docs')
  })

  test('hides the launch item when the Launch view is off', () => {
    const items = visibleUpdates(false)
    expect(items.some((item) => item.id === 'launch')).toBe(false)
    expect(items.map((item) => item.id)).toEqual(['docs', 'bridge'])
  })

  test('keeps the launch item when the Launch view is on', () => {
    expect(visibleUpdates(true).some((item) => item.id === 'launch')).toBe(true)
  })

  test('is unread when nothing has been dismissed', () => {
    expect(isUnread(visibleUpdates(true), undefined)).toBe(true)
  })

  test('is read once the latest id has been stored', () => {
    const items = visibleUpdates(true)
    expect(isUnread(items, latestId(items))).toBe(false)
  })

  test('is unread again when a newer id ships', () => {
    expect(isUnread(visibleUpdates(true), 'launch')).toBe(true)
  })
})
