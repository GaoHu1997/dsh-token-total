import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionUsageService } from '../src/session-usage.ts'

const message = (inputTokens, seq = 0, turn = 1) => ({
  seq, time: 1000, type: 'assistant/message', data: { turn, step: 1, usage: { inputTokens } },
})
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const snapshot = headers => headers.map(header => ({ header: { ...header } }))
const input = tree => tree.total.uncachedInputTokens

function fixture(headers, logs) {
  const calls = { catalogs: 0, opens: [], pages: 0, closes: [] }
  const persistence = {
    async list() { calls.catalogs++; return snapshot(headers) },
    async open(id) {
      calls.opens.push(id)
      if (!(id in logs)) throw Object.assign(new Error('missing log'), { code: 'ENOENT' })
      const events = [...logs[id]]
      return {
        inheritedEventCount: 0,
        async read(offset, length) { calls.pages++; return { events: events.slice(offset, offset + length) } },
        async close() { calls.closes.push(id) },
      }
    },
  }
  return { headers, logs, calls, persistence }
}
const roots = () => fixture([{ id: 'a' }, { id: 'b' }], { a: [message(10)], b: [message(20)] })
const metrics = calls => ({ catalogs: calls.catalogs, opens: calls.opens.length, pages: calls.pages, closes: calls.closes.length })

test('three concurrent cold requests share one catalog and one read of each tree log', async () => {
  const f = fixture([{ id: 'root' }, { id: 'child', parentSession: 'root' }, { id: 'unrelated' }], {
    root: [message(10)], child: [message(20)], unrelated: [message(999)],
  })
  const service = new SessionUsageService()
  const values = await Promise.all(Array.from({ length: 3 }, () => service.tree(f.persistence, undefined, 'root')))
  assert.ok(values.every(value => value === values[0]))
  assert.equal(input(values[0]), 30)
  assert.deepEqual(metrics(f.calls), { catalogs: 1, opens: 2, pages: 4, closes: 2 })
  service.invalidate('unrelated')
  assert.equal(await service.tree(f.persistence, undefined, 'root'), values[0])
  assert.deepEqual(metrics(f.calls), { catalogs: 1, opens: 2, pages: 4, closes: 2 }, 'known unrelated events leave the tree warm')
})

test('two warm roots invalidate only the changed child and its ancestors', async () => {
  const f = roots()
  f.headers.push({ id: 'child', parentSession: 'a' })
  f.logs.child = [message(7)]
  const service = new SessionUsageService()
  const a = await service.tree(f.persistence, undefined, 'a')
  const b = await service.tree(f.persistence, undefined, 'b')
  f.logs.child = [message(9)]
  service.invalidate('child', 'a')
  assert.equal(await service.tree(f.persistence, undefined, 'b'), b)
  const changed = await service.tree(f.persistence, undefined, 'a')
  assert.notEqual(changed, a)
  assert.equal(input(changed), 19)
  assert.equal(f.calls.opens.filter(id => id === 'b').length, 1)
})

test('new live children and grandchildren invalidate cached ancestors before persistence lists them', async () => {
  const f = roots(), handles = []
  const sessions = { list: () => handles, get: id => handles.find(handle => handle.id === id) }
  const service = new SessionUsageService()
  const b = await service.tree(f.persistence, sessions, 'b')
  assert.equal((await service.tree(f.persistence, sessions, 'a')).subagentSessions, 0)
  const inherited = message(10)
  const owned = message(7, 1, 2)
  handles.push({ id: 'child', header: { id: 'child', parentSession: 'a' }, inheritedEventCount: 1, snapshotEvents: () => [inherited, owned] })
  service.invalidate('child', 'a')
  assert.equal(input(await service.tree(f.persistence, sessions, 'a')), 17)
  assert.equal(await service.tree(f.persistence, sessions, 'b'), b)
  handles.push({ id: 'grandchild', parentSession: 'child', inheritedEventCount: 2, snapshotEvents: () => [inherited, owned, message(3, 2, 3)] })
  service.invalidate('grandchild', 'child')
  const next = await service.tree(f.persistence, sessions, 'a')
  assert.equal(input(next), 20)
  assert.equal(next.subagentSessions, 2)
  assert.equal(await service.tree(f.persistence, sessions, 'b'), b)
  assert.equal(f.headers.length, 2, 'discovery came from live handles, not a refreshed persistent directory')
})

