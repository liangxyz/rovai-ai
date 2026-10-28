// Production Core + official, unmodified Hermes 0.22.4; no Desktop/daily data.
// node scripts/smoke-hermes-steer.mjs <official-source> <prepared-python> [--real-model]
import assert from 'node:assert/strict'
import {spawn, execFileSync} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtemp, mkdir, cp, symlink, readFile, writeFile, realpath} from 'node:fs/promises'
import {homedir, tmpdir} from 'node:os'
import {join, resolve, isAbsolute} from 'node:path'
import {randomUUID, createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {parse} from 'yaml'
import {startQualificationCore} from './lib/qualification-core.mjs'
import {composerDocumentForAddress} from './lib/create-configured-camp.mjs'

const [officialSource, python, option] = process.argv.slice(2)
assert([officialSource, python].every(p => p && isAbsolute(p)))
assert(!option || option === '--real-model')
const realModel = option === '--real-model', repository = resolve(import.meta.dirname, '..')
const root = await realpath(await mkdtemp(join(tmpdir(), 'rovai-hermes-core-steer-')))
const userHome = join(root, 'user'), nativeHome = join(userHome, '.hermes'), source = join(root, 'hermes-agent')
const data = join(root, 'data'), project = join(root, 'project'), log = join(root, 'acp.jsonl')
const sh = s => "'" + s.replaceAll("'", "'\\''") + "'"
const hash = s => createHash('sha256').update(s).digest('hex')
const exists = async p => {try {await readFile(p); return true} catch {return false}}
const pause = ms => new Promise(done => setTimeout(done, ms))
const alive = child => child && child.exitCode === null && child.signalCode === null
for (const p of [nativeHome, project, data, join(userHome, '.local/bin')]) await mkdir(p, {recursive: true, mode: 0o700})
await symlink(join(repository, 'target/debug/rovai'), join(userHome, '.local/bin/rovai'))
execFileSync('git', ['clone', '--shared', '--no-hardlinks', officialSource, source], {stdio: 'pipe'})
await cp(join(officialSource, 'install-stamp.json'), join(source, 'install-stamp.json'))
const nativeCommit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: source, encoding: 'utf8'}).trim()
assert.equal(execFileSync('git', ['describe', '--tags', '--exact-match'], {cwd: source, encoding: 'utf8'}).trim(), 'v0.22.4')
let core, gateway, db, nativeDb, failure, credential, provider, providerName = 'fixture', model = 'native-probe', gatewayLog = ''
const cases = [], requests = [], calls = new Map(), threads = new Set()
if (realModel) {
  const config = parse(await readFile(join(homedir(), '.hermes/config.yaml'), 'utf8'))
  providerName = config.model.provider; model = config.model.default; provider = config.providers[providerName]
  assert.equal(provider.transport, 'codex_responses')
  const dotenv = Object.fromEntries((await readFile(join(homedir(), '.hermes/.env'), 'utf8')).split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => {const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]}))
  credential = process.env[provider.api_key_env] || dotenv[provider.api_key_env] || provider.api_key
  assert(credential && provider.base_url)
}
// The gate is fixture-owned. Both real and controlled models execute it through native terminal.
const gate = join(project, 'gate.py')
await writeFile(gate, `import pathlib,sys,time\np=pathlib.Path(__file__).parent\nlabel=sys.argv[1]\n(p/(label+'.ready')).write_text('ready')\nend=time.monotonic()+180\nwhile not (p/(label+'.release')).exists() and time.monotonic()<end: time.sleep(.05)\nassert (p/(label+'.release')).exists(), 'fixture gate deadline'\nprint('GATE_RELEASED')\n`)
const gateCommand = label => `python3 ${sh(gate)} ${sh(label)}`
const sendCommand = label => `rovai send --public-only --body CORE_OK_${label}`
function respond(res, body, item) {
  const id = randomUUID(), output = {id, object: 'response', status: 'completed', output: [item], usage: {input_tokens: 100, output_tokens: 10, total_tokens: 110}}
  if (!body.stream) {res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(output)); return}
  res.writeHead(200, {'content-type': 'text/event-stream'}); let seq = 0
  const emit = event => res.write('data: ' + JSON.stringify({...event, sequence_number: seq++}) + '\n\n')
  emit({type: 'response.created', response: {id, status: 'in_progress', output: []}})
  emit({type: 'response.output_item.added', output_index: 0, item})
  if (item.type === 'message') emit({type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text})
  emit({type: 'response.output_item.done', output_index: 0, item}); emit({type: 'response.completed', response: output}); res.end()
}
const text = value => ({id: randomUUID(), type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: value, annotations: []}]})
const terminal = command => ({id: randomUUID(), type: 'function_call', call_id: randomUUID(), name: 'terminal', arguments: JSON.stringify({command, timeout: 180}), status: 'completed'})
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const c of req) chunks.push(c)
    const bytes = Buffer.concat(chunks), body = bytes.length ? JSON.parse(bytes) : null
    if (!body) {res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({data: [{id: model, object: 'model'}]})); return}
    const input = JSON.stringify(body.input ?? []), label = [...input.matchAll(/CORE_STEER_CASE:(\w+)/g)].at(-1)?.[1]
    const main = (body.tools?.length ?? 0) > 0
    requests.push({label, model: body.model, main, hasFirstCorrection: input.includes('CORRECTION_ONE'), hasSecondCorrection: input.includes('CORRECTION_TWO')})
    assert(requests.length <= (realModel ? 35 : 70), 'Provider request budget exceeded')
    if (realModel) {
      const upstream = await fetch(provider.base_url.replace(/\/$/, '') + req.url.replace(/^\/v1/, ''), {
        method: req.method, headers: {'content-type': 'application/json', authorization: 'Bearer ' + credential}, body: bytes, signal: AbortSignal.timeout(180000)})
      assert(upstream.ok, `Provider status ${upstream.status}`)
      res.writeHead(upstream.status, {'content-type': upstream.headers.get('content-type') || 'application/json'})
      for await (const c of upstream.body) res.write(c)
      res.end(); return
    }
    if (!main || !label) {respond(res, body, text('Fixture complete.')); return}
    const n = calls.get(label) ?? 0; calls.set(label, n + 1)
    if (n === 0 && !label.startsWith('ordinary')) {respond(res, body, terminal(gateCommand(label))); return}
    if (n === (label.startsWith('ordinary') ? 0 : 1)) {
      const value = input.includes('CORRECTION_TWO') && label === 'active' ? 'BLUE' : 'DONE'
      respond(res, body, terminal(`printf '%s' ${sh(value)} > ${sh(join(project, label + '.result'))}; ${sendCommand(label)}`)); return
    }
    respond(res, body, text('Completed.'))
  } catch (e) {failure ??= e; res.destroy(e)}
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const config = {model: {provider: providerName, default: model}, providers: {[providerName]: {
  base_url: `http://127.0.0.1:${server.address().port}/v1`, transport: 'codex_responses', api_key_env: 'STEER_FIXTURE_KEY', models: [model], discover_models: false}},
  updates: {check: false}, platform_toolsets: {acp: ['terminal']}, session_title: {enabled: false}, compression: {enabled: false}, agent: {max_turns: 12, reasoning_effort: 'low'}}
