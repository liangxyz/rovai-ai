import assert from 'node:assert/strict'
import test from 'node:test'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { launchAcceptanceBrowser, pause } from './host-web-browser.mjs'

test('Memory workspace R4: production components, mutations, notifications and responsive layout', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rovai-memory-ui-'))
  const output = process.env.ROVAI_MEMORY_UI_OUTPUT ?? join(root, 'screenshots')
  await mkdir(output, { recursive: true })
  await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, '../fixtures/memory-workspace/build.mjs'), root])
  const chrome = process.env.ROVAI_TEST_CHROME ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')
  const b = await launchAcceptanceBrowser({ executable: chrome, args: ['--headless=new', `--user-data-dir=${join(root, 'profile')}`, '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'] })
  const report = { interactions: [], viewports: [] }
  const settle = () => pause(160)
  const click = async selector => { await b.click(`document.querySelector(${JSON.stringify(selector)})`); await settle() }
  const text = selector => b.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent`)
  const button = async (label, container = 'document') => {
    await b.click(`[...${container}.querySelectorAll('button,[role="menuitem"]')].find(e => e.textContent.trim() === ${JSON.stringify(label)})`); await settle()
  }
  const fill = async (selector, value) => { await b.evaluate(`(() => {const e = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true }));})()`); await settle() }
  const navigate = async target => { await b.evaluate(`__memoryFixture.navigate(${JSON.stringify({ kind: 'memory', memoryId: null, ...target })})`); await settle() }
  const closeEditor = () => button('取消', 'document.querySelector(".memory-editor-dialog")')
  const viewport = async (width, height) => { await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await settle() }
  const geometry = () => b.evaluate(`(() => {
    const rect = e => { const r = e.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom } };
    const revise = document.querySelector('[data-memory-revise]'), more = document.querySelector('.memory-more-button'), dot = document.querySelector('.rail-badge-dot');
    const row = dot?.closest('button'), dialog = document.querySelector('.memory-editor-dialog');
    return { overflow: document.documentElement.scrollWidth > innerWidth,
      detailOverflow: [...document.querySelectorAll('.memory-detail,.memory-library,.memory-editor-dialog .app-dialog-body')].some(e => e.scrollWidth > e.clientWidth + 1),
      revise: revise && rect(revise), more: more && rect(more), dot: dot && rect(dot), row: row && rect(row), dialog: dialog && rect(dialog),
      canvas: getComputedStyle(document.querySelector(".memory-content")).backgroundColor,
      primary: revise && getComputedStyle(revise).backgroundColor,
      selected: getComputedStyle(document.querySelector('.memory-catalog-item.selected') ?? document.querySelector('.memory-catalog-item')).backgroundColor
    };
  })()`)
  try {
    await b.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await viewport(1440, 920)
    await b.send('Page.navigate', { url: pathToFileURL(join(root, 'memory-workspace.html')).href })
    await b.wait('!!window.__memoryFixture && document.querySelectorAll(".memory-catalog-item").length === 7')
    assert.deepEqual(await b.evaluate('[...document.querySelectorAll(".memory-scope-tabs button")].map(e => e.textContent)'), ['全部', '共同', '队员', '队员间'])
    assert.match(await text('.memory-summary-strip'), /正在沿用6队员形成4待复核1/)
    assert.equal(await text('.memory-detail-body'), await b.evaluate('__memoryFixture.get().longBody'))
    assert.equal(await b.evaluate('!!document.querySelector(".memory-capacity-strip,.memory-governance-tabs")'), false)
    assert.equal(await b.evaluate('document.querySelector(".memory-detail-disclosure").open'), false)
    await click('.memory-detail-disclosure > summary'); await click('.memory-revisions > summary'); await click('.memory-revision > summary')
    assert.equal(await text('.memory-revision p'), await b.evaluate('__memoryFixture.get().longBody'))
    await click('.memory-detail-disclosure > summary')
    await navigate({ scope: 'all', governance: 'review' })
    assert.equal(await b.evaluate('document.querySelectorAll(".memory-catalog-item").length'), 7)
    await click('[data-memory-scope="companion"]'); assert.equal(await b.evaluate('document.querySelectorAll(".memory-catalog-item").length'), 2)
    await click('[data-memory-scope="all"]'); await fill('.memory-search input', '曾经')
    assert.match(await text('.memory-detail-body'), /曾经采用/)
    await fill('.memory-search input', '没有这个关键词'); assert.match(await text('.memory-catalog'), /没有找到/)
    await fill('.memory-search input', '')
    await click('.memory-notice-open'); assert.match(await text('.memory-detail-body'), /发送结果/)
    assert.equal(await b.evaluate('!!document.querySelector(".memory-change-notice")'), false)
    await b.evaluate('__memoryFixture.setNotice(true)'); await settle(); await click('.memory-notice-close')
    await navigate({ scope: 'all', memoryId: 'shared-1' }); await b.evaluate('__memoryFixture.setNotice(true)'); await settle()
    report.interactions.push('all scopes; legacy filter ignored; full content/history; search and retired record; truthful update notice view/dismiss')

    for (const [width, height] of [[1440,920],[1040,700],[375,812],[320,700],[740,390]]) for (const theme of ['day','night']) {
      await viewport(width,height); await b.evaluate(`__memoryFixture.setTheme('${theme}')`); await navigate({ scope: 'all', memoryId: width < 768 ? null : 'shared-1' })
      const list = await geometry(); assert.equal(list.overflow,false); assert.equal(list.detailOverflow,false)
      await b.capture(join(output, `memory-${theme}-${width}-list.png`))
      if (width < 768) await click('.memory-catalog-item')
      const g = await geometry(); assert.equal(g.overflow,false); assert.equal(g.detailOverflow,false)
      assert.ok(Math.abs(g.revise.y-g.more.y)<1); assert.equal(g.revise.height,g.more.height)
      if (g.dot) assert.ok(Math.abs(g.dot.y+g.dot.height/2-g.row.y-g.row.height/2)<1, 'pending dot vertically centered')
      for (const color of [g.primary,g.canvas,g.selected]) { const channels = color.match(/\d+/g).map(Number); assert.equal(Math.max(...channels)-Math.min(...channels),0, 'achromatic memory surfaces and actions') }
      await b.capture(join(output, `memory-${theme}-${width}-detail.png`))
      await click('[data-memory-revise]'); const e = await geometry()
      assert.equal(e.overflow,false); assert.equal(e.detailOverflow,false)
      assert.ok(e.dialog.x >= 0 && e.dialog.right <= width && e.dialog.y >= 0 && e.dialog.bottom <= height)
      await b.capture(join(output, `memory-${theme}-${width}-editor.png`)); await closeEditor()
      report.viewports.push({ width,height,theme,primary:g.primary,aligned:true,noOverflow:true })
    }
    await viewport(1440,920); await b.evaluate('__memoryFixture.setTheme("day")'); await navigate({ scope: 'all', memoryId: 'shared-1' })
    await click('[data-memory-revise]'); await fill('textarea', '未提交的修订草稿。'); await closeEditor(); await click('[data-memory-revise]')
    assert.equal(await b.evaluate('document.querySelector("textarea").value'), '未提交的修订草稿。')
    await fill('textarea','长'.repeat(700)); assert.equal(await b.evaluate('document.querySelector(".memory-editor-dialog button[type=submit]").disabled'),true)
    await fill('textarea','最终修订正文。'); await b.evaluate('__memoryFixture.failNext()'); await button('保存修订')
    assert.match(await text('.memory-editor-error'),/连接中断/)
    await b.evaluate('__memoryFixture.conflict()'); await button('保存修订')
    assert.match(await text('.memory-editor-error'),/版本已经变化/)
    assert.equal(await b.evaluate('document.querySelector("textarea").value'),'最终修订正文。')
    await b.capture(join(output,'editor-conflict.png')); await button('保存修订')
    assert.equal(await text('.memory-detail-body'),'最终修订正文。')
    await click('[data-memory-revise]'); assert.equal(await b.evaluate('document.querySelector("textarea").value'),'最终修订正文。'); await closeEditor()
    report.interactions.push('draft survives close; byte limit; inline transport failure; version conflict refresh preserves draft; explicit retry with new authority succeeds')

    await click('[data-memory-scope="all"]'); await button('新增')
    assert.equal(await b.evaluate('document.querySelector(".memory-editor-grid select").value'),'hearth')
    await fill('textarea','从全部新增的记忆。'); await fill('#memory-key-input','新建验证')
    await button('保存记忆'); await b.wait('!document.querySelector(".memory-editor-dialog")')
    assert.equal(await text('.memory-detail-body'),'从全部新增的记忆。')
    assert.deepEqual(await b.evaluate('__memoryFixture.get().calls.at(-1).command.retrievalKeys'),['新建验证'])
    await click('.memory-more-button'); await b.key('Escape'); await settle()
    assert.equal(await b.evaluate('document.activeElement.matches(".memory-more-button")'),true)
    await click('.memory-more-button'); await button('停止沿用')
    assert.match(await text('.memory-detail-context'),/已停止/)
    await button('重新沿用'); await click('.memory-more-button'); await button('设置下次复核')
    await b.wait('!!document.querySelector(".memory-review-schedule-dialog")')
    await b.capture(join(output,'review-schedule.png')); await button('取消', 'document.querySelector(".memory-review-schedule-dialog")')
    await click('.memory-more-button'); await button('永久遗忘'); await b.wait('!!document.querySelector(".memory-confirm-dialog")')
    await button('取消', 'document.querySelector(".memory-confirm-dialog")')
    assert.ok(await b.evaluate('__memoryFixture.get().memories.some(m => m.currentBody === "从全部新增的记忆。" && m.lifecycle === "active")'))
    await click('.memory-review-entry'); await b.wait('!!document.querySelector(".memory-review-drawer")')
    await b.capture(join(output,'review-drawer.png')); await button('接受', 'document.querySelector(".memory-review-drawer")')
    assert.match(await text('.memory-review-entry'),/审核记录/)
    assert.equal(await b.evaluate('__memoryFixture.get().reviews[0].candidateBody'),null)
    report.interactions.push('create from all targets new identity and submits typed keys; retire/reactivate; schedule; forget cancel; review acceptance and body-free history')
    await b.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
    await b.capture(join(output,'review-history-reduced-motion.png'))
    assert.deepEqual(b.errors,[])
    await writeFile(join(output,'report.json'),JSON.stringify(report,null,2))
    console.log(`Memory acceptance: ${report.interactions.length} interaction groups, ${report.viewports.length} viewport/theme combinations. ${output}`)
  } catch (error) {
    await b.capture(join(output,'failure.png')).catch(()=>{})
    console.error(await b.evaluate('document.body.innerText').catch(()=>''))
    throw error
  } finally { await b.close(); await rm(root,{recursive:true,force:true}) }
})
