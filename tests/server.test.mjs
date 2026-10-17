import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'

let child, base, socketUrl
const clients = []
async function until(predicate, message = 'Timed out') {
  const deadline = Date.now() + 4000
  while (!predicate()) { if (Date.now() > deadline) throw new Error(message); await delay(5) }
}
before(async () => {
  child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', RECONNECT_MS: '350' } })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  await until(() => /listening on (\d+)/.test(output), 'Server did not start: ' + output)
  base = `http://127.0.0.1:${output.match(/listening on (\d+)/)[1]}`
  socketUrl = base.replace('http:', 'ws:') + '/ws'
})
after(() => { clients.forEach(c => c.ws.terminate()); child?.kill() })
async function client() {
  const c = { ws: new WebSocket(socketUrl), messages: [], state: null, session: null }
  c.ws.on('message', raw => {
    const msg = JSON.parse(raw)
    c.messages.push(msg)
    if (msg.type === 'state') c.state = msg
    if (msg.type === 'joined') c.session = msg
  })
  await until(() => c.ws.readyState === 1)
  clients.push(c)
  c.send = msg => c.ws.send(JSON.stringify({ revision: c.state?.revision, ...msg }))
  c.error = async msg => {
    const from = c.messages.length
    c.send(msg)
    await until(() => c.messages.slice(from).some(m => m.type === 'error'))
    return c.messages.slice(from).find(m => m.type === 'error')
  }
  return c
}
async function pair(t) {
  const a = await client(), b = await client()
  a.send({ type: 'create', name: '黑棋' })
  await until(() => a.state)
  b.send({ type: 'join', roomId: a.session.roomId, name: '白棋' })
  await until(() => a.state.status === 'playing' && b.state)
  t.after(() => { a.ws.close(); b.ws.close() })
  return [a, b]
}
async function act(c, other, msg) {
  const revision = c.state.revision
  c.send(msg)
  await until(() => c.state.revision > revision && other.state.revision === c.state.revision, JSON.stringify(msg))
  assert.deepEqual(c.state, other.state)
}

test('health, static files, malformed URL and WebSocket payloads', async () => {
  assert.equal((await fetch(base + '/health')).status, 200)
  assert.equal((await fetch(base + '/%E0%A4')).status, 400)
  assert.equal((await fetch(base + '/ws')).status, 426)
  assert.equal((await fetch(base + '/missing.js')).status, 404)
  const c = await client()
  for (const raw of ['null', '[]', 'bad json', '3']) {
    const n = c.messages.length
    c.ws.send(raw)
    await until(() => c.messages.length > n)
    assert.equal(c.messages.at(-1).type, 'error')
  }
  c.send({ type: 'heartbeat' })
  await until(() => c.messages.at(-1).type === 'heartbeat-ack')
  assert.equal((await fetch(base + '/health')).status, 200)
  c.ws.close()
})
test('room capacity, turns, bounds, duplicates, undo, resignation and restart', async t => {
  const [a, b] = await pair(t), stranger = await client()
  assert.equal((await stranger.error({ type: 'join', roomId: a.session.roomId })).code, 'ROOM_FULL')
  assert.equal((await stranger.error({ type: 'join', roomId: '000000' })).code, 'ROOM_EXPIRED')
  assert.match((await a.error({ type: 'create' })).message, /离开/)
  assert.match((await b.error({ type: 'move', x: 1, y: 1 })).message, /轮到/)
  for (const x of [-1, 15, 1.2, '3']) assert.match((await a.error({ type: 'move', x, y: 0 })).message, /位置/)
  const oldRevision = a.state.revision
  await act(a, b, { type: 'move', x: 7, y: 7 })
  assert.equal((await a.error({ type: 'move', x: 7, y: 7, revision: oldRevision })).code, 'STALE_STATE')
  assert.match((await b.error({ type: 'move', x: 7, y: 7 })).message, /位置/)
  assert.match((await b.error({ type: 'undo' })).message, /自己/)
  await act(a, b, { type: 'undo' })
  assert.equal(b.state.undoOffer, 0)
  assert.match((await a.error({ type: 'undo-response', accept: true })).message, /没有/)
  await act(b, a, { type: 'undo-response', accept: false })
  assert.equal(a.state.board[7][7], 1)
  await act(a, b, { type: 'undo' })
  await act(b, a, { type: 'undo-response', accept: true })
  assert.equal(a.state.board[7][7], 0)
  assert.equal(a.state.turn, 1)
  await act(a, b, { type: 'move', x: 7, y: 7 })
  await act(b, a, { type: 'move', x: 8, y: 7 })
  await act(b, a, { type: 'undo' })
  assert.equal(a.state.undoOffer, 1)
  await act(a, b, { type: 'undo-response', accept: true })
  assert.deepEqual(a.state.lastMove, { x: 7, y: 7, color: 1 })
  await act(b, a, { type: 'resign' })
  assert.equal(a.state.winner, 1)
  assert.equal(a.state.status, 'finished')
  await act(b, a, { type: 'restart' })
  assert.equal(a.state.restartOffer, 1)
  await act(a, b, { type: 'restart-response', accept: false })
  assert.equal(a.state.status, 'finished')
  await act(a, b, { type: 'restart' })
  await act(b, a, { type: 'restart-response', accept: true })
  assert.equal(a.state.turn, 1)
  assert.equal(a.state.board.flat().filter(Boolean).length, 0)
  a.send({ type: 'leave' })
  await until(() => b.messages.at(-1).type === 'closed')
  assert.equal((await stranger.error({ type: 'join', roomId: a.session.roomId })).code, 'ROOM_EXPIRED')
  stranger.ws.close()
})
for (const [dx, dy, startY] of [[1, 0, 0], [0, 1, 0], [1, 1, 0], [1, -1, 4]]) {
  test(`five in a row: ${dx},${dy}`, async t => {
    const [a, b] = await pair(t)
    for (let i = 0; i < 5; i++) {
      await act(a, b, { type: 'move', x: i * dx, y: startY + i * dy })
      if (i < 4) await act(b, a, { type: 'move', x: i * 2, y: 14 })
    }
    assert.equal(a.state.status, 'finished'); assert.equal(a.state.winner, 1)
    assert.match((await b.error({ type: 'move', x: 12, y: 12 })).message, /不能落子/)
  })
}
test('225 legal moves produce a draw with identical boards', async t => {
  const [a, b] = await pair(t)
  const positions = [[], []]
  for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) positions[(x + 2 * y) % 4 < 2 ? 0 : 1].push({ x, y })
  for (let i = 0; i < 225; i++) {
    const side = i % 2
    await act(side ? b : a, side ? a : b, { type: 'move', ...positions[side].shift() })
    await delay(20)
  }
  assert.equal(a.state.status, 'draw'); assert.equal(a.state.winner, 0)
})
test('reconnect preserves board, replaces old connection, and cancels only its timer', async t => {
  const [a, b] = await pair(t)
  await act(a, b, { type: 'move', x: 2, y: 3 })
  const recovered = await client()
  recovered.send({ ...a.session, type: 'reconnect', name: '恢复黑棋' })
  await until(() => recovered.state && a.ws.readyState === 3)
  assert.equal(recovered.state.board[3][2], 1)
  assert.ok(a.messages.some(m => m.type === 'replaced'))
  b.ws.close()
  await until(() => !recovered.state.players[1].connected)
  const b2 = await client()
  b2.send({ ...b.session, type: 'reconnect' })
  await until(() => b2.state && recovered.state.players[1].connected)
  await delay(400)
  await act(b2, recovered, { type: 'move', x: 3, y: 3 })
  recovered.ws.close()
  await until(() => !b2.state.players[0].connected)
  assert.match((await b2.error({ type: 'resign' })).message, /重新连接/)
  await until(() => b2.messages.some(m => m.type === 'closed'))
  const expired = await client()
  assert.equal((await expired.error({ ...a.session, type: 'reconnect' })).code, 'ROOM_EXPIRED')
  b2.ws.close(); expired.ws.close()
})

