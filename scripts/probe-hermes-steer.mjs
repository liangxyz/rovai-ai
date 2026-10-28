// Acceptance-only official ACP probe. No Core, upstream patch or production control channel.
// node scripts/probe-hermes-steer.mjs <official-v0.22.4-source> <prepared-python> [--real-model]
import assert from 'node:assert/strict'
import {spawn, execFileSync} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {cp, mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises'
import {homedir, tmpdir} from 'node:os'
import {isAbsolute, join} from 'node:path'
import {createInterface} from 'node:readline'
import {DatabaseSync} from 'node:sqlite'
import {parse} from 'yaml'

const [officialSource, python, option] = process.argv.slice(2)
assert([officialSource, python].every(p => p && isAbsolute(p)))
assert(!option || option === '--real-model')
const realModel = option === '--real-model'
const root = await realpath(await mkdtemp(join(tmpdir(), 'rovai-hermes-steer-')))
const userHome = join(root, 'user'), nativeHome = join(userHome, '.hermes')
const project = join(root, 'project'), source = join(root, 'hermes-agent')
for (const dir of [nativeHome, project]) await mkdir(dir, {recursive: true, mode: 0o700})
execFileSync('git', ['clone', '--shared', '--no-hardlinks', officialSource, source], {stdio: 'pipe'})
await cp(join(officialSource, 'install-stamp.json'), join(source, 'install-stamp.json'))
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: source, encoding: 'utf8'}).trim()
assert.equal(execFileSync('git', ['describe', '--tags', '--exact-match'], {cwd: source, encoding: 'utf8'}).trim(), 'v0.22.4')
const sh = s => "'" + s.replaceAll("'", "'\\''") + "'"
const hash = s => createHash('sha256').update(s).digest('hex')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const exists = async path => {try {await readFile(path); return true} catch {return false}}
const alive = child => child && child.exitCode === null && child.signalCode === null
const cases = [], protocol = [], providerRequests = [], calls = new Map(), clients = []
let gateway, database, failure, gatewayLog = '', credential, provider, providerName = 'fixture', model = 'native-probe'
if (realModel) {
  const originalHome = join(homedir(), '.hermes')
  const config = parse(await readFile(join(originalHome, 'config.yaml'), 'utf8'))
  providerName = config.model.provider; model = config.model.default; provider = config.providers[providerName]
  assert.equal(provider.transport, 'codex_responses')
  const dotenv = Object.fromEntries((await readFile(join(originalHome, '.env'), 'utf8')).split('\n')
    .filter(line => line.includes('=') && !line.trim().startsWith('#'))
    .map(line => {const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]}))
  credential = process.env[provider.api_key_env] || dotenv[provider.api_key_env] || provider.api_key
  assert(credential && provider.base_url)
}
const waitScript = join(project, 'wait.py')
await writeFile(waitScript, `import pathlib,sys,time\np=pathlib.Path(__file__).parent\nlabel=sys.argv[1]\n(p/(label+'.ready')).write_text('ready')\nend=time.monotonic()+60\nwhile not (p/(label+'.release')).exists() and time.monotonic()<end: time.sleep(.05)\nassert (p/(label+'.release')).exists(), 'fixture gate timed out'\n(p/(label+'.done')).write_text('done')\nprint('fixture gate released')\n`)
const gateCommand = label => `python3 ${sh(waitScript)} ${sh(label)}`
const textItem = value => ({id: randomUUID(), type: 'message', role: 'assistant', status: 'completed',
  content: [{type: 'output_text', text: value, annotations: []}]})