await writeFile(join(nativeHome, 'config.yaml'), JSON.stringify(config), {mode: 0o600})
await writeFile(join(nativeHome, '.env'), 'STEER_FIXTURE_KEY=loopback-only\n', {mode: 0o600})
const configHash = hash(await readFile(join(nativeHome, 'config.yaml')))
await writeFile(join(root, 'mcp.json'), '{"mcpServers":{}}')
// Test-only transport shim: delays a real terminal to create the end race. The
// native source is untouched; all ordinary and real-model frames pass unchanged.
const tap = join(root, 'transport.mjs')
await writeFile(tap, `import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {appendFileSync,writeFileSync} from 'node:fs';
const child=spawn(process.argv[2],process.argv.slice(3),{stdio:['pipe','pipe','inherit']}), requests=new Map();let held;
const log=o=>appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,...o})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),p=m.params||{},body=JSON.stringify(p.prompt||[]),steer=p.prompt?.[0]?.text?.startsWith('/steer '),label=[...body.matchAll(/CORE_STEER_CASE:(\\w+)/g)].at(-1)?.[1];
if(m.method)requests.set(m.id,{method:m.method,label,steer});log({direction:'in',id:m.id,method:m.method,label,steer,sessionId:p.sessionId});
if(steer&&label==='reject_follow'){if(held){process.stdout.write(held+'\\n');held=null}process.stdout.write(JSON.stringify({id:m.id,error:{code:-32602,message:'fixture pre-admission rejection'}})+'\\n');return}
child.stdin.write(line+'\\n');if(steer&&held){process.stdout.write(held+'\\n');held=null}});
createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line),r=requests.get(m.id),terminal=!m.method&&r?.method==='session/prompt';
log({direction:'out',id:m.id,method:m.method||r?.method,label:r?.label,steer:r?.steer,stopReason:m.result?.stopReason,errorCode:m.error?.code,update:m.params?.update?.sessionUpdate,sessionId:m.params?.sessionId||m.result?.sessionId});
if(terminal&&r.steer&&r.label==='lost_follow'){writeFileSync(${JSON.stringify(project)}+'/lost.dropped','dropped');child.kill('SIGTERM');return}
if(terminal&&!r.steer&&['race','cancelrace','lost','reject'].includes(r.label)){held=line;writeFileSync(${JSON.stringify(project)}+'/'+r.label+'.terminal-held','held');return}process.stdout.write(line+'\\n')});
process.stdin.on('end',()=>child.stdin.end());child.stdin.on('error',()=>{});child.on('exit',c=>process.exit(c??1));for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>child.kill(s));
`)
const launcher = join(root, 'hermes'), bootstrap = `import sys; sys.path.insert(0, ${JSON.stringify(source)}); sys._hermes_pin_default_home=True; import hermes_bootstrap; import runpy; runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)`
await writeFile(launcher, `#!/bin/sh\ncase "$*" in *' acp') exec ${sh(process.execPath)} ${sh(tap)} ${sh(python)} -I -B -c ${sh(bootstrap)} "$@";; *) exec ${sh(python)} -I -B -c ${sh(bootstrap)} "$@";; esac\n`, {mode: 0o700})
const env = {HOME: userHome, HERMES_HOME: nativeHome, HERMES_DISABLE_LAZY_INSTALLS: '1', PATH: `${join(userHome, '.local/bin')}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8'}
const options = {coreExecutable: join(repository, 'target/debug/rovai-core'), dataDirectory: data, workingDirectory: repository,
  runtimeCacheDirectory: join(root, 'runtime-cache'), mcpConfigPath: join(root, 'mcp.json'),
  environmentOverrides: {...Object.fromEntries(Object.keys(process.env).filter(k => k.startsWith('ROVAI_') || k.startsWith('HERMES_')).map(k => [k, undefined])), ...env, ROVAI_HERMES_BIN: launcher}}
const rows = (sql, ...args) => db.prepare(sql).all(...args)
const runRows = thread => rows('SELECT id,status,execution_epoch,last_error_code FROM agent_run WHERE camp_id=? ORDER BY rowid', thread)
const inputs = run => rows('SELECT id,status,input_kind,native_input_id,dispatch_started_at FROM runtime_input_delivery WHERE agent_run_id=? ORDER BY input_sequence', run)
async function until(fn, description, budget = 240000) {
  const end = Date.now() + budget
  while (Date.now() < end) {
    if (failure) throw failure
    if (core?.stderrTail.includes('panicked at')) throw Error(core.stderrTail)
    for (const threadId of threads) if (db && runRows(threadId).some(r => r.status === 'waiting')) {
      const snapshot = await core.request('threads.snapshot', {threadId})
      for (const approval of snapshot.approvals.filter(a => a.status === 'pending')) {
        const choice = approval.options.find(o => o.kind === 'allow_once'); assert(choice)
        await core.request('action.approvals.resolve', {commandId: randomUUID(), threadId, approvalId: approval.id, expectedVersion: approval.version, optionId: choice.optionId, reason: 'Isolated Hermes Steer fixture tools'})
      }
    }
    const result = await fn(); if (result) return result; await pause(100)
  }
  throw Error('Deadline: ' + description + '\n' + (core?.stderrTail ?? ''))
}
const release = label => writeFile(join(project, label + '.release'), 'release')
const marker = (label, suffix = 'ready') => until(() => exists(join(project, label + '.' + suffix)), label + '.' + suffix)
async function thread(name) {
  const r = await core.request('threads.create', {commandId: randomUUID(), name: 'Hermes Steer ' + name, workspace: {projectPath: project}, memberAgentIds: ['agent_2'], defaultLeadAgentId: 'agent_2', collaborationMode: 'peer'})
  assert.equal(r.status, 'applied'); threads.add(r.payload.threadId); return r.payload.threadId
}
async function send(threadId, label, mode = 'start', extra = '', attachments = []) {
  const target = runRows(threadId).find(r => r.status === 'running')
  const body = `CORE_STEER_CASE:${label}\nAuthorized isolated integration test. ${label.startsWith('ordinary') ? '' : `First execute exactly ${gateCommand(label)} with timeout 180 and wait for it. Do not modify the gate or create release files; the test controller releases it. Do not repeat it.`} Then write exactly DONE to ${sh(join(project, label + '.result'))}, then execute ${sendCommand(label)}. After Send succeeds, finish. Do not inspect credentials or modify settings. ${extra}`
  const result = await core.request('thread.messages.send', {commandId: randomUUID(), threadId,
    content: composerDocumentForAddress({mode: 'explicit', agentIds: ['agent_2']}, body), sourceAttachments: attachments, quotes: [], replyToThreadMessageId: null,
    deliveryMode: mode, steerTargets: target ? [{agentRunId: target.id, executionEpoch: target.execution_epoch}] : [], execution: {taskId: null, purpose: 'Hermes Steer acceptance', completionRole: 'required'}})
  assert.equal(result.commandResult.status, 'accepted', JSON.stringify(result)); return result.commandResult.payload.threadMessageId
}
async function correct(threadId, target, body, attachments = []) {
  const result = await core.request('thread.messages.send', {commandId: randomUUID(), threadId,
    content: composerDocumentForAddress({mode: 'explicit', agentIds: ['agent_2']}, body), sourceAttachments: attachments, quotes: [], replyToThreadMessageId: null,
    deliveryMode: 'steer', steerTargets: [{agentRunId: target.id, executionEpoch: target.execution_epoch}], execution: {taskId: null, purpose: 'Hermes Steer correction', completionRole: 'required'}})
  assert.equal(result.commandResult.status, 'accepted', JSON.stringify(result)); return result.commandResult.payload.threadMessageId
}
async function currentRun(threadId) {return until(() => runRows(threadId).find(r => r.status === 'running' && inputs(r.id)[0]?.status === 'accepted'), 'active Run with initial receipt')}
async function settled(threadId, id, status = 'succeeded') {
  const run = await until(() => runRows(threadId).find(r => r.id === id && ['succeeded','failed','cancelled'].includes(r.status)), 'Run terminal')
  assert.equal(run.status, status, JSON.stringify(run)); return run
}
function sent(threadId, label, runId) {
  const messages = rows("SELECT source_agent_run_id,author_id FROM camp_message WHERE camp_id=? AND body=? AND author_type='agent'", threadId, 'CORE_OK_' + label)
  assert.equal(messages.length, 1, 'exactly one CLI Send: ' + label); assert.equal(messages[0].source_agent_run_id, runId); assert.equal(messages[0].author_id, 'agent_2')
}
const report = {schemaVersion: 1, nativeVersion: '0.22.4', nativeCommit, realModel, root, cases, requests, transport: 'official ACP /steer, production Core, native shared Gateway'}
console.log(JSON.stringify({channel: 'isolated automatic acceptance', root, userHome, data, skillLibrary: join(data, 'managed-skill-library'), realModel}))
try {
  gateway = spawn(launcher, ['--profile','default','gateway','run','--quiet'], {cwd: project, env, stdio: ['ignore','pipe','pipe']})
  gateway.stdout.on('data', b => {gatewayLog = (gatewayLog + b).slice(-24000)}); gateway.stderr.on('data', b => {gatewayLog = (gatewayLog + b).slice(-24000)})
  await until(async () => {if (!alive(gateway)) throw Error(gatewayLog); return exists(join(nativeHome,'gateway.lock'))}, 'Gateway')
  core = startQualificationCore(options); await core.request('health.check')
  await until(async () => !(await core.request('runtime.status.get')).runtimeAvailability.some(r => r.runtimeKind === 'hermes-cli' && r.discovery.discoveryStatus === 'detecting'), 'discovery')
  await core.request('runtime.startup.save', {runtimeKind: 'hermes-cli', configuration: {programPath: launcher, environment: []}, expectedRevision: 0})
  const check = await core.request('runtime.product.check', {runtimeKind: 'hermes-cli'}); assert(check.ready, JSON.stringify(check))
  const installation = (await core.request('runtime.installations.list')).find(r => r.adapterKind === 'hermes-cli' && r.installationClass === 'managed_default')
  const member = await core.request('members.get', {agentId: 'agent_2'})
  assert.equal((await core.request('members.runtime.set', {commandId: randomUUID(), command: {agentId: 'agent_2', expectedVersion: member.version, adapterKind: 'hermes-cli', model: installation.memberRuntimeDefaults.model,
    permissions: {adapterKind: 'hermes-cli', schemaVersion: 1, values: {permission_mode: 'dont_ask'}}}})).status, 'applied')
  db = new DatabaseSync(join(data, 'rovai.sqlite'), {readOnly: true})
  const tid = await thread('active and resume')
  await send(tid, 'active'); await marker('active'); const first = await currentRun(tid)
  nativeDb = new DatabaseSync(join(nativeHome, 'state.db'), {readOnly: true})
  await correct(tid, first, 'CORRECTION_ONE: After the current gate completes, use GREEN instead of DONE in active.result. Do not run another gate. Keep the original public Send.')
  await until(() => inputs(first.id).filter(i => i.input_kind === 'steer' && i.status === 'accepted').length === 1, 'first correction receipt')
  const attachment = join(project, 'correction.txt'); await writeFile(attachment, 'CORRECTION_TWO: Use BLUE instead of GREEN or DONE in active.result. Keep the original public Send. Do not rerun the gate.')
  await correct(tid, first, 'CORRECTION_TWO: Read the attached instruction; apply it after the current gate.', [{id: randomUUID(), sourcePath: attachment, displayName: 'correction.txt', kind: 'file', mediaType: 'text/plain', observedByteSize: (await readFile(attachment)).length}])
  await until(() => inputs(first.id).filter(i => i.input_kind === 'steer' && i.status === 'accepted').length === 2, 'second correction receipt')
  await release('active'); await settled(tid, first.id); sent(tid, 'active', first.id)
  assert.equal((await readFile(join(project, 'active.result'), 'utf8')).trim(), 'BLUE')
  const session = rows('SELECT native_session_id FROM conversation WHERE camp_id=?', tid)[0].native_session_id
  cases.push({name: 'active_two_supplements_and_file_reference', run: first.id, inputs: inputs(first.id), result: 'BLUE', sendOwnedByRun: true}); console.log('passed active')
  for (const label of realModel ? ['race'] : ['race','cancelrace','lost','reject']) {
    const t = label === 'race' ? tid : await thread(label)
    await send(t, label); await marker(label); const run = await currentRun(t)
    await release(label); await marker(label, 'terminal-held')
    assert.equal(runRows(t).find(r => r.id === run.id).status, 'running')
    const supplementalMessage = await send(t, label + '_follow', 'steer')
    if (label === 'reject') {
      await settled(t, run.id)
      const next = await until(() => runRows(t).find(r => r.id !== run.id && r.status === 'running'), 'rejected input returned to queue')
      await marker(label + '_follow'); await release(label + '_follow'); await settled(t, next.id); sent(t, label + '_follow', next.id)
      assert.equal(inputs(run.id).find(i => i.input_kind === 'steer').status, 'not_accepted')
      cases.push({name: 'explicit_rejection_uses_normal_queue', inputs: inputs(run.id), nextRun: next.id}); console.log('passed reject'); continue
    }
    await marker(label + '_follow')
    assert.equal(runRows(t).find(r => r.id === run.id).status, 'running', 'Run must stay live across native fallback')
    assert(inputs(run.id).some(i => i.input_kind === 'steer' && i.dispatch_started_at))
    if (label === 'cancelrace') {
      const snapshot = await core.request('camps.open', {threadId: t, traceId: randomUUID()})
      const view = snapshot.agentRuns.find(r => r.id === run.id)
      const cancelled = await core.request('agentRuns.cancel', {commandId: randomUUID(), command: {threadId: t, agentRunId: run.id, expectedVersion: view.version}})
      assert.notEqual(cancelled.status, 'rejected'); await settled(t, run.id, 'cancelled'); await release(label + '_follow')
      // Only the test reads native state, to distinguish a business cancellation
      // from native completion. Production uses no extra Gateway/query channel.
      const sid = rows('SELECT native_session_id FROM conversation WHERE camp_id=?', t)[0].native_session_id
      await until(() => nativeDb.prepare("SELECT COUNT(*) AS n FROM session_admissions WHERE target_session_id=? AND status!='terminal'").get(sid).n === 0, 'native cancellation settlement')
      assert.equal(runRows(t).length, 1, 'cancel must not replay the supplemental input')
      assert.equal(rows("SELECT id FROM camp_message WHERE camp_id=? AND body=?", t, 'CORE_OK_' + label + '_follow').length, 0)
      await send(t, 'ordinary_after_cancel')
      const next = await until(() => runRows(t).find(r => r.id !== run.id && r.status === 'succeeded'), 'ordinary same-Session input after cancel')
      sent(t, 'ordinary_after_cancel', next.id)
      assert.equal(rows('SELECT native_session_id FROM conversation WHERE camp_id=?', t)[0].native_session_id, sid)
      cases.push({name: 'cancel_during_native_continuation', inputs: inputs(run.id), status: 'cancelled', gatewayAlive: alive(gateway), sameSessionNextRun: next.id, noAutomaticReplay: true}); console.log('passed cancel'); continue
    }
    if (label === 'race') await send(t, 'ordinary')
    await release(label + '_follow')
    await settled(t, run.id, label === 'lost' ? 'failed' : 'succeeded'); sent(t, label + '_follow', run.id)
    if (label === 'lost') {
      assert.equal(inputs(run.id).find(i => i.input_kind === 'steer').status, 'delivery_unknown')
      assert.equal(runRows(t).length, 1, 'unknown must not automatically replay')
    } else {
      assert.equal(inputs(run.id).find(i => i.input_kind === 'steer').status, 'accepted')
      const ordinary = await until(() => runRows(t).find(r => ![first.id,run.id].includes(r.id) && r.status === 'succeeded'), 'ordinary queued successor')
      sent(t, 'ordinary', ordinary.id)
      assert.equal(rows('SELECT native_session_id FROM conversation WHERE camp_id=?', t)[0].native_session_id, session)
      assert.equal(runRows(t).length, 3)
    }
    cases.push({name: label === 'lost' ? 'lost_receipt_no_replay' : 'cold_resume_end_race_cli_and_ordinary_queue', run: run.id, supplementalMessage, inputs: inputs(run.id), sendOwnedByRun: true}); console.log('passed ' + label)
  }
  const frames = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
  assert(frames.some(f => f.direction === 'in' && ['session/resume','session/load'].includes(f.method)))
  report.acpSummary = {promptRequests: frames.filter(f => f.direction === 'in' && f.method === 'session/prompt').length, steerRequests: frames.filter(f => f.direction === 'in' && f.steer).length,
    cancellationRequests: frames.filter(f => f.direction === 'in' && f.method === 'session/cancel').length}
  assert.equal(hash(await readFile(join(nativeHome, 'config.yaml'))), configHash)
  assert.equal(execFileSync('git', ['status','--porcelain'], {cwd: source, encoding: 'utf8'}), '')
  report.passed = true; report.upstreamUnmodified = true; report.configUnchanged = true
} catch (e) {report.passed = false; report.error = String(e); process.exitCode = 1}
finally {
  for (const l of ['active','race','cancelrace','lost','reject','race_follow','cancelrace_follow','lost_follow','reject_follow']) await release(l)
  nativeDb?.close(); db?.close(); if (core) {await core.stop().catch(e => {report.cleanupError = String(e)}); report.coreStderr = core.stderrTail}
  if (alive(gateway)) {gateway.kill('SIGTERM'); const end = Date.now() + 5000; while (alive(gateway) && Date.now() < end) await pause(50); if (alive(gateway)) gateway.kill('SIGKILL')}
  server.closeAllConnections(); await new Promise(done => server.close(done))
  report.coreSha256 = hash(await readFile(options.coreExecutable)); report.probeSha256 = hash(await readFile(new URL(import.meta.url)))
  await writeFile(join(root,'result.json'), JSON.stringify(report,null,2)+'\n', {mode:0o600})
  await writeFile(join(root,'gateway.log'), gatewayLog, {mode:0o600})
  console.log(JSON.stringify({passed:report.passed,cases:cases.length,evidence:join(root,'result.json'),error:report.error}))
}
