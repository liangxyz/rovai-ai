import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { composerDocumentForAddress } from './create-configured-camp.mjs'
import {
  coreDataDirectoryArguments,
  runtimeCampFilesRootForDataDirectory,
  removeEphemeralRuntimeCampFilesRoot
} from './runtime-camp-files-root.mjs'

const repository = resolve(import.meta.dirname, '../..')
const binary = process.env.ROVAI_CORE_BIN
  ?? join(repository, 'target', 'debug', process.platform === 'win32' ? 'rovai-core.exe' : 'rovai-core')

// This seam owns actual Thread creation/output-root resolution and startup cleanup.
// Main's file eligibility matrix remains in local-composer-attachments.test.ts.
test('Thread output directories follow Pending presence and preserve zero-message Active Threads', async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-thread-output-lifecycle-')))
  const dataDir = process.platform === 'win32'
    ? JSON.parse(execFileSync(binary, ['--prepare-windows-data-root', join(fixture, 'formal')], { encoding: 'utf8' })).core
    : join(fixture, 'data')
  const skillRoot = join(dataDir, 'managed-skill-library')
  const mcpPath = join(dataDir, 'mcp.json')
  let core = startCore(dataDir, skillRoot, mcpPath)
  try {
    await core.ready
    await core.settled()
    const agent = (await core.request('members.list')).find(profile => profile.presence === 'present')
    const legacyRoot = runtimeCampFilesRootForDataDirectory(dataDir)
    await mkdir(legacyRoot, { recursive: true, mode: 0o700 })
    await writeFile(join(legacyRoot, '.staging'), 'retain malformed historical staging')
    const missionRequest = { commandId: randomUUID(), command: {
      title: 'Mission without legacy View', description: 'No Runtime launch',
      projectBindingKind: 'directory', projectPath: fixture,
      memberAgentIds: [agent.agentId], defaultLeadAgentId: agent.agentId
    } }
    const mission = await core.request('missions.create', missionRequest)
    assert.equal(mission.status, 'applied')
    assert.equal((await core.request('missions.create', missionRequest)).payload.missionId, mission.payload.missionId)
    assert.equal(await readFile(join(legacyRoot, '.staging'), 'utf8'), 'retain malformed historical staging')
    await rm(join(legacyRoot, '.staging'))
    const threads = []
    for (const [activationState, present] of [['active', false], ['pending', false], ['pending', true]]) {
      const created = await core.request('threads.create', {
        commandId: randomUUID(), name: 'Output lifecycle fixture', workspace: null,
        memberAgentIds: [agent.agentId], defaultLeadAgentId: agent.agentId, collaborationMode: 'peer', activationState
      })
      assert.equal(created.status, 'applied')
      const threadId = created.payload.threadId
      const outputRoot = await core.request('host.thread.attachmentOutputRoot', { threadId })
      assert.equal(outputRoot.split(/[\\/]/).at(-1), threadId)
      assert.equal(await realpath(outputRoot), outputRoot)
      const source = join(outputRoot, `${randomUUID()}.txt`)
      await writeFile(source, ' \t\r\n' + '😀'.repeat(10_001) + '\n ')
      if (present) await core.request('threads.pendingDraft.setPresence', { threadId, present })
      threads.push({ threadId, outputRoot, source })
    }
    const [active, emptyPending, savedPending] = threads
    await core.close()
    core = startCore(dataDir, skillRoot, mcpPath)
    await core.ready
    await core.settled()
    assert.ok(await lstat(emptyPending.source), 'background retirement preserves files without per-file ownership proof')
    assert.ok(core.notifications.some(event => event.method === 'navigation.invalidated'
      && event.params.reason === 'camps.discardPending' && event.params.threadId === emptyPending.threadId))
    await assert.rejects(core.request('host.thread.attachmentOutputRoot', { threadId: emptyPending.threadId }))
    for (const kept of [active, savedPending]) {
      assert.equal(await core.request('host.thread.attachmentOutputRoot', { threadId: kept.threadId }), kept.outputRoot)
      assert.ok((await readFile(kept.source, 'utf8')).endsWith('\n '))
    }
    const activeDiscard = await core.request('threads.discardPending', {
      commandId: randomUUID(), command: { threadId: active.threadId }
    })
    assert.notEqual(activeDiscard.payload?.discarded, true)
    assert.ok(await lstat(active.source))
    await core.request('threads.pendingDraft.setPresence', { threadId: savedPending.threadId, present: false })
    const pendingDiscard = await core.request('threads.discardPending', {
      commandId: randomUUID(), command: { threadId: savedPending.threadId }
    })
    assert.equal(pendingDiscard.payload.discarded, true)
    await assert.rejects(lstat(savedPending.outputRoot), { code: 'ENOENT' })
    assert.ok(await lstat(active.source))
  } finally {
    await core.close()
    await removeEphemeralRuntimeCampFilesRoot(dataDir, { temporaryDirectory: fixture })
    await rm(fixture, { recursive: true, force: true })
  }
})

// Core startup used to install a process-global wrapper. A ManagedProcess unit
// test without run_core would miss that policy and pass on the broken build.
test('Core-managed macOS probes can start their own native sandbox', { skip: process.platform !== 'darwin' }, async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-native-sandbox-')))
  const dataDir = join(fixture, 'data')
  const resultPath = join(fixture, 'sandbox-exit.txt')
  const fakeCodex = join(fixture, 'codex')
  const quotedResultPath = `'${resultPath.replaceAll("'", "'\\''")}'`
  await writeFile(fakeCodex, `#!/bin/sh
/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true
probe_exit=$?
printf '%s\\n' "$probe_exit" > ${quotedResultPath}
# Keep discovery on this fixture, then reject protocol startup without a model.
if [ "$1" = '--version' ]; then
  printf 'codex-cli 0.153.4\\n'
  exit 0
fi
exit 1
`, { mode: 0o700 })
  const core = startCore(dataDir, join(dataDir, 'managed-skill-library'), join(dataDir, 'mcp.json'), [], {
    ROVAI_CODEX_BIN: fakeCodex
  })
  try {
    await core.ready
    await core.settled()
    await core.request('runtime.startup.save', { runtimeKind: 'codex-cli', expectedRevision: 0, configuration: { programPath: fakeCodex, environment: [] } })
    await core.request('runtime.startup.inspect', { runtimeKind: 'codex-cli', configuration: { programPath: fakeCodex, environment: [] } })
    let sandboxExit = null
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      sandboxExit = await readFile(resultPath, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (sandboxExit?.trim()) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(sandboxExit?.trim(), '0', 'Rovai must not prevent a Runtime from creating its own sandbox')
  } finally {
    await core.close()
    await removeEphemeralRuntimeCampFilesRoot(dataDir, { temporaryDirectory: fixture })
    await rm(fixture, { recursive: true, force: true })
  }
})

