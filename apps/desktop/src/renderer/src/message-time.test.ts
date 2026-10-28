import { describe, expect, it } from 'vitest'
import { messageTimeParts } from './message-time'

describe('message timestamp labels', () => {
  const today = new Date(2026, 9, 27, 21)
  const sentAt = new Date(2026, 9, 27, 20, 51, 18).toISOString()

  it('uses a simple locale clock for today and keeps seconds in the full timestamp', () => {
    const chinese = messageTimeParts(sentAt, 'zh-CN', today)!
    const english = messageTimeParts(sentAt, 'en', today)!
    expect(chinese.short).toBe('20:51')
    expect(english.short).toBe('8:51 PM')
    expect(chinese.full).toContain('2026')
    expect(chinese.full).toContain('20:51:18')
    expect(english.full).toContain('Oct 27, 2026')
    expect(english.full).toContain('8:51:18 PM')
  })

  it('adds the local date across midnight and the year only across calendar years', () => {
    const previousDay = new Date(2026, 9, 26, 23, 58).toISOString()
    expect(messageTimeParts(previousDay, 'en', today)?.short).toBe('Oct 26, 11:58 PM')
    expect(messageTimeParts(previousDay, 'zh-CN', today)?.short).toBe('10/26 23:58')
    const previousYear = new Date(2025, 11, 31, 23, 56).toISOString()
    expect(messageTimeParts(previousYear, 'en', today)?.short).toBe('Dec 31, 2025, 11:56 PM')
    expect(messageTimeParts(previousYear, 'zh-CN', today)?.short).toBe('2025/12/31 23:56')
    const afterMidnight = new Date(2026, 9, 28, 0, 1)
    expect(messageTimeParts(sentAt, 'en', afterMidnight)?.short).toBe('Oct 27, 8:51 PM')
  })

  it('uses the viewer local day even when the stored ISO date differs, and handles midnight/noon', () => {
    for (const [hour, chinese, english] of [[0, '00:02', '12:02 AM'], [12, '12:02', '12:02 PM']] as const) {
      const local = new Date(2026, 9, 27, hour, 2)
      // An equivalent timestamp in another offset can have a different calendar date.
      const shifted = new Date(local.getTime() - 12 * 60 * 60_000).toISOString().replace('Z', '-12:00')
      expect(messageTimeParts(shifted, 'zh-CN', today)?.short).toBe(chinese)
      expect(messageTimeParts(shifted, 'en', today)?.short).toBe(english)
    }
  })

  it('does not render a timestamp for missing or invalid dates', () => {
    for (const value of ['', 'unknown', '2026-99-99']) {
      expect(messageTimeParts(value, 'en', today)).toBeNull()
    }
  })
})