test('unknown ids or unresolved parent chains conservatively invalidate cached roots', async () => {
  const f = roots(), service = new SessionUsageService()
  for (const hint of [undefined, 'unknown-parent']) {
    const a = await service.tree(f.persistence, undefined, 'a')
    const b = await service.tree(f.persistence, undefined, 'b')
    service.invalidate('new-session', hint)
    assert.notEqual(await service.tree(f.persistence, undefined, 'a'), a)
    assert.notEqual(await service.tree(f.persistence, undefined, 'b'), b)
  }
})

test('reparenting and detaching invalidate old ownership and new ancestors', async () => {
  const f = roots(), child = { id: 'child', parentSession: 'a' }
  f.headers.push(child)
  f.logs.child = [message(7)]
  const service = new SessionUsageService()
  assert.equal(input(await service.tree(f.persistence, undefined, 'a')), 17)
  assert.equal(input(await service.tree(f.persistence, undefined, 'b')), 20)
  child.parentSession = 'b'
  service.invalidate('child', 'b')
  const a = await service.tree(f.persistence, undefined, 'a')
  assert.equal(input(a), 10)
  assert.equal(input(await service.tree(f.persistence, undefined, 'b')), 27)
  delete child.parentSession
  service.invalidate('child', null)
  assert.equal(await service.tree(f.persistence, undefined, 'a'), a)
  assert.equal(input(await service.tree(f.persistence, undefined, 'b')), 20)
})

test('multiple persisted/live parent edges and cycles invalidate every counted ancestor', async () => {
  const f = roots()
  f.headers[0].parentSession = 'child'
  f.headers.push({ id: 'child', parentSession: 'a' })
  let owned = 7
  const liveChild = { id: 'child', header: { id: 'child', parentSession: 'b' }, inheritedEventCount: 0, snapshotEvents: () => [message(owned)] }
  const sessions = { list: () => [liveChild], get: id => id === 'child' ? liveChild : undefined }
  const service = new SessionUsageService()
  const a = await service.tree(f.persistence, sessions, 'a')
  const b = await service.tree(f.persistence, sessions, 'b')
  assert.equal(input(a), 17)
  assert.equal(input(b), 37, 'the existing multi-edge traversal reaches a through the cycle')
  owned = 9
  service.invalidate('child', 'b')
  assert.equal(input(await service.tree(f.persistence, sessions, 'a')), 19)
  assert.equal(input(await service.tree(f.persistence, sessions, 'b')), 39)
})

test('longer history TTL is absolute rather than extended by frequent cache hits', async t => {
  let now = 1000000
  t.mock.method(Date, 'now', () => now)
  const f = fixture([{ id: 'root' }], { root: [message(10)] })
  const service = new SessionUsageService()
  const first = await service.tree(f.persistence, undefined, 'root')
  f.logs.root = [message(20)]
  for (const elapsed of [4000, 8000, 30000, 59999]) {
    now = 1000000 + elapsed
    assert.equal(await service.tree(f.persistence, undefined, 'root'), first)
  }
  now = 1060000
  assert.equal(input(await service.tree(f.persistence, undefined, 'root')), 20)
  assert.equal(f.calls.catalogs, 2)
})

test('the shorter no-event fallback revalidates at exactly four seconds', async t => {
  let now = 1000000
  t.mock.method(Date, 'now', () => now)
  const f = fixture([{ id: 'root' }], { root: [message(10)] })
  const service = new SessionUsageService(4000)
  const first = await service.tree(f.persistence, undefined, 'root')
  f.logs.root = [message(20)]
  now += 3999
  assert.equal(await service.tree(f.persistence, undefined, 'root'), first)
  now++
  assert.equal(input(await service.tree(f.persistence, undefined, 'root')), 20)
})

