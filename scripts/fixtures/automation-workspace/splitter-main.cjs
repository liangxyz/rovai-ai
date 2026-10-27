const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const { isAbsolute, join, dirname } = require('node:path')
const { app, BrowserWindow } = require('electron')
const [renderer, userData] = process.argv.slice(2)
assert.ok(isAbsolute(renderer) && isAbsolute(userData))
mkdirSync(join(userData, 'managed-skill-library'), { recursive: true })
app.setPath('userData', userData)
app.setPath('sessionData', join(userData, 'session'))

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: process.platform === 'linux', width: 1440, height: 920, useContentSize: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const errors = []
  window.webContents.on('console-message', event => { if (event.level >= 2) errors.push(event.message) })
  const run = code => window.webContents.executeJavaScript(code, true)
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const frame = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const wait = async expression => {
    for (let i = 0; i < 100; i++) { if (await run(expression)) return; await pause(20) }
    throw new Error(`Timed out: ${expression}`)
  }
  const geometry = () => run(`(() => {
    const editor = document.querySelector('.automation-editor'), handle = document.querySelector('.automation-splitter')
    const r = handle.getBoundingClientRect()
    return { width: editor.getBoundingClientRect().width, hidden: editor.hidden,
      list: document.querySelector('.automation-list').getBoundingClientRect().width,
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 200) }
  })()`)
  const near = (value, expected) => assert.ok(Math.abs(value - expected) < 2, `${value} != ${expected}`)
  let origin, pointer, pressed = false
  const mouse = (type, clickCount = 1) => {
    if (type === 'mouseDown') pressed = true
    if (type === 'mouseUp') pressed = false
    window.webContents.sendInputEvent({ type, ...pointer, button: 'left', clickCount, modifiers: pressed ? ['leftButtonDown'] : [] })
  }
  const begin = async () => {
    origin = await geometry(); pointer = { x: origin.x, y: origin.y }
    mouse('mouseMove'); mouse('mouseDown'); await frame()
    return origin
  }
  const move = async width => {
    pointer.x = Math.round(origin.x + origin.width - width)
    mouse('mouseMove'); await frame()
  }
  const release = async () => { mouse('mouseUp'); await frame() }
  const key = async keyCode => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await frame()
  }
  const reset = async () => {
    pointer = await geometry(); mouse('mouseMove'); mouse('mouseDown'); mouse('mouseUp'); await frame(); mouse('mouseDown', 2); mouse('mouseUp', 2); await frame()
  }
  const load = async () => {
    await window.loadFile(renderer)
    await wait('document.querySelector(".automation-task-open")')
    await run('document.querySelector(".automation-task-open").click()'); await frame()
    await wait('document.querySelector(".automation-name-input")')
  }
  const edit = async name => {
    await run(`(() => { const input = document.querySelector('.automation-name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(name)});
      input.dispatchEvent(new Event('input', {bubbles:true})); })()`)
    await frame()
  }
  const capture = async name => writeFileSync(join(dirname(userData), name + '.png'), (await window.webContents.capturePage()).toPNG())
  try {
    await load()
    near((await geometry()).list, 248)
    await begin(); await move(300); near((await geometry()).width, 320)
    await pause(400); near((await geometry()).width, 320)
    await release(); near((await geometry()).width, 320)
    await reset()
    const before = await begin(); await move(240)
    await pause(400); assert.equal((await geometry()).hidden, true, 'Further travel folds the detail while held')
    await move(300)
    assert.equal((await geometry()).hidden, false, 'Reversing restores the detail within the same held gesture')
    await move(480); near((await geometry()).width, 500)
    await key('Escape'); await release(); near((await geometry()).width, before.width)
    await begin(); await move(240); await release(); await pause(220)
    assert.equal((await geometry()).hidden, true, 'Fast release beyond the threshold folds without a dwell')
    await key('Enter'); near((await geometry()).list, 248)
    await begin()
    pointer.x = Math.round(origin.x + origin.width - 240)
    await release(); await pause(220)
    assert.equal((await geometry()).hidden, true, 'Final release coordinate folds even without a pointermove')
    await key('Enter')

    await run('window.automationSplitterTest.failSave()')
    await edit('保存失败时保留草稿')
    await begin(); await move(240); await pause(400)
    assert.equal(await run('window.automationSplitterTest.saveCount()'), 1, 'Folding while held first attempts to save')
    await move(220); await pause(100)
    assert.equal(await run('window.automationSplitterTest.saveCount()'), 1, 'A failed save is not retried while pushing at the same boundary')
    await release(); await pause(250)
    assert.equal((await geometry()).hidden, false)
    near((await geometry()).width, 320)
    assert.equal(await run('document.querySelector(".automation-name-input").value'), '保存失败时保留草稿')
    const failedSaves = await run('window.automationSplitterTest.saveCount()')
    assert.equal(failedSaves, 1)
    await pause(250)
    assert.equal(await run('window.automationSplitterTest.saveCount()'), failedSaves, 'A rejected fold does not repeatedly retry saving')
    await capture('automation-save-failure')

    await load()
    await run('window.automationSplitterTest.holdSave()')
    await edit('延迟保存可以取消折叠')
    const original = await begin(); await move(240); await release()
    await wait('window.automationSplitterTest.saveCount() === 1')
    await key('Escape')
    await run('window.automationSplitterTest.releaseSave()'); await pause(400)
    assert.equal((await geometry()).hidden, false, 'A late save response cannot revive a cancelled fold')
    near((await geometry()).width, original.width)

    await run('window.automationSplitterTest.theme("night")'); await frame()
    assert.equal(await run('getComputedStyle(document.documentElement).colorScheme'), 'dark')
    await capture('automation-night')
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await begin(); await move(240)
    await pause(230); assert.equal((await geometry()).hidden, true, 'System reduced motion folds while held without animation')
    await release(); assert.equal((await geometry()).hidden, true)
    await key('Enter')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    await run('document.documentElement.dataset.motionPreference="reduce"')
    await begin(); await move(240)
    await pause(230); assert.equal((await geometry()).hidden, true, 'The App motion preference also folds while held without animation')
    await release(); assert.equal((await geometry()).hidden, true)
    // Naming is withdrawn from every editor surface, including saved definitions.
    await load()
    assert.equal(await run('document.querySelector(".automation-naming")'), null)
    assert.equal(await run('document.querySelector(".automation-name-input").value'), 'Issue / PR 巡检')
    for (const palette of ['day', 'night', 'horizon', 'classic-red', 'ember']) {
      await run(`window.automationSplitterTest.palette(${JSON.stringify(palette)})`); await frame()
      await capture(`automation-editor-${palette}`)
    }
    await run('window.automationSplitterTest.palette("day")')
    await begin(); await move(300); await release()
    await capture('automation-editor-minimum')
    await reset()
    window.webContents.setZoomFactor(1.25); await frame()
    await capture('automation-editor-zoom')
    window.webContents.setZoomFactor(1)
    window.setContentSize(700, 900); await frame()
    await capture('automation-editor-narrow')
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ ok: true, checks: ['stable minimum and release', 'held confirmation and reversal', 'Escape', 'fast release',
      'release without pointermove', 'keyboard restore', 'save failure preserves draft without retry loop', 'late save fenced after cancellation', 'night', 'system and App reduced motion', 'naming controls hidden, editor themes and widths'] }))
    window.destroy(); app.quit()
  } catch (error) {
    await capture('failure'); console.error(error); console.error(errors); window.destroy(); app.exit(1)
  }
})