// This owns the real run_core -> ready -> RPC seam: an initializer-only unit test
// cannot prove that a healthy authority remains reachable after a filesystem error.
test('optional startup failures preserve authority RPC and can recover without restarting Core', async (t) => {
  for (const scenario of [
    { id: 'mcp', path: 'mcp.json', kind: 'directory', state: 'degraded', method: 'mcp.config.get' },
    { id: 'skills', path: 'managed-skill-library/.staging', kind: 'file', state: 'ready' },
    { id: 'runtime.claude-code-cli', path: 'runtime-private', kind: 'file', state: 'degraded' },
    { id: 'runtime.grok-build', path: 'runtime/grok-build/external-mcp', kind: 'file', state: 'ready' },
    { id: 'maintenance', path: 'runtime/mcp', kind: 'file', state: 'ready' }
  ]) {
    await t.test(scenario.id, async () => {
      const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-startup-availability-')))
      const dataDir = process.platform === 'win32'
        ? JSON.parse(execFileSync(binary, ['--prepare-windows-data-root', join(fixture, 'formal')], { encoding: 'utf8' })).core
        : join(fixture, 'data')
      const skillRoot = join(dataDir, 'managed-skill-library')
      const mcpPath = join(dataDir, 'mcp.json')
      if (process.platform === 'win32') {
        // Only native Core creates private managed directories on Windows.
        const seed = startCore(dataDir, skillRoot, mcpPath)
        try { await seed.ready; await seed.settled() } finally { await seed.close() }
      } else {
        await mkdir(skillRoot, { recursive: true, mode: 0o700 })
      }
      const faultPath = join(dataDir, scenario.path)
      if (await lstat(faultPath).catch(() => null)) await rename(faultPath, `${faultPath}.before-fault`)
      await mkdir(dirname(faultPath), { recursive: true, mode: 0o700 })
      if (scenario.kind === 'directory') await mkdir(faultPath)
      else await writeFile(faultPath, 'preserve this non-authority fixture')
      const core = startCore(dataDir, skillRoot, mcpPath)
      try {
        const frame = await core.ready
        assert.ok(core.startupFrames.some(entry => entry.phase === 'preparing_runtime_storage'
          && entry.authorityState?.kind === (process.platform === 'win32' ? 'admitted' : 'confirmed_absent')),
        'Main receives the authority assessment before Runtime storage admission')
        assert.ok(frame.subsystems.some((entry) => entry.state === 'initializing'), 'authority ready precedes optional initialization')
        const statuses = await core.settled()
        assert.equal(statuses.find((entry) => entry.id === scenario.id)?.state, scenario.state)
        assert.ok((await core.request('members.list')).length > 0)
        assert.ok(await core.request('navigation.snapshot'))
        if (scenario.method) {
          const configuration = await core.request(scenario.method)
          assert.ok(configuration.fileIssue, 'management reads retain the actual file issue')
          assert.equal(configuration.path, mcpPath)
        }
        assert.equal(core.process.exitCode, null, 'a local initializer failure must not kill Core')
        await rename(faultPath, `${faultPath}.retained`)
        const recovered = await core.request('runtime.subsystems.retry')
        assert.equal(recovered.find((entry) => entry.id === scenario.id)?.state, 'ready')
        assert.ok((await core.request('members.list')).length > 0)
        assert.equal(core.process.exitCode, null, 'retry must repair the feature in the same Core')
      } finally {
        await core.close()
        await removeEphemeralRuntimeCampFilesRoot(dataDir, { temporaryDirectory: fixture })
        await rm(fixture, { recursive: true, force: true })
      }
    })
  }
})

// This owns the startup subsystem -> Runtime availability separation. Before
// the regression fix, a missing Pi executable made both layers report a
// failure even though executable presence belongs only to Runtime discovery.
test('a missing Pi executable stays in Runtime availability instead of subsystem health', {
  // macOS adds fixed package-manager locations after PATH, so a developer's
  // installed Pi cannot be hidden without mutating the host. Linux has no such
  // locations and Windows closes Pi discovery over the explicit override.
  skip: process.platform === 'darwin'
}, async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-missing-pi-availability-')))
  const dataDir = process.platform === 'win32'
    ? JSON.parse(execFileSync(binary, ['--prepare-windows-data-root', join(fixture, 'formal')], { encoding: 'utf8' })).core
    : join(fixture, 'data')
  const emptySearchPath = join(fixture, 'empty-runtime-search')
  await mkdir(emptySearchPath)
  const missingPi = join(fixture, 'missing-runtime', process.platform === 'win32' ? 'pi.cmd' : 'pi')
  const core = startCore(
    dataDir,
    join(dataDir, 'managed-skill-library'),
    join(dataDir, 'mcp.json'),
    [],
    {
      PATH: emptySearchPath,
      ROVAI_PI_BIN: missingPi,
      SHELL: join(fixture, 'missing-shell')
    }
  )
  try {
    await core.ready
    const statuses = await core.settled()
    assert.equal(statuses.find((entry) => entry.id === 'runtime.pi')?.state, 'ready')

    const health = await core.request('health.check')
    assert.equal(
      health.runtimeAvailability.find((entry) => entry.runtimeKind === 'pi')?.status,
      'missing'
    )
  } finally {
    await core.close()
    await removeEphemeralRuntimeCampFilesRoot(dataDir, { temporaryDirectory: fixture })
    await rm(fixture, { recursive: true, force: true })
  }
})