test('LRU capacity evicts one cold root instead of clearing all 64 histories', async () => {
  const headers = Array.from({ length: 65 }, (_, i) => ({ id: `root-${i}` }))
  const f = fixture(headers, Object.fromEntries(headers.map(({ id }, i) => [id, [message(i + 1)]])))
  const service = new SessionUsageService(), values = []
  for (let i = 0; i < 64; i++) values.push(await service.tree(f.persistence, undefined, `root-${i}`))
  assert.equal(await service.tree(f.persistence, undefined, 'root-0'), values[0])
  await service.tree(f.persistence, undefined, 'root-64')
  assert.equal(await service.tree(f.persistence, undefined, 'root-0'), values[0])
  assert.equal(await service.tree(f.persistence, undefined, 'root-2'), values[2])
  assert.equal(f.calls.catalogs, 65)
  assert.notEqual(await service.tree(f.persistence, undefined, 'root-1'), values[1])
  assert.equal(f.calls.catalogs, 66)
})

for (const joinBeforeRelease of [false, true]) {
  test(`a newer complete snapshot retires older reads across LRU eviction (${joinBeforeRelease ? 'join' : 'publish'})`, async () => {
    const f = roots(), persistedChild = { id: 'child', parentSession: 'a' }
    f.headers.push(persistedChild)
    for (let i = 0; i < 64; i++) {
      const id = `other-${i}`
      f.headers.push({ id })
      f.logs[id] = [message(1)]
    }
    const child = { id: 'child', header: { id: 'child', parentSession: 'a' }, inheritedEventCount: 0, snapshotEvents: () => [message(20)] }
    const sessions = { list: () => [child], get: id => id === 'child' ? child : undefined }
    const gate = deferred(), entered = deferred(), open = f.persistence.open
    let aOpens = 0
    f.persistence.open = async id => {
      const handle = await open(id), read = handle.read
      if (id === 'a' && ++aOpens === 2) handle.read = async (offset, length) => {
        if (offset === 0) { entered.resolve(); await gate.promise }
        return read(offset, length)
      }
      return handle
    }
    const service = new SessionUsageService()
    assert.equal(input(await service.tree(f.persistence, sessions, 'a')), 30)
    child.header.parentSession = 'b'
    service.invalidate('child', 'b')
    const old = service.tree(f.persistence, sessions, 'a')
    await entered.promise
    persistedChild.parentSession = 'b'
    const controller = new AbortController()
    assert.equal(input(await service.tree(f.persistence, sessions, 'a', controller.signal)), 10)
    for (let i = 0; i < 64; i++) await service.tree(f.persistence, sessions, `other-${i}`)
    const afterEviction = joinBeforeRelease ? service.tree(f.persistence, sessions, 'a') : undefined
    gate.resolve()
    assert.equal(input(await old), 30, 'retiring a snapshot does not cancel its original caller')
    const current = afterEviction === undefined ? await service.tree(f.persistence, sessions, 'a') : await afterEviction
    assert.equal(input(current), 10, 'eviction cannot resurrect or rejoin the superseded snapshot')
    assert.equal(aOpens, 4)
    assert.equal(await service.tree(f.persistence, sessions, 'a'), current)
  })
}

test('failed and partial shared computations are removed so the next request can recover', async () => {
  const f = fixture([{ id: 'root' }, { id: 'bad', parentSession: 'root' }], { root: [message(10)] })
  const list = f.persistence.list
  let broken = true
  f.persistence.list = async () => { if (broken) { f.calls.catalogs++; throw new Error('catalog unavailable') }; return list() }
  const service = new SessionUsageService()
  await Promise.all(Array.from({ length: 3 }, () => assert.rejects(service.tree(f.persistence, undefined, 'root'), /catalog unavailable/)))
  assert.equal(f.calls.catalogs, 1)
  broken = false
  const values = await Promise.all(Array.from({ length: 3 }, () => service.tree(f.persistence, undefined, 'root')))
  assert.equal(values[0].coverage.complete, false)
  assert.ok(values.every(value => value === values[0]))
  assert.equal(f.calls.catalogs, 2)
  f.logs.bad = [message(7)]
  const repaired = await service.tree(f.persistence, undefined, 'root')
  assert.equal(repaired.coverage.complete, true)
  assert.equal(input(repaired), 17)
  assert.equal(f.calls.catalogs, 3)
})