function respond(res, body, item) {
  const id = 'response-' + randomUUID(), response = {id, object: 'response', status: 'completed', output: [item],
    usage: {input_tokens: 100, output_tokens: 10, total_tokens: 110}}
  if (!body.stream) {res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(response)); return}
  res.writeHead(200, {'content-type': 'text/event-stream'}); let sequence = 0
  const emit = event => res.write('data: ' + JSON.stringify({...event, sequence_number: sequence++}) + '\n\n')
  emit({type: 'response.created', response: {id, status: 'in_progress', output: []}})
  emit({type: 'response.output_item.added', output_index: 0, item})
  if (item.type === 'message') emit({type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text})
  emit({type: 'response.output_item.done', output_index: 0, item})
  emit({type: 'response.completed', response}); res.end()
}
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const bytes = Buffer.concat(chunks), body = bytes.length ? JSON.parse(bytes) : null
    if (!body) {res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({data: [{id: model, object: 'model'}]})); return}
    const input = JSON.stringify(body.input ?? []), label = [...input.matchAll(/STEER_CASE:(\w+)/g)].at(-1)?.[1] ?? null
    const main = Array.isArray(body.tools) && body.tools.length > 0
    const guidanceInInput = label !== null && input.includes('STEER_GUIDANCE:' + label)
    providerRequests.push({label, model: body.model, main, guidanceInInput, slashInInput: input.includes('/steer ')})
    assert(providerRequests.length <= (realModel ? 16 : 40), 'Probe request budget exceeded')
    if (realModel) {
      // Forward bytes unchanged. Credentials are held only here, never in the test Home or evidence.
      const upstream = await fetch(provider.base_url.replace(/\/$/, '') + req.url.replace(/^\/v1/, ''), {
        method: req.method, headers: {'content-type': 'application/json', authorization: 'Bearer ' + credential},
        body: bytes, signal: AbortSignal.timeout(180000)})
      assert(upstream.ok, `Real provider status ${upstream.status}`)
      res.writeHead(upstream.status, {'content-type': upstream.headers.get('content-type') || 'application/json'})
      for await (const chunk of upstream.body) res.write(chunk)
      res.end(); return
    }
    if (!main || !label) {respond(res, body, textItem('Isolated fixture.')); return}
    const count = calls.get(label) ?? 0; calls.set(label, count + 1)
    if (count === 0) respond(res, body, {id: randomUUID(), type: 'function_call', call_id: randomUUID(), name: 'terminal',
      arguments: JSON.stringify({command: gateCommand(label), timeout: 60}), status: 'completed'})
    else respond(res, body, textItem(`DONE_${label}${guidanceInInput ? '_GUIDANCE_SEEN' : ''}`))
  } catch (error) {failure ??= error; res.destroy(error)}
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const configPath = join(nativeHome, 'config.yaml')
await writeFile(configPath, JSON.stringify({model: {provider: providerName, default: model},
  providers: {[providerName]: {base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key_env: 'HERMES_STEER_PROBE_KEY',
    transport: 'codex_responses', models: [model], discover_models: false}},
  updates: {check: false}, platform_toolsets: {acp: ['terminal']}, session_title: {enabled: false},
  compression: {enabled: false}, agent: {max_turns: 8, reasoning_effort: 'low'}}), {mode: 0o600})
await writeFile(join(nativeHome, '.env'), 'HERMES_STEER_PROBE_KEY=loopback-only\n', {mode: 0o600})
const configHash = hash(await readFile(configPath))
const bootstrap = `import sys; sys.path.insert(0, ${JSON.stringify(source)}); sys._hermes_pin_default_home=True; import hermes_bootstrap; import runpy; runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)`
const launcher = join(root, 'hermes')
await writeFile(launcher, `#!/bin/sh\nexec ${sh(python)} -I -B -c ${sh(bootstrap)} "$@"\n`, {mode: 0o700})
const env = {HOME: userHome, HERMES_HOME: nativeHome, HERMES_DISABLE_LAZY_INSTALLS: '1',
  PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8'}
async function until(predicate, timeout = 120000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (failure) throw failure
    const value = await predicate(); if (value) return value
    await pause(50)
  }
  throw Error('Probe deadline exceeded')
}
async function stop(child) {
  if (!alive(child)) return
  child.kill('SIGTERM')
  const end = Date.now() + 5000
  while (alive(child) && Date.now() < end) await pause(50)
  if (alive(child)) {child.kill('SIGKILL'); while (alive(child)) await pause(50)}
}
function client() {
  const child = spawn(launcher, ['--profile', 'default', 'acp'], {cwd: project, env, stdio: ['pipe', 'pipe', 'pipe']})
  const pending = new Map(), received = new Map(), held = new Set(), deferred = new Map(), updates = []
  let serial = 0, stderr = ''
  child.stderr.on('data', bytes => {stderr = (stderr + bytes).slice(-12000)})
  createInterface({input: child.stdout}).on('line', line => {
    let message; try {message = JSON.parse(line)} catch {return}
    if (message.method === 'session/request_permission') {
      // This fixture can only run a gate in its own project, or the explicitly requested real-model output.
      const choice = message.params.options.find(o => o.kind === 'allow_once')
      assert(choice)
      child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result: {outcome: {outcome: 'selected', optionId: choice.optionId}}}) + '\n')
    }
    const update = message.params?.update
    if (update) {
      updates.push(message.params)
      protocol.push({direction: 'out', sessionId: message.params.sessionId, sessionUpdate: update.sessionUpdate,
        keys: Object.keys(update), steerNotice: update.content?.text?.startsWith('⏩ Steer queued for the active turn:') || undefined})
    }
    if (!('result' in message || 'error' in message)) return
    received.set(message.id, message)
    const waiter = pending.get(message.id); if (!waiter) return
    protocol.push({direction: 'out', id: message.id, method: waiter.method, resultKeys: Object.keys(message.result ?? {}),
      stopReason: message.result?.stopReason, errorCode: message.error?.code})
    const deliver = () => {pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message)}
    if (held.has(message.id)) deferred.set(message.id, deliver); else deliver()
  })
  child.on('exit', () => {
    for (const waiter of pending.values()) {clearTimeout(waiter.timer); waiter.resolve({error: {message: 'fixture client closed'}})}
    pending.clear()
  })
  const send = (method, params, hold = false) => {
    const id = ++serial; if (hold) held.add(id)
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {pending.delete(id); reject(Error(`ACP timeout: ${method}: ${stderr}`))}, 180000)
      pending.set(id, {method, resolve, timer})
    })
    protocol.push({direction: 'in', id, method, sessionId: params.sessionId})
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n')
    return {id, promise}
  }
  const request = async (method, params) => {
    const response = await send(method, params).promise
    assert(!response.error, JSON.stringify(response.error)); return response.result
  }
  const value = {send, request, updates, received, pending,
    release: id => {held.delete(id); deferred.get(id)?.(); deferred.delete(id)},
    close: async () => {child.stdin.end(); await stop(child)}, child}
  clients.push(value); return value
}
const prompt = (sessionId, value, extra = []) => ({sessionId, prompt: [{type: 'text', text: value}, ...extra]})
const admissionRows = sessionId => database.prepare('SELECT admission_id AS id, status, outcome, generation, payload_json FROM session_admissions WHERE target_session_id=? ORDER BY seq').all(sessionId)
const admissions = sessionId => admissionRows(sessionId).map(({payload_json, ...row}) => ({...row,
  attachments: JSON.parse(payload_json).attachments_v1?.media?.length ?? 0}))