async function httpClient(t) {
  const response = await fetch(base + '/api/connect', { method: 'POST' })
  assert.equal(response.status, 201)
  const { id } = await response.json()
  const c = { state: null, session: null, messages: [] }
  c.request = async (path, method = 'GET', body) => {
    const r = await fetch(base + path, {
      method, headers: { Authorization: `Bearer ${id}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify({ revision: c.state?.revision, ...body }) } : {}),
    })
    const result = await r.json()
    for (const msg of result.messages || []) {
      c.messages.push(msg)
      if (msg.type === 'joined') c.session = msg
      if (msg.type === 'state') c.state = msg
    }
    return { status: r.status, ...result }
  }
  c.send = body => c.request('/api/command', 'POST', body)
  c.poll = () => c.request('/api/events')
  t.after(() => c.request('/api/connection', 'DELETE'))
  return c
}
test('HTTPS fallback authenticates, synchronizes two players and reconnects', async t => {
  assert.equal((await fetch(base + '/api/events')).status, 401)
  const a = await httpClient(t), b = await httpClient(t)
  await a.send({ type: 'create', name: 'HTTP black' })
  await b.send({ type: 'join', roomId: a.session.roomId, name: 'HTTP white' })
  await a.poll()
  assert.deepEqual(a.state, b.state)
  await a.send({ type: 'move', x: 4, y: 4 }); await b.poll()
  assert.equal(b.state.board[4][4], 1)
  await a.send({ type: 'undo' }); await b.poll()
  await b.send({ type: 'undo-response', accept: true }); await a.poll()
  assert.deepEqual(a.state, b.state); assert.equal(a.state.board[4][4], 0)
  const saved = a.session
  await a.request('/api/connection', 'DELETE'); await b.poll()
  assert.equal(b.state.players[0].connected, false)
  const recovered = await httpClient(t)
  await recovered.send({ ...saved, type: 'reconnect' }); await b.poll()
  assert.equal(b.state.players[0].connected, true)
  await recovered.send({ type: 'move', x: 5, y: 5 }); await b.poll()
  assert.equal(b.state.board[5][5], 1)
  await b.send({ type: 'resign' }); await recovered.poll()
  assert.equal(recovered.state.winner, 1)
  await recovered.send({ type: 'leave' }); await b.poll()
  assert.equal(b.messages.at(-1).type, 'closed')
})
test('HTTPS and WebSocket players share one authoritative board', async t => {
  const a = await httpClient(t), b = await client()
  t.after(() => b.ws.close())
  await a.send({ type: 'create', name: 'HTTP black' })
  b.send({ type: 'join', roomId: a.session.roomId, name: 'WS white' })
  await until(() => b.state); await a.poll()
  await a.send({ type: 'move', x: 6, y: 6 })
  await until(() => b.state.board[6][6] === 1)
  b.send({ type: 'move', x: 7, y: 6 })
  await until(() => b.state.board[6][7] === 2); await a.poll()
  assert.deepEqual(a.state, b.state)
  await a.send({ type: 'leave' })
})