test('explicit signal owners stay independent of each other and the shared signal-less read', async () => {
  const a = new AbortController(), b = new AbortController()
  const gates = new Map([a.signal, b.signal, undefined].map(signal => [signal, deferred()]))
  const ready = deferred(), started = [], closed = [], listed = []
  const persistence = {
    async list(options) { listed.push(options?.signal); return [{ header: { id: 'root' } }] },
    async open(id, access, options) {
      assert.equal(access, 'read')
      const signal = options?.signal
      return {
        inheritedEventCount: 0,
        async read(offset, length, options) {
          assert.equal(length, 500)
          assert.equal(options?.signal, signal, 'the caller signal is passed unchanged to paged reads')
          if (offset > 0) return { events: [] }
          started.push(signal)
          if (started.length === 3) ready.resolve()
          await gates.get(signal).promise
          signal?.throwIfAborted()
          return { events: [message(10)] }
        },
        async close() { closed.push(signal) },
      }
    },
  }
  const service = new SessionUsageService()
  const aborted = assert.rejects(service.tree(persistence, undefined, 'root', a.signal), { name: 'AbortError' })
  const independent = service.tree(persistence, undefined, 'root', b.signal)
  const shared = service.tree(persistence, undefined, 'root')
  const joined = service.tree(persistence, undefined, 'root')
  await ready.promise
  assert.deepEqual(listed, [a.signal, b.signal, undefined])
  a.abort()
  gates.get(a.signal).resolve()
  await aborted
  assert.deepEqual(closed, [a.signal])
  gates.get(b.signal).resolve()
  gates.get(undefined).resolve()
  const [own, common, same] = await Promise.all([independent, shared, joined])
  assert.equal(input(own), 10)
  assert.equal(input(common), 10)
  assert.equal(common, same)
  assert.equal(started.length, 3)
  assert.equal(closed.length, 3)
})

test('in-flight reads and cached answers are scoped to their persistence source', async () => {
  const a = fixture([{ id: 'root' }], { root: [message(10)] })
  const b = fixture([{ id: 'root' }], { root: [message(20)] })
  const service = new SessionUsageService()
  const [first, second] = await Promise.all([service.tree(a.persistence, undefined, 'root'), service.tree(b.persistence, undefined, 'root')])
  assert.equal(input(first), 10)
  assert.equal(input(second), 20)
  assert.equal(input(await service.tree(a.persistence, undefined, 'root')), 10)
  assert.equal(input(await service.tree(b.persistence, undefined, 'root')), 20)
})

test('invalidated reads are not joined and their old finally cannot delete a newer in-flight read', async () => {
  const gates = [deferred(), deferred()], entered = [deferred(), deferred()]
  let opens = 0, tokens = 10
  const persistence = {
    async list() { return [{ header: { id: 'root' } }] },
    async open() {
      const index = opens++, events = [message(tokens)]
      return {
        inheritedEventCount: 0,
        async read(offset) {
          if (offset > 0) return { events: [] }
          entered[Math.min(index, 1)].resolve()
          await gates[Math.min(index, 1)].promise
          return { events }
        },
        async close() {},
      }
    },
  }
  const service = new SessionUsageService()
  const old = service.tree(persistence, undefined, 'root')
  await entered[0].promise
  tokens = 20
  service.invalidate('root', null)
  const fresh = service.tree(persistence, undefined, 'root')
  await entered[1].promise
  gates[0].resolve()
  assert.equal(input(await old), 10)
  const joined = service.tree(persistence, undefined, 'root')
  gates[1].resolve()
  const [next, same] = await Promise.all([fresh, joined])
  assert.equal(input(next), 20)
  assert.equal(next, same)
  assert.equal(opens, 2)
  assert.equal(await service.tree(persistence, undefined, 'root'), next)
})

test('an event before catalog publication prevents an old listing from repopulating cache or ancestry', async () => {
  const f = roots(), child = { id: 'child', parentSession: 'a' }
  f.headers.push(child)
  f.logs.child = [message(7)]
  const gate = deferred(), entered = deferred(), list = f.persistence.list
  let listings = 0
  f.persistence.list = async () => {
    const rows = await list()
    if (++listings === 1) { entered.resolve(); await gate.promise }
    return rows
  }
  const service = new SessionUsageService()
  const old = service.tree(f.persistence, undefined, 'a')
  await entered.promise
  delete child.parentSession
  service.invalidate('child', null)
  const fresh = await service.tree(f.persistence, undefined, 'a')
  assert.equal(input(fresh), 10)
  gate.resolve()
  assert.equal(input(await old), 17)
  assert.equal(await service.tree(f.persistence, undefined, 'a'), fresh)
  child.parentSession = 'b'
  service.invalidate('child', 'b')
  assert.equal(await service.tree(f.persistence, undefined, 'a'), fresh, 'late old metadata must not restore the detached a link')
  assert.equal(input(await service.tree(f.persistence, undefined, 'b')), 27)
})