const start = (viewer, sessionId, label, hold = false) => viewer.send('session/prompt', prompt(sessionId,
  `STEER_CASE:${label}\nThis is an isolated integration test. First execute exactly ${gateCommand(label)} using terminal with timeout 60. Wait for it to finish. ${realModel ? `Then write RED to ${sh(join(project, label + '.result'))}; later guidance may change the required value. Do not repeat the gate command.` : 'Then finish.'}`), hold)
const releaseGate = label => writeFile(join(project, label + '.release'), 'release')
const result = {schemaVersion: 1, version: '0.22.4', commit, mode: realModel ? 'real-model' : 'controlled-provider',
  probeSha256: hash(await readFile(new URL(import.meta.url))),
  transport: 'official ACP stdio to native shared Gateway', root, cases, providerRequests, protocol}
console.log(JSON.stringify({channel: 'isolated automatic acceptance; native ACP only, no Core or Desktop', root, nativeHome, project, commit, realModel}))
try {
  assert.match(execFileSync(launcher, ['--version'], {env, encoding: 'utf8'}), /0\.22\.4/)
  gateway = spawn(launcher, ['--profile', 'default', 'gateway', 'run', '--quiet'], {cwd: project, env, stdio: ['ignore', 'pipe', 'pipe']})
  gateway.stdout.on('data', bytes => {gatewayLog = (gatewayLog + bytes).slice(-20000)})
  gateway.stderr.on('data', bytes => {gatewayLog = (gatewayLog + bytes).slice(-20000)})
  await until(async () => {if (!alive(gateway)) throw Error(gatewayLog); return exists(join(nativeHome, 'gateway.lock'))})
  let viewer = client()
  await viewer.request('initialize', {protocolVersion: 1, clientCapabilities: {}})
  const created = await viewer.request('session/new', {cwd: project, mcpServers: []}), sid = created.sessionId
  database = new DatabaseSync(join(nativeHome, 'state.db'), {readOnly: true})
  const direct = await viewer.send('session/steer', {sessionId: sid, text: 'UNSUPPORTED_METHOD_PROBE'}).promise
  assert(direct.error); cases.push({name: 'no_dedicated_acp_method', errorCode: direct.error.code, admissions: admissions(sid)})
  for (const label of ['active', 'resumed']) {
    const expectedValue = label === 'active' ? 'GREEN' : 'BLUE'
    if (label === 'resumed') {
      await viewer.close(); assert(alive(gateway)); viewer = client()
      await viewer.request('initialize', {protocolVersion: 1, clientCapabilities: {}})
      await viewer.request('session/resume', {sessionId: sid, cwd: project, mcpServers: []})
    }
    const before = admissions(sid).length, original = start(viewer, sid, label)
    await until(() => exists(join(project, label + '.ready')))
    const updateStart = viewer.updates.length
    const steer = await viewer.request('session/prompt', prompt(sid,
      `/steer STEER_GUIDANCE:${label} ${realModel ? `After the gate finishes, write exactly ${expectedValue} to ${sh(join(project, label + '.result'))} instead of RED. Then finish.` : `Use ${expectedValue} instead of RED.`}`))
    assert.equal(steer.stopReason, 'end_turn')
    assert(viewer.pending.has(original.id), 'Steer response must precede the original terminal')
    const notices = viewer.updates.slice(updateStart).filter(u => u.update.content?.text?.startsWith('⏩ Steer queued for the active turn:'))
    assert.equal(notices.length, 1); assert.equal(admissions(sid).length, before + 1)
    await releaseGate(label)
    assert.equal((await original.promise).result?.stopReason, 'end_turn')
    assert(providerRequests.some(r => r.label === label && r.main && r.guidanceInInput))
    if (realModel) assert.equal((await readFile(join(project, label + '.result'), 'utf8')).trim(), expectedValue)
    cases.push({name: label, sessionId: sid, receipt: steer, noticeKeys: Object.keys(notices[0].update),
      sameAdmission: true, guidanceReachedModel: true, ...(realModel ? {fileResult: expectedValue} : {}), admissions: admissions(sid)})
    console.log('passed', label)
  }
  if (!realModel) {
    const raceSid = (await viewer.request('session/new', {cwd: project, mcpServers: []})).sessionId
    const original = start(viewer, raceSid, 'race', true)
    await until(() => exists(join(project, 'race.ready')))
    // Deterministic transport race: the original terminal is received by this probe but withheld
    // from the caller. Its local target still looks active when the next request reaches native ACP.
    await releaseGate('race'); await until(() => viewer.received.has(original.id))
    assert(viewer.pending.has(original.id))
    const late = viewer.send('session/prompt', prompt(raceSid, '/steer STEER_CASE:late Finish the isolated follow-up.'))
    await until(() => exists(join(project, 'late.ready')))
    assert.equal(admissions(raceSid).length, 2)
    viewer.release(original.id); assert.equal((await original.promise).result.stopReason, 'end_turn')
    await viewer.close(); assert(alive(gateway))
    await releaseGate('late')
    await until(() => admissions(raceSid).every(a => a.status === 'terminal'))
    assert(await exists(join(project, 'late.done')))
    await late.promise
    cases.push({name: 'ended_before_steer_with_delayed_terminal', localOriginalPendingAtSubmit: true,
      createdSuccessorAdmission: true, successorContinuedAfterAcpClosed: true, admissions: admissions(raceSid)})
    console.log('passed', 'ended_before_steer_with_delayed_terminal')
    viewer = client(); await viewer.request('initialize', {protocolVersion: 1, clientCapabilities: {}})
    const imageSid = (await viewer.request('session/new', {cwd: project, mcpServers: []})).sessionId
    const first = start(viewer, imageSid, 'imageoriginal')
    await until(() => exists(join(project, 'imageoriginal.ready')))
    const updateStart = viewer.updates.length
    const image = {type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aETsAAAAASUVORK5CYII='}
    const second = viewer.send('session/prompt', prompt(imageSid, '/steer STEER_CASE:imagefollowup Handle this image.', [image]))
    await until(() => admissions(imageSid).length === 2)
    const queued = admissions(imageSid)
    assert.equal(queued[0].status, 'started'); assert.equal(queued[1].status, 'queued'); assert.equal(queued[1].attachments, 1)
    await releaseGate('imageoriginal'); assert.equal((await first.promise).result?.stopReason, 'end_turn')
    await until(() => exists(join(project, 'imagefollowup.ready'))); await releaseGate('imagefollowup')
    assert.equal((await second.promise).result?.stopReason, 'end_turn')
    assert(!viewer.updates.slice(updateStart).some(u => u.update.content?.text?.startsWith('⏩ Steer queued for the active turn:')))
    assert(providerRequests.some(r => r.label === 'imagefollowup' && r.main))
    cases.push({name: 'image_bypasses_steer', queuedWhileOriginalStarted: queued,
      literalSlashReachedModel: providerRequests.some(r => r.label === 'imagefollowup' && r.main && r.slashInInput), admissions: admissions(imageSid)})
    console.log('passed', 'image_bypasses_steer')
  }
  assert.equal(hash(await readFile(configPath)), configHash)
  assert.equal(execFileSync('git', ['status', '--porcelain'], {cwd: source, encoding: 'utf8'}), '')
  result.passed = true; result.nativeConfigUnchanged = true; result.upstreamUnmodified = true
} catch (error) {
  result.passed = false; result.error = String(error)
  process.exitCode = 1
} finally {
  for (const label of ['active', 'resumed', 'race', 'late', 'imageoriginal', 'imagefollowup']) await releaseGate(label)
  for (const viewer of clients) await viewer.close()
  await stop(gateway)
  database?.close()
  await new Promise(done => server.close(done))
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  await writeFile(join(root, 'gateway.log'), gatewayLog, {mode: 0o600})
  console.log(JSON.stringify({passed: result.passed, cases: cases.length, evidence: join(root, 'result.json'), error: result.error}))
}
