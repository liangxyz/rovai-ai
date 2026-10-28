import { useEffect, useState } from 'react'
import type { InterfaceLanguage } from '@contracts'

const formatters = new Map<InterfaceLanguage, {
  clock: Intl.DateTimeFormat
  date: Intl.DateTimeFormat
  year: Intl.DateTimeFormat
  full: Intl.DateTimeFormat
}>()

/** Message metadata uses the interface language and the viewer's local calendar. */
export function messageTimeParts(value: string, language: InterfaceLanguage, today = new Date()): {
  short: string
  full: string
} | null {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const english = language === 'en'
  let formats = formatters.get(language)
  if (!formats) {
    const locale = english ? 'en-US' : 'zh-CN'
    const clock: Intl.DateTimeFormatOptions = {
      hour: english ? 'numeric' : '2-digit', minute: '2-digit', hour12: english
    }
    formats = {
      clock: new Intl.DateTimeFormat(locale, clock),
      date: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }),
      year: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }),
      full: new Intl.DateTimeFormat(locale, {
        ...clock, year: 'numeric', month: english ? 'short' : 'numeric', day: 'numeric',
        second: '2-digit', timeZoneName: 'short'
      })
    }
    formatters.set(language, formats)
  }
  const sameYear = date.getFullYear() === today.getFullYear()
  const sameDay = sameYear && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  const clock = formats.clock.format(date).replace(/\s+/g, ' ')
  const calendar = english
    ? (sameYear ? formats.date : formats.year).format(date)
    : `${sameYear ? '' : `${date.getFullYear()}/`}${date.getMonth() + 1}/${date.getDate()}`
  return {
    short: sameDay ? clock : `${calendar}${english ? ', ' : ' '}${clock}`,
    full: formats.full.format(date).replace(/\s+/g, ' ')
  }
}

/** One calendar timer per workspace; an idle open Thread also rolls over at midnight. */
export function useMessageTimeDate(): Date {
  const [today, setToday] = useState(() => new Date())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = (): void => {
      clearTimeout(timer)
      const now = new Date()
      setToday(current => current.toDateString() === now.toDateString() ? current : now)
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
      timer = setTimeout(refresh, midnight.getTime() - now.getTime())
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])
  return today
}
