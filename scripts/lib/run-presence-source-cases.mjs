import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pause } from './host-web-browser.mjs'

export async function verifyRunSources(b, out, report) {
  const row = '[data-presence-run="run-alice"]'
  const source = `${row} .run-source-reference`
  const quote = `${source} button.reply-parent-quote`
  const count = `${source} .execution-batch-count`
  const settle = () => pause(240)
  const show = async kind => { await b.evaluate(`__presence.showSourceCase('${kind}')`); await settle() }
  const reads = () => b.evaluate(`__presence.controls.executionReads.filter(read => read.method === 'thread.messages.around')`)
  const draft = () => b.evaluate('document.querySelector("[contenteditable=true]").textContent')
  const focused = id => b.wait(`document.activeElement?.dataset.messageId === '${id}'`)
  const returned = async () => { await b.click('.run-source-return'); await settle()
    assert.equal(await b.evaluate(`document.activeElement.matches('${quote}')`), true)
    assert.equal(await b.evaluate('!!document.querySelector(".run-source-return")'), false)
    const geometry = await b.evaluate(`(() => {
      const viewport = document.querySelector('.timeline-scroll').getBoundingClientRect();
      const entry = document.querySelector('${quote}').getBoundingClientRect();
      return { top: entry.top, bottom: entry.bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom };
    })()`)
    assert.ok(geometry.top >= geometry.viewportTop && geometry.bottom <= geometry.viewportBottom,
      `Returning must reveal its focused entry: ${JSON.stringify(geometry)}`)
  }
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 920, deviceScaleFactor: 1, mobile: false })
  await show('batch')
  assert.match(await b.evaluate(`document.querySelector('${quote}').textContent`), /你第一条原始输入/)
  assert.equal(await b.evaluate(`document.querySelector('${count}').textContent.trim()`), '2', 'Duplicate input IDs do not duplicate references')
  assert.equal((await reads()).length, 0, 'Rendering a source never eagerly fetches history')
  await b.evaluate(`__presence.showNarration('新的执行进展。')`); await settle()
  assert.match(await b.evaluate(`document.querySelector('${quote}').textContent`), /第一条原始输入/, 'Live progress and a later timeline anchor cannot replace the input')
  await b.click('[contenteditable=true]'); await b.send('Input.insertText', { text: '保留来源定位期间的草稿。' })
  const beforeDraft = await draft()
  await b.click(quote); await focused('source-first')
  assert.ok(await b.evaluate('document.activeElement.classList.contains("run-source-located")'))
  assert.equal(await draft(), beforeDraft)
  assert.equal((await reads()).length, 0, 'Already visible input needs no request')
  assert.equal(await b.evaluate('!!document.querySelector(".camp-detail-popover:not([hidden])")'), false)
  await returned()
  await b.click(count); await settle()
  assert.deepEqual(await b.evaluate('Array.from(document.querySelectorAll(".run-source-popover .execution-input-list strong")).map(e=>e.textContent)'), ['你', '奥黛丽'])
  await b.key('Escape'); await settle()
  assert.equal(await b.evaluate(`document.activeElement.matches('${count}')`), true)
  await b.key('Enter'); await settle()
  await b.click('.run-source-popover li:nth-child(2) button'); await focused('source-peer')
  assert.equal(await b.evaluate('!!document.querySelector(".run-source-popover")'), false)
  await returned()
  for (const theme of ['day', 'night']) {
    await b.evaluate(`__presence.setTheme('${theme}')`); await settle()
    await b.capture(join(out, `run-source-${theme}.png`))
    await b.click(count); await settle()
    await b.capture(join(out, `run-source-batch-${theme}.png`)); await b.key('Escape')
  }
  await b.evaluate('__presence.setTheme("day")')
  await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }); await settle()
  for (const selector of [quote, count]) {
    const size = await b.evaluate(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return [r.width,r.height] })()`)
    assert.ok(size[0] >= 44 && size[1] >= 44, 'Source controls retain coarse-pointer targets')
  }
  await b.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await settle()
  report.interactions.push('Frozen ordered Run inputs stay independent of progress/timeline position; batch deduplicates IDs and locates user or agent messages; Escape restores the count, selection focuses the source, return restores the execution entry and draft')

  await show('history')
  assert.equal((await reads()).length, 0)
  await b.click(quote); await focused('source-first')
  const historyReads = await reads()
  assert.equal(historyReads.length, 1)
  assert.equal(historyReads[0].messageId, 'source-first')
  assert.equal(historyReads[0].threadId, await b.evaluate('__presence.getState().snapshot.thread.id'))
  await returned()
  assert.equal(await draft(), beforeDraft)
  await b.click(quote); await focused('source-first')
  assert.equal((await reads()).length, 1, 'A loaded bounded source window is reused')
  await returned()
  await show('attachment')
  assert.match(await b.evaluate(`document.querySelector('${quote}').textContent`), /核对清单.txt/)
  await show('legacy')
  assert.equal(await b.evaluate(`document.querySelector('${source}').textContent`), '来源未记录')
  assert.equal(await b.evaluate(`document.querySelectorAll('${source} button').length`), 0)
  assert.equal((await reads()).length, 0, 'No source ID means no fabricated reference from the nearby anchor')
  await show('withdrawn')
  assert.equal(await b.evaluate(`document.querySelector('${source}').textContent`), '原消息不可用')
  assert.equal(await b.evaluate(`document.querySelectorAll('${source} button').length`), 0)
  await show('missing'); await b.click(quote)
  await b.wait(`document.querySelector('${source}').textContent === '原消息不可用'`)
  assert.equal(await b.evaluate('!!document.querySelector(".run-source-return")'), false)
  for (const failure of ['failNextSourceRead', 'wrongSourceOwner']) {
    await show('history'); await b.evaluate(`__presence.controls.${failure} = true`)
    await b.click(quote); await b.wait(`document.querySelector('${quote}').textContent.includes('原消息读取失败，重试')`)
    assert.equal(await b.evaluate('!!document.querySelector("[data-message-id=source-first]")'), false)
    await b.evaluate(`__presence.controls.${failure} = false`)
    await b.click(quote); await focused('source-first'); await returned()
  }
  report.interactions.push('Historical inputs use one explicit bounded around read and reuse it; attachment-only, missing/withdrawn and legacy sources stay honest; transient failures and wrong-owner responses are recoverable without mutating the Run')

  await show('batch-history'); await b.evaluate('__presence.controls.holdSourceRead = true')
  await b.click(quote); await b.wait(`document.querySelector('${source}').getAttribute('aria-busy') === 'true'`)
  await b.click(count); await b.click('.run-source-popover li:nth-child(2) button'); await focused('source-peer')
  await b.evaluate('__presence.controls.holdSourceRead = false'); await settle()
  assert.equal(await b.evaluate('!!document.querySelector("[data-message-id=source-first]")'), false, 'A superseded source read cannot mount its window')
  assert.equal(await b.evaluate('document.activeElement.dataset.messageId'), 'source-peer')
  await returned()
  await show('history'); await b.evaluate('__presence.controls.holdSourceRead = true')
  await b.click(quote); await b.wait(`document.querySelector('${source}').getAttribute('aria-busy') === 'true'`)
  const threadId = await b.evaluate('__presence.getState().snapshot.thread.id')
  await b.click('[data-thread-id="demo-thread-0"] .camp-nav-open')
  await b.evaluate('__presence.controls.holdSourceRead = false'); await settle()
  assert.equal(await b.evaluate('!!document.querySelector("[data-message-id=source-first], .run-source-return, .run-source-located")'), false)
  await b.click(`[data-thread-id="${threadId}"] .camp-nav-open`); await settle()
  assert.equal(await b.evaluate('!!document.querySelector("[data-message-id=source-first], .run-source-return")'), false)
  report.interactions.push('A newer source selection and thread switch invalidate in-flight reads, preventing stale windows, scroll changes and focus theft')
  await b.evaluate('__presence.controls.hiddenMessages = []; __presence.setScenario("stream")'); await settle()
  console.log('PASS execution source references: input identity, batch, history, fallback, retry, draft/focus and late-response isolation')
}