// Core owns publication atomicity and metadata-only notifications, not private
// Draft/Pending editing. The client local-store/sync tests own unsent text retention.
test('inline publication rolls back failures and notifies Desktop without leaking unsent bodies', async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-publication-events-')))
  const dataDir = process.platform === 'win32'
    ? JSON.parse(execFileSync(binary, ['--prepare-windows-data-root', join(fixture, 'formal')], { encoding: 'utf8' })).core
    : join(fixture, 'data')
  const skillRoot = join(dataDir, 'managed-skill-library')
  const mcpPath = join(dataDir, 'mcp.json')
  let core = startCore(dataDir, skillRoot, mcpPath)
  let database
  try {
    await core.ready
    await core.settled()
    const agent = (await core.request('members.list')).find(profile => profile.presence === 'present')
    assert.equal(agent.runtimeConfiguration, null, 'This fixture must never launch a configured model')
    const created = await core.request('threads.create', {
      commandId: randomUUID(), name: 'Publication notification fixture', workspace: null,
      memberAgentIds: [agent.agentId], defaultLeadAgentId: agent.agentId, collaborationMode: 'peer'
    })
    assert.equal(created.status, 'applied')
    const threadId = created.payload.threadId
    const originalRequest = {
      commandId: randomUUID(), threadId, content: composerDocumentForAddress({ mode: 'default' }, 'Preserved history'),
      sourceAttachments: [], quotes: [], replyToThreadMessageId: null, execution: null
    }
    const messageHints = () => core.notifications.filter(event => event.method === 'thread.messages.changed'
      && event.params.threadId === threadId)
    const publicationInvalidations = () => core.notifications.filter(event => event.method === 'navigation.invalidated'
      && event.params.threadId === threadId && event.params.reason === 'camp.messages.send')
    const assertMetadataOnly = (hint) => {
      assert.deepEqual(Object.keys(hint.params).sort(), ['indexChanged', 'threadId', 'throughGlobalSequence', 'unavailableMessageIds'])
      assert.equal(hint.params.threadId, threadId)
      assert.equal(hint.params.indexChanged, true)
      assert.deepEqual(hint.params.unavailableMessageIds, [])
      assert.ok(Number.isSafeInteger(hint.params.throughGlobalSequence) && hint.params.throughGlobalSequence > 0)
    }
    const original = await core.request('thread.messages.send', originalRequest)
    assert.equal(original.commandResult.code, 'camp_message.sent')
    await core.close()
    assert.equal(messageHints().length, 1)
    assertMetadataOnly(messageHints()[0])
    database = new DatabaseSync(join(dataDir, 'rovai.sqlite'))
    const history = database.prepare('SELECT * FROM camp_message WHERE camp_id = ? ORDER BY sequence').all(threadId)
    const sequences = database.prepare('SELECT last_message_sequence, last_delivery_sequence FROM camp WHERE id = ?').get(threadId)
    const events = database.prepare('SELECT * FROM event_log WHERE camp_id = ? ORDER BY rowid').all(threadId)
    const now = new Date().toISOString()
    // A historical private row has no authority to publish or block a new send.
    database.prepare(`INSERT INTO pending_camp_input(
      id, camp_id, enqueue_sequence, state, structured_content_json, execution_json, user_id,
      last_attempt_error_code, created_at, updated_at
    ) VALUES ('held-head', ?, 1, 'needs_repair', ?, 'null', 'local_user', 'fixture.hold', ?, ?)`)
      .run(threadId, JSON.stringify([{ kind: 'text', text: 'Private held head' }]), now, now)
    const legacyPending = database.prepare("SELECT * FROM pending_camp_input WHERE id = 'held-head'").get()
    const assertPublicationUnchanged = (commandId) => {
      assert.deepEqual(database.prepare('SELECT * FROM camp_message WHERE camp_id = ? ORDER BY sequence').all(threadId), history)
      assert.deepEqual(database.prepare('SELECT last_message_sequence, last_delivery_sequence FROM camp WHERE id = ?').get(threadId), sequences)
      assert.deepEqual(database.prepare('SELECT * FROM event_log WHERE camp_id = ? ORDER BY rowid').all(threadId), events)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM camp_message_delivery').get().count, 0)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM agent_run').get().count, 0)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM camp_composer_draft').get().count, 0)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log WHERE command_id = ?').get(commandId).count, 0)
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM event_log WHERE payload_json LIKE '%Private refused body%' OR payload_json LIKE '%Private receipt body%'").get().count, 0)
      assert.deepEqual(database.prepare("SELECT * FROM pending_camp_input WHERE id = 'held-head'").get(), legacyPending)
    }
    database.exec(`CREATE TRIGGER refuse_fixture_publication BEFORE INSERT ON camp_message
      BEGIN SELECT RAISE(ABORT, 'fixture publication refusal'); END;`)
    database.close()
    database = null
    core = startCore(dataDir, skillRoot, mcpPath)
    await core.ready
    const refused = {
      commandId: randomUUID(), threadId, content: composerDocumentForAddress({ mode: 'default' }, 'Private refused body'),
      sourceAttachments: [], quotes: [], replyToThreadMessageId: null,
      execution: { taskId: null, purpose: 'publication rollback fixture', completionRole: 'required' }
    }
    await assert.rejects(core.request('thread.messages.send', refused), error => {
      assert.equal(error.code, 'CORE_REQUEST_FAILED')
      assert.match(error.message, /fixture publication refusal/)
      return true
    })
    assert.equal(messageHints().length, 0)
    assert.equal(publicationInvalidations().length, 0)
    await core.close()
    // close() drains stdout: a delayed hint must not escape a failed transaction.
    assert.equal(messageHints().length, 0)
    assert.equal(publicationInvalidations().length, 0)
    assert.equal(JSON.stringify(core.notifications).includes('Private refused body'), false)
    database = new DatabaseSync(join(dataDir, 'rovai.sqlite'))
    assertPublicationUnchanged(refused.commandId)
    database.exec('DROP TRIGGER refuse_fixture_publication')
    const receiptRefused = {
      ...refused, commandId: randomUUID(), content: composerDocumentForAddress({ mode: 'default' }, 'Private receipt body')
    }
    // Fail only after message, Delivery and sequences were written, at the last
    // receipt boundary. The entire transaction and its collected hint must roll back.
    database.exec(`CREATE TRIGGER refuse_fixture_receipt BEFORE INSERT ON event_log
      WHEN NEW.event_type = 'command.result' AND NEW.command_id = '${receiptRefused.commandId}'
      BEGIN
        SELECT RAISE(ABORT, 'fixture receipt missing staged message')
          WHERE NOT EXISTS(SELECT 1 FROM camp_message WHERE camp_id = '${threadId}' AND body = 'Private receipt body');
        SELECT RAISE(ABORT, 'fixture receipt missing staged Delivery')
          WHERE NOT EXISTS(SELECT 1 FROM camp_message_delivery d JOIN camp_message m ON m.id = d.message_id
            WHERE m.camp_id = '${threadId}' AND m.body = 'Private receipt body');
        SELECT RAISE(ABORT, 'fixture receipt missing staged sequences')
          WHERE NOT EXISTS(SELECT 1 FROM camp WHERE id = '${threadId}'
            AND last_message_sequence = ${sequences.last_message_sequence + 1}
            AND last_delivery_sequence = ${sequences.last_delivery_sequence + 1});
        SELECT RAISE(ABORT, 'fixture receipt refusal after publication');
      END;`)
    database.close()
    database = null
    core = startCore(dataDir, skillRoot, mcpPath)
    await core.ready
    await assert.rejects(core.request('thread.messages.send', receiptRefused), error => {
      assert.equal(error.code, 'CORE_REQUEST_FAILED')
      assert.match(error.message, /fixture receipt refusal after publication/)
      return true
    })
    assert.equal(messageHints().length, 0)
    assert.equal(publicationInvalidations().length, 0)
    await core.close()
    assert.equal(messageHints().length, 0)
    assert.equal(publicationInvalidations().length, 0)
    assert.equal(/Private refused body|Private receipt body/.test(JSON.stringify(core.notifications)), false)
    database = new DatabaseSync(join(dataDir, 'rovai.sqlite'))
    assertPublicationUnchanged(refused.commandId)
    assertPublicationUnchanged(receiptRefused.commandId)
    database.exec('DROP TRIGGER refuse_fixture_receipt')
    database.close()
    database = null
    core = startCore(dataDir, skillRoot, mcpPath)
    await core.ready
    assert.equal(messageHints().length, 0)
    const replay = await core.request('thread.messages.send', originalRequest)
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.commandResult, original.commandResult)
    assert.equal(messageHints().length, 0, 'Receipt replay must not issue a second message-change hint')
    const publishedRequest = {
      ...refused, commandId: randomUUID(), content: composerDocumentForAddress({ mode: 'default' }, 'Public delivery body')
    }
    const published = await core.request('thread.messages.send', publishedRequest)
    assert.equal(messageHints().length, 1)
    assertMetadataOnly(messageHints()[0])
    const publishedReplay = await core.request('thread.messages.send', publishedRequest)
    assert.equal(publishedReplay.replayed, true)
    assert.deepEqual(publishedReplay.commandResult, published.commandResult)
    assert.equal(messageHints().length, 1, 'An accepted command replay must not duplicate its message-change hint')
    assert.equal(published.commandResult.status, 'accepted')
    assert.equal(published.commandResult.code, 'camp_message.deliveries_waiting')
    assert.equal(published.commandResult.payload.deliveryIds.length, 1)
    const deliveryId = published.commandResult.payload.deliveryIds[0]
    const deadline = Date.now() + 10_000
    while (true) {
      database = new DatabaseSync(join(dataDir, 'rovai.sqlite'), { readOnly: true })
      const delivery = database.prepare('SELECT status FROM camp_message_delivery WHERE id = ?').get(deliveryId)
      database.close()
      database = null
      if (delivery.status === 'failed') break
      assert.ok(Date.now() < deadline, 'A committed Delivery must settle its missing Runtime configuration')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const invalidations = core.notifications.filter(event => event.method === 'navigation.invalidated'
      && event.params.threadId === threadId && event.params.reason === 'camp.messages.send')
    assert.ok(invalidations.length > 0)
    assert.ok(invalidations.every(event => Object.keys(event.params).sort().join(',') === 'reason,scope,threadId'))
    assert.equal(/Private refused body|Private receipt body|Private held head|Public delivery body/.test(JSON.stringify(core.notifications)), false)
    await core.close()
    assert.equal(messageHints().length, 1, 'Draining output must reveal exactly one committed-publication hint')
    assertMetadataOnly(messageHints()[0])
    assert.equal(/Private refused body|Private receipt body|Private held head|Public delivery body/.test(JSON.stringify(core.notifications)), false)
    database = new DatabaseSync(join(dataDir, 'rovai.sqlite'), { readOnly: true })
    const messages = database.prepare('SELECT * FROM camp_message WHERE camp_id = ? ORDER BY sequence').all(threadId)
    assert.deepEqual(messages.slice(0, history.length), history)
    assert.deepEqual(messages.map(message => message.body), ['Preserved history', 'Public delivery body'])
    assert.equal(messages[1].id, published.commandResult.payload.threadMessageId)
    const delivery = database.prepare('SELECT status, failure_code, claimed_agent_run_id FROM camp_message_delivery WHERE id = ?').get(deliveryId)
    assert.equal(delivery.status, 'failed')
    assert.equal(delivery.failure_code, 'runtime_not_configured')
    const run = database.prepare('SELECT status, last_error_code FROM agent_run WHERE id = ?').get(delivery.claimed_agent_run_id)
    assert.equal(run.status, 'failed')
    assert.equal(run.last_error_code, 'runtime_not_configured')
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM agent_run').get().count, 1)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM camp_message_delivery').get().count, 1)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log WHERE command_id = ?').get(refused.commandId).count, 0)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log WHERE command_id = ?').get(receiptRefused.commandId).count, 0)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM event_log WHERE command_id = ? AND event_type = 'command.result'").get(publishedRequest.commandId).count, 1)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM event_log WHERE payload_json LIKE '%Private refused body%' OR payload_json LIKE '%Private receipt body%' OR payload_json LIKE '%Private held head%'").get().count, 0)
    assert.deepEqual(database.prepare("SELECT * FROM pending_camp_input WHERE id = 'held-head'").get(), legacyPending)
  } finally {
    database?.close()
    await core.close()
    await removeEphemeralRuntimeCampFilesRoot(dataDir, { temporaryDirectory: fixture })
    await rm(fixture, { recursive: true, force: true })
  }
})