test('a slower older catalog cannot overwrite newer ancestry even without an intervening event', async () => {
  const f = roots(), child = { id: 'child', parentSession: 'a' }
  f.headers.push(child)
  f.logs.child = [message(7)]
  const gate = deferred(), entered = deferred(), list = f.persistence.list
  let listings = 0
  f.persistence.list = async () => {
    const rows = await list()
    if (++listings === 1) { entered.resolve(); await gate.promise }
    return rows
  }
  const service = new SessionUsageService()
  const old = service.tree(f.persistence, undefined, 'a')
  await entered.promise
  child.parentSession = 'b'
  assert.equal(input(await service.tree(f.persistence, undefined, 'b')), 27)
  gate.resolve()
  assert.equal(input(await old), 17)
  f.headers.push({ id: 'grandchild', parentSession: 'child' })
  f.logs.grandchild = [message(3)]
  service.invalidate('grandchild', 'child')
  const next = await service.tree(f.persistence, undefined, 'b')
  assert.equal(next.subagentSessions, 2)
  assert.equal(input(next), 30)
})

test('known unrelated events during log reading do not discard the readable tree cache', async () => {
  const f = roots(), gate = deferred(), entered = deferred(), open = f.persistence.open
  f.persistence.open = async id => {
    const handle = await open(id), read = handle.read
    handle.read = async (offset, length) => {
      if (id === 'a' && offset === 0) { entered.resolve(); await gate.promise }
      return read(offset, length)
    }
    return handle
  }
  const service = new SessionUsageService()
  const pending = service.tree(f.persistence, undefined, 'a')
  await entered.promise
  service.invalidate('b', null)
  gate.resolve()
  const first = await pending
  assert.equal(await service.tree(f.persistence, undefined, 'a'), first)
  assert.equal(f.calls.catalogs, 1)
})

for (const waiting of [false, true]) {
  test(`${waiting ? 'pending' : 'cached'} old membership is invalidated when a moved ancestor receives a new grandchild`, async () => {
    const f = roots(), persistedChild = { id: 'child', parentSession: 'a' }
    f.headers.push({ id: 'unrelated' }, persistedChild)
    f.logs.unrelated = [message(1)]
    const child = { id: 'child', header: { id: 'child', parentSession: 'a' }, inheritedEventCount: 0, snapshotEvents: () => [message(20)] }
    const sessions = { list: () => [child], get: id => id === 'child' ? child : undefined }
    const service = new SessionUsageService()
    assert.equal(input(await service.tree(f.persistence, sessions, 'a')), 30)
    child.header.parentSession = 'b'
    service.invalidate('child', 'b')
    const gate = deferred(), entered = deferred(), open = f.persistence.open
    if (waiting) f.persistence.open = async id => {
      const handle = await open(id), read = handle.read
      handle.read = async (offset, length) => {
        if (id === 'a' && offset === 0) { entered.resolve(); await gate.promise }
        return read(offset, length)
      }
      return handle
    }
    const old = service.tree(f.persistence, sessions, 'a')
    if (waiting) await entered.promise
    else assert.equal(input(await old), 30, 'persistent ancestry has not caught up yet')
    persistedChild.parentSession = 'b'
    const unrelated = await service.tree(f.persistence, sessions, 'unrelated')
    f.headers.push({ id: 'grandchild', parentSession: 'child' })
    f.logs.grandchild = [message(3)]
    service.invalidate('grandchild', 'child')
    gate.resolve()
    assert.equal(input(await old), 30, 'the original caller may finish its old snapshot')
    assert.equal(input(await service.tree(f.persistence, sessions, 'a')), 10, 'old membership containing the moved child must not remain cached')
    assert.equal(await service.tree(f.persistence, sessions, 'unrelated'), unrelated)
  })
}
