import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { ThreadMessageAroundSnapshot, ThreadMessageView } from '@contracts'
import { useThreadClient } from './camp-client'
import { prefersReducedMotion } from './reduced-motion'

type ReturnPoint = { runId: string; scrollTop: number; topOffset: number }
type SourceState = {
  threadId: string
  messages: ThreadMessageView[]
  loading: string | null
  unavailable: ReadonlySet<string>
  error: string | null
  returnPoint: ReturnPoint | null
}
const emptyState = (threadId: string): SourceState => ({ threadId, messages: [], loading: null,
  unavailable: new Set(), error: null, returnPoint: null })

/** One bounded, user-requested source window. It never changes the Composer or Run. */
export function useRunSourceNavigation(threadId: string, messages: readonly ThreadMessageView[],
  viewportRef: RefObject<HTMLElement | null>) {
  const client = useThreadClient()
  const [state, setState] = useState(() => emptyState(threadId))
  const current = useRef({ threadId, messages })
  current.current = { threadId, messages }
  const generation = useRef(0)
  const highlight = useRef<{ element: HTMLElement; timer: ReturnType<typeof setTimeout> } | null>(null)
  const clearHighlight = useCallback(() => {
    if (!highlight.current) return
    clearTimeout(highlight.current.timer)
    highlight.current.element.classList.remove('run-source-located')
    highlight.current = null
  }, [])
  const cancel = useCallback(() => {
    generation.current++
    clearHighlight()
    setState(value => ({ ...value, loading: null, returnPoint: null }))
  }, [clearHighlight])
  useLayoutEffect(() => {
    setState(emptyState(threadId))
    return () => { generation.current++; clearHighlight() }
  }, [threadId, clearHighlight])

  const reveal = async (runId: string, messageId: string, displayed: ReadonlyMap<string, ThreadMessageView>): Promise<void> => {
    const viewport = viewportRef.current
    const origin = viewport?.querySelector<HTMLElement>(`[data-presence-run="${CSS.escape(runId)}"]`)
    if (!viewport || !origin) return
    const ticket = ++generation.current
    const valid = (): boolean => current.current.threadId === threadId && generation.current === ticket
    const returnPoint = { runId, scrollTop: viewport.scrollTop,
      topOffset: origin.getBoundingClientRect().top - viewport.getBoundingClientRect().top }
    clearHighlight()
    setState(value => ({ ...value, loading: messageId, error: null, returnPoint: null }))
    const unavailable = (): void => {
      if (valid()) setState(value => ({ ...value, loading: null,
        unavailable: new Set(value.unavailable).add(messageId) }))
    }
    try {
      let source = displayed.get(messageId)
      if (source?.withdrawn) { unavailable(); return }
      if (!source || !viewport.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)) {
        const result = await client.request<ThreadMessageAroundSnapshot>('thread.messages.around', { threadId, messageId })
        if (!valid()) return
        if (result.schemaVersion !== 1 || result.threadId !== threadId || result.anchorMessageId !== messageId) {
          throw new Error('source.owner_mismatch')
        }
        source = result.messages.find(message => message.id === messageId)
        if (!result.sourceAvailable || !source || source.withdrawn) { unavailable(); return }
        const latest = current.current.messages.find(message => message.id === messageId)
        if (latest?.withdrawn) { unavailable(); return }
        if (latest && latest.version > source.version) throw new Error('source.stale_window')
        setState(value => ({ ...value, messages: result.messages }))
      }
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      if (!valid()) return
      if (current.current.messages.find(message => message.id === messageId)?.withdrawn) { unavailable(); return }
      const target = viewport.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
      if (!target || !viewport.isConnected || viewport.clientHeight === 0) throw new Error('source.not_rendered')
      const bounds = target.getBoundingClientRect()
      const top = viewport.scrollTop + bounds.top - viewport.getBoundingClientRect().top
        - Math.max(18, (viewport.clientHeight - bounds.height) / 2)
      target.focus({ preventScroll: true })
      viewport.scrollTo({ top: Math.max(0, top), behavior: prefersReducedMotion() ? 'instant' : 'smooth' })
      target.classList.add('run-source-located')
      highlight.current = { element: target, timer: setTimeout(clearHighlight, 3000) }
      setState(value => ({ ...value, loading: null, returnPoint }))
    } catch {
      if (valid()) setState(value => ({ ...value, loading: null, error: messageId }))
    }
  }
  const returnToRun = (): void => {
    const point = state.threadId === threadId ? state.returnPoint : null
    cancel()
    const viewport = viewportRef.current
    if (!point || !viewport) return
    // Let the compositor cancel a smooth source jump before restoring; otherwise
    // its final queued frame can overwrite the immediate return scroll.
    viewport.scrollTo({ top: viewport.scrollTop, behavior: 'instant' })
    const ticket = generation.current
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (generation.current !== ticket || current.current.threadId !== threadId || !viewport.isConnected) return
      const origin = viewport.querySelector<HTMLElement>(`[data-presence-run="${CSS.escape(point.runId)}"]`)
      viewport.scrollTo({ top: Math.max(0, origin
        ? viewport.scrollTop + origin.getBoundingClientRect().top - viewport.getBoundingClientRect().top - point.topOffset
        : point.scrollTop), behavior: 'instant' })
      const focus = origin?.querySelector<HTMLElement>('.run-source-reference button, .run-presence-open') ?? viewport
      if (focus === viewport) viewport.tabIndex = -1
      else {
        const frame = viewport.getBoundingClientRect(), bounds = focus.getBoundingClientRect()
        const correction = bounds.top < frame.top + 18 ? bounds.top - frame.top - 18
          : bounds.bottom > frame.bottom - 18 ? bounds.bottom - frame.bottom + 18 : 0
        if (correction) viewport.scrollTo({ top: viewport.scrollTop + correction, behavior: 'instant' })
      }
      focus.focus({ preventScroll: true })
    }))
  }
  const visible = state.threadId === threadId ? state : emptyState(threadId)
  return { ...visible, reveal, cancel, returnToRun }
}