// Core recovers published responsibilities, not the retired private Pending queue.
// Client local-store/send-recovery tests cover rejected and unknown unsent drafts.
test('idle Threads preserve failed history and drain public Deliveries after restart', async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-idle-delivery-recovery-')))
  const dataDir = process.platform === 'win32'
    ? JSON.parse(execFileSync(binary, ['--prepare-windows-data-root', join(fixture, 'formal')], { encoding: 'utf8' })).core
    : join(fixture, 'data')
  const skillRoot = join(dataDir, 'managed-skill-library')
  const mcpPath = join(dataDir, 'mcp.json')
  let core = startCore(dataDir, skillRoot, mcpPath)
  let database
  const camps = []
  const inline = (threadId, body) => ({
    commandId: randomUUID(), threadId, content: composerDocumentForAddress({ mode: 'default' }, body),
    sourceAttachments: [], quotes: [], replyToThreadMessageId: null, execution: null
  })
  try {
    await core.ready
    await core.settled()
    const agent = (await core.request('members.list')).find(profile => profile.presence === 'present')
    assert.equal(agent.runtimeConfiguration, null, 'Backlog admission must not launch a configured model')
    const agentId = agent.agentId
    for (const backlog of [false, true]) {
      const created = await core.request('threads.create', {
        commandId: randomUUID(), name: 'Idle Delivery recovery fixture', workspace: null,
        memberAgentIds: [agentId], defaultLeadAgentId: agentId, collaborationMode: 'peer'
      })
      assert.equal(created.status, 'applied')
      const threadId = created.payload.threadId
      const request = inline(threadId, 'A')
      const first = await core.request('thread.messages.send', request)
      assert.equal(first.commandResult.code, 'camp_message.sent')
      const published = []
      if (backlog) {
        for (const body of ['B', 'C']) {
          const sent = await core.request('thread.messages.send', inline(threadId, body))
          assert.equal(sent.commandResult.code, 'camp_message.sent')
          published.push({ messageId: sent.commandResult.payload.threadMessageId, body })
        }
      }
      camps.push({ threadId, published, request, first, messageId: first.commandResult.payload.threadMessageId,
        turnId: randomUUID(), runId: randomUUID(), pendingId: randomUUID() })
    }
    await core.close()
    database = new DatabaseSync(join(dataDir, 'rovai.sqlite'))
    const now = new Date().toISOString()
    for (const camp of camps) {
      const { threadId, messageId, turnId, runId, pendingId } = camp
      database.prepare(`INSERT OR IGNORE INTO conversation(id, camp_id, agent_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), threadId, agentId, now, now)
      const conversationId = database.prepare('SELECT id FROM conversation WHERE camp_id = ? AND agent_id = ?').get(threadId, agentId).id
      database.prepare(`INSERT INTO camp_turn(id, camp_id, trigger_type, trigger_id, status, created_at, updated_at)
        VALUES (?, ?, 'camp_message', ?, 'waiting', ?, ?)`).run(turnId, threadId, messageId, now, now)
      // Terminal old retry-wait history is preserved, never automatically replayed.
      database.prepare(`INSERT INTO agent_run(
        id, camp_turn_id, conversation_id, trigger_camp_message_id, initial_camp_context_through_sequence,
        initial_conversation_context_through_sequence, responsibility_key, start_reason,
        purpose, completion_role, effective_config_json, status,
        idempotency_key, manual_retry_allowed, last_error_code, created_at, ended_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, 0, 'initial', 'initial', 'fixture', 'required', '{}',
        'failed', ?, 1, 'runtime_launch_failed', ?, ?, ?)`)
        .run(runId, turnId, conversationId, messageId, randomUUID(), now, now, now)
      database.prepare('UPDATE camp_message SET camp_turn_id = ? WHERE id = ?').run(turnId, messageId)
      // A leftover private row is a non-publication counterexample, not a queue.
      database.prepare(`INSERT INTO pending_camp_input(
        id, camp_id, enqueue_sequence, state, structured_content_json, execution_json, user_id, created_at, updated_at
      ) VALUES (?, ?, 1, 'queued', ?, 'null', 'local_user', ?, ?)`)
        .run(pendingId, threadId, JSON.stringify([{ kind: 'text', text: 'Retired private input must not publish' }]), now, now)
      camp.oldRun = database.prepare('SELECT * FROM agent_run WHERE id = ?').get(runId)
      camp.oldPending = database.prepare('SELECT * FROM pending_camp_input WHERE id = ?').get(pendingId)
      camp.history = database.prepare('SELECT * FROM camp_message WHERE camp_id = ? ORDER BY sequence').all(threadId)
      const membershipVersion = database.prepare('SELECT version FROM camp_member WHERE camp_id = ? AND agent_id = ?').get(threadId, agentId).version
      // Model already-published work left waiting when the previous Core stopped.
      for (const message of camp.published) {
        const sequence = database.prepare('UPDATE camp SET last_delivery_sequence = last_delivery_sequence + 1 WHERE id = ? RETURNING last_delivery_sequence').get(threadId).last_delivery_sequence
        database.prepare(`INSERT INTO camp_message_delivery(
          id, camp_id, message_id, source_kind, recipient_agent_id, recipient_membership_version_at_admission,
          queue_sequence, status, version, created_at, updated_at
        ) VALUES (?, ?, ?, 'message', ?, ?, ?, 'waiting', 1, ?, ?)`)
          .run(randomUUID(), threadId, message.messageId, agentId, membershipVersion, sequence, now, now)
      }
    }
    database.close()
    database = null
    core = startCore(dataDir, skillRoot, mcpPath)
    await core.ready
    const deadline = Date.now() + 10_000
    while (true) {
      database = new DatabaseSync(join(dataDir, 'rovai.sqlite'), { readOnly: true })
      const remaining = database.prepare("SELECT COUNT(*) AS count FROM camp_message_delivery WHERE status IN ('waiting', 'claimed')").get().count
      database.close()
      database = null
      if (remaining === 0) break
      assert.ok(Date.now() < deadline, 'Already public Deliveries must settle without another user send')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    for (const camp of camps) {
      const replay = await core.request('thread.messages.send', camp.request)
      assert.equal(replay.replayed, true)
      assert.deepEqual(replay.commandResult, camp.first.commandResult)
      const fresh = inline(camp.threadId, 'Fresh input after recovery')
      const sent = await core.request('thread.messages.send', fresh)
      assert.equal(sent.commandResult.code, 'camp_message.sent')
      const repeated = await core.request('thread.messages.send', fresh)
      assert.equal(repeated.replayed, true)
      assert.deepEqual(repeated.commandResult, sent.commandResult)
    }
    await core.close()
    database = new DatabaseSync(join(dataDir, 'rovai.sqlite'), { readOnly: true })
    for (const { threadId, messageId, turnId, runId, pendingId, published, oldRun, oldPending, history } of camps) {
      const turn = database.prepare('SELECT status, ended_at FROM camp_turn WHERE id = ?').get(turnId)
      assert.equal(turn.status, 'failed')
      assert.ok(turn.ended_at)
      assert.deepEqual(database.prepare('SELECT * FROM agent_run WHERE id = ?').get(runId), oldRun)
      assert.deepEqual(database.prepare('SELECT * FROM pending_camp_input WHERE id = ?').get(pendingId), oldPending)
      const messages = database.prepare('SELECT * FROM camp_message WHERE camp_id = ? ORDER BY sequence').all(threadId)
      assert.deepEqual(messages.slice(0, history.length), history)
      assert.equal(messages.length, history.length + 1)
      assert.equal(messages[0].id, messageId)
      assert.equal(messages.at(-1).body, 'Fresh input after recovery')
      const deliveries = database.prepare('SELECT * FROM camp_message_delivery WHERE camp_id = ? ORDER BY queue_sequence').all(threadId)
      assert.equal(deliveries.length, published.length)
      // Assert durable queue order and exact input ownership, not wall-clock order.
      for (const [index, delivery] of deliveries.entries()) {
        assert.equal(delivery.message_id, published[index].messageId)
        assert.equal(delivery.status, 'failed')
        assert.equal(delivery.failure_code, 'runtime_not_configured')
        const inputs = database.prepare('SELECT agent_run_id, ordinal, message_id, message_sequence FROM agent_run_input WHERE delivery_id = ?').all(delivery.id)
        assert.equal(inputs.length, 1)
        assert.equal(inputs[0].agent_run_id, delivery.claimed_agent_run_id)
        assert.equal(inputs[0].ordinal, 0)
        assert.equal(inputs[0].message_id, delivery.message_id)
        assert.equal(inputs[0].message_sequence, index + 2)
        const run = database.prepare('SELECT status, last_error_code, predecessor_agent_run_id FROM agent_run WHERE id = ?').get(inputs[0].agent_run_id)
        assert.equal(run.status, 'failed')
        assert.equal(run.last_error_code, 'runtime_not_configured')
        assert.equal(run.predecessor_agent_run_id, null)
      }
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM agent_run WHERE predecessor_agent_run_id = ?').get(runId).count, 0)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM agent_run WHERE conversation_id = ?').get(oldRun.conversation_id).count, 1 + published.length,
        'Only the original failed Run and the public backlog may create responsibilities')
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM camp_message WHERE body = 'Retired private input must not publish'").get().count, 0)
  } finally {
    database?.close()
    await core.close()
    await removeEphemeralRuntimeCampFilesRoot(dataDir, { temporaryDirectory: fixture })
    await rm(fixture, { recursive: true, force: true })
  }
})

test('authority recovery errors produce a retryable refusal rather than a crash or false ready', async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-authority-recovery-')))
  const dataDir = process.platform === 'win32'
    ? JSON.parse(execFileSync(binary, ['--prepare-windows-data-root', join(fixture, 'formal')], { encoding: 'utf8' })).core
    : join(fixture, 'data')
  const skillRoot = join(dataDir, 'managed-skill-library')
  const mcpPath = join(dataDir, 'mcp.json')
  const seed = startCore(dataDir, skillRoot, mcpPath)
  let writer
  let refused
  let recovered
  try {
    await seed.ready
    await seed.settled()
    const before = await seed.request('members.list')
    await seed.close()
    writer = new DatabaseSync(join(dataDir, 'rovai.sqlite'))
    // Valid pending authority, with a fixture-only failure at its settlement
    // boundary. A generic SQLite writer lock fails earlier during DB open/seed
    // and cannot exercise run_core's post-database_ready recovery refusal.
    writer.exec(`
      INSERT INTO planned_shutdown_cycle(core_generation, protocol_version, requested_at)
      VALUES ('acceptance-refused-settlement', 3, '2026-08-30T00:00:00Z');
      CREATE TRIGGER acceptance_refuse_settlement BEFORE UPDATE ON planned_shutdown_cycle
      WHEN OLD.core_generation = 'acceptance-refused-settlement'
      BEGIN SELECT RAISE(ABORT, 'injected controlled shutdown recovery failure'); END;
    `)
    writer.close()
    writer = null
    refused = startCore(dataDir, skillRoot, mcpPath)
    await assert.rejects(refused.ready, (error) =>
      error.code === 'authority_recovery_failed' && error.phase === 'recovering_authority'
      && error.startupStatus === 'failed' && error.retryable === true
    )
    assert.ok(refused.startupFrames.some(entry => entry.phase === 'preparing_runtime_storage'
      && entry.authorityState?.kind === 'admitted'), 'a later refusal cannot erase knowledge of an existing authority')
    await refused.close()
    assert.equal(refused.process.exitCode, 0, 'deterministic refusal must not be an unexpected Core crash')
    writer = new DatabaseSync(join(dataDir, 'rovai.sqlite'))
    assert.equal(writer.prepare("SELECT settled_at FROM planned_shutdown_cycle WHERE core_generation = 'acceptance-refused-settlement'").get().settled_at, null)
    writer.exec('DROP TRIGGER acceptance_refuse_settlement')
    writer.close()
    writer = null
    recovered = startCore(dataDir, skillRoot, mcpPath)
    await recovered.ready
    assert.deepEqual(await recovered.request('members.list'), before)
  } finally {
    writer?.close()
    await seed.close()
    if (refused) await refused.close()
    if (recovered) await recovered.close()
    await removeEphemeralRuntimeCampFilesRoot(dataDir, { temporaryDirectory: fixture })
    await rm(fixture, { recursive: true, force: true })
  }
})

test('a startup retry cannot initialize a disappeared authority', async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-existing-authority-fence-')))
  const dataDir = process.platform === 'win32'
    ? JSON.parse(execFileSync(binary, ['--prepare-windows-data-root', join(fixture, 'formal')], { encoding: 'utf8' })).core
    : join(fixture, 'data')
  const core = startCore(dataDir, join(dataDir, 'managed-skill-library'), join(dataDir, 'mcp.json'), ['--require-existing-authority'])
  try {
    await assert.rejects(core.ready, error => error.code === 'authority_required_existing_missing' && error.retryable === false)
    await core.close()
    assert.equal(await lstat(join(dataDir, 'rovai.sqlite')).catch(() => null), null)
    assert.equal(await lstat(join(dataDir, 'lumen.sqlite')).catch(() => null), null)
    assert.equal(core.process.exitCode, 0)
  } finally {
    await core.close()
    await removeEphemeralRuntimeCampFilesRoot(dataDir, { temporaryDirectory: fixture })
    await rm(fixture, { recursive: true, force: true })
  }
})

function startCore(dataDir, skillRoot, mcpPath, extraArgs = [], environment = {}) {
  console.error(`Automatic isolated Core acceptance: data=${dataDir}; skills=${skillRoot}; MCP=${mcpPath}`)
  const spawnOptions = { cwd: repository, stdio: ['pipe', 'pipe', 'pipe'] }
  if (Object.keys(environment).length > 0) {
    spawnOptions.env = { ...process.env, ...environment }
  }
  const child = spawn(binary, [
    ...coreDataDirectoryArguments(dataDir),
    '--skill-library-root', skillRoot,
    '--mcp-config-path', mcpPath,
    ...extraArgs
  ], spawnOptions)
  const pending = new Map()
  const startupFrames = []
  let nextId = 0
  let stderr = ''
  const notifications = []
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const startupTimeout = setTimeout(() => rejectReady(new Error(`Core ready timeout: ${stderr}`)), 15000)
  const closed = new Promise((resolve) => child.once('close', resolve))
  child.stdin.on('error', () => {})
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000) })
  child.on('error', rejectReady)
  child.once('exit', (code) => {
    clearTimeout(startupTimeout)
    const error = new Error(`Core exited before usable ready/RPC (code=${code}): ${stderr}`)
    rejectReady(error)
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const message = JSON.parse(line)
    if (message.kind === 'core_startup') startupFrames.push(message)
    if (message.method) notifications.push(message)
    if (message.kind === 'core_startup' && message.status === 'ready') {
      clearTimeout(startupTimeout)
      resolveReady(message)
    }
    if (message.kind === 'core_startup' && ['failed', 'blocked'].includes(message.status)) {
      clearTimeout(startupTimeout)
      rejectReady(Object.assign(new Error(message.error?.message ?? 'Startup refused'), message.error, {
        phase: message.phase, startupStatus: message.status
      }))
    }
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) request.reject(message.error)
      else request.resolve(message.result)
    }
  })
  async function request(method, params = {}) {
    await ready
    const id = String(++nextId)
    let timeout
    try {
      return await Promise.race([
        new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject })
          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
        }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 10000) })
      ])
    } finally {
      clearTimeout(timeout)
      pending.delete(id)
    }
  }
  return {
    process: child,
    startupFrames,
    ready,
    request,
    notifications,
    async settled() {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        const states = await request('runtime.subsystems.get')
        if (states.every((entry) => entry.state !== 'initializing')) return states
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error('Optional initialization did not settle')
    },
    async close() {
      child.stdin.end()
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000)
      await closed
      clearTimeout(timeout)
      clearTimeout(startupTimeout)
      lines.close()
    }
  }
}

// RPC -> immutable search snapshot -> child environment -> restart is the owner
// seam. Input-name cases stay in runtime_startup's unit matrix.
test('startup settings keep drafts private and persist only the selected Runtime shared environment', { skip: process.platform === 'win32', timeout: 90_000 }, async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-runtime-startup-settings-')))
  const dataDir = join(fixture, 'data')
  const defaultProgram = join(fixture, 'default-codex')
  const selectedProgram = join(fixture, 'custom codex')
  const marker = join(fixture, 'environment.txt')
  const shellQuote = text => `'${text.replaceAll("'", "'\\''")}'`
  await writeFile(defaultProgram, '#!/bin/sh\nprintf "codex-cli 0.153.4\\n"\n', { mode: 0o700 })
  await writeFile(selectedProgram, `#!/bin/sh
printf '%s' "\${STARTUP_TEST_VALUE-unset}" > ${shellQuote(marker)}
if [ "$1" = '--version' ]; then printf 'codex-cli 0.153.4\\n'; exit 0; fi
# An explicit check sees the draft but cannot authenticate or become Ready.
exit 1
`, { mode: 0o700 })
  const environment = { ROVAI_CODEX_BIN: defaultProgram }
  let core = startCore(dataDir, join(dataDir, 'managed-skill-library'), join(dataDir, 'mcp.json'), [], environment)
  try {
    await core.ready
    await core.settled()
    const runtimeKind = 'codex-cli'
    const initial = await core.request('runtime.startup.get', { runtimeKind })
    assert.equal(initial.revision, 0)
    const configuration = { programPath: selectedProgram, environment: [] }
    const commonEnvironment = { expectedRevision: 0, json: JSON.stringify({ STARTUP_TEST_VALUE: 'draft-private-value' }) }
    const inspected = await core.request('runtime.startup.inspect', { runtimeKind, configuration, commonEnvironment })
    assert.equal(inspected.status, 'recognized')
    assert.equal(await readFile(marker, 'utf8'), 'draft-private-value')
    assert.equal((await core.request('runtime.startup.get', { runtimeKind })).revision, 0)
    const checked = await core.request('runtime.startup.check', { runtimeKind, configuration, commonEnvironment })
    assert.equal(checked.status, 'check_failed', 'a fixture that closes the protocol is not a healthy Runtime')
    assert.equal((await core.request('runtime.startup.get', { runtimeKind })).revision, 0)
    assert.ok(!JSON.stringify(core.notifications).includes('draft-private-value'))
    commonEnvironment.json = JSON.stringify({ STARTUP_TEST_VALUE: 'saved-private-value' })
    const saved = await core.request('runtime.startup.save', { runtimeKind, edits: [{ path: ['programPath'], before: null, after: selectedProgram, label: 'program' }], commonEnvironment })
    assert.equal(saved.revision, 1)
    await core.request('runtime.startup.inspect', { runtimeKind, configuration })
    assert.equal(await readFile(marker, 'utf8'), 'saved-private-value')
    assert.deepEqual((await core.request('runtime.startup.get', { runtimeKind: 'pi' })).commonEnvironment.environment, {})
    assert.equal((await core.request('runtime.startup.save', { runtimeKind, expectedRevision: 0, configuration })).revision, 1, 'retrying the same write is idempotent')
    await assert.rejects(core.request('runtime.startup.save', { runtimeKind, expectedRevision: 0, configuration: { programPath: null, environment: [] } }))
    // Two settings windows: the first keeps its repair draft while the second
    // advances the damaged record. The conflict response must enable a retry.
    const database = new DatabaseSync(join(dataDir, 'rovai.sqlite'))
    try {
      database.exec('PRAGMA ignore_check_constraints=ON')
      database.prepare(`INSERT INTO runtime_startup_setting(runtime_kind, revision, configuration_json, updated_at)
        VALUES ('pi', 7, '{broken', ?) ON CONFLICT(runtime_kind) DO UPDATE SET
        revision=7, configuration_json='{broken'`).run(new Date().toISOString())
      const firstWindow = await core.request('runtime.startup.get', { runtimeKind: 'pi' })
      assert.ok(firstWindow.configuration.configurationError)
      database.exec("UPDATE runtime_startup_setting SET revision=8 WHERE runtime_kind='pi'")
      const repair = { runtimeKind: 'pi', expectedRevision: firstWindow.revision,
        edits: [{ path: ['programPath'], before: null, after: null, label: 'program' }] }
      const conflict = await core.request('runtime.startup.save', repair)
      assert.equal(conflict.status, 'conflict')
      assert.equal(conflict.latest.revision, 8)
      assert.equal(conflict.conflicts.length, 1)
      const repaired = await core.request('runtime.startup.save', { ...repair, expectedRevision: conflict.latest.revision })
      assert.equal(repaired.revision, 9)
      assert.equal(repaired.configuration.configurationError, undefined)
    } finally { database.close() }
    await core.close()
    core = startCore(dataDir, join(dataDir, 'managed-skill-library'), join(dataDir, 'mcp.json'), [], environment)
    await core.ready
    await core.settled()
    assert.deepEqual((await core.request('runtime.startup.get', { runtimeKind })).configuration, configuration)
    assert.equal(await readFile(marker, 'utf8'), 'saved-private-value')
    await rename(selectedProgram, `${selectedProgram}.moved`)
    const health = await core.request('runtime.discovery.rescan', {})
    assert.equal(health.runtimeAvailability.find(item => item.runtimeKind === runtimeKind).discovery.discoveryStatus, 'missing', 'an invalid explicit path does not fall back to the old/default program')
    await core.request('runtime.startup.save', { runtimeKind, expectedRevision: 1, configuration: { programPath: null, environment: [] } })
    const restored = await core.request('runtime.discovery.rescan', { interactiveShell: false })
    assert.equal(restored.runtimeAvailability.find(item => item.runtimeKind === runtimeKind).discovery.executablePath, defaultProgram)
    assert.ok(!JSON.stringify([...core.notifications, restored]).includes('saved-private-value'))
    assert.equal(process.env.STARTUP_TEST_VALUE, undefined)
  } finally {
    await core.close()
    await removeEphemeralRuntimeCampFilesRoot(dataDir, { temporaryDirectory: fixture })
    await rm(fixture, { recursive: true, force: true })
  }
})
