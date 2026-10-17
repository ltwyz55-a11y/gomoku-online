import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { GameConnection } from '../src/connection.ts'

let child, url
const connections = []
async function until(fn, label = 'condition') {
  const deadline = Date.now() + 5000
  while (!fn()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await delay(10) }
}
before(async () => {
  child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0' } })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  await until(() => /listening on (\d+)/.test(output))
  url = `ws://127.0.0.1:${output.match(/listening on (\d+)/)[1]}/ws`
})
after(() => { connections.forEach(c => c.close()); child?.kill() })
class BlockedSocket {
  close() { this.onclose?.() }
}
function make(options) {
  const c = new GameConnection(url, { WebSocket, pollMs: 20, ...options })
  connections.push(c)
  c.messages = []; c.state = null; c.session = null
  c.onmessage = ({ data }) => {
    const msg = JSON.parse(data); c.messages.push(msg)
    if (msg.type === 'joined') c.session = msg
    if (msg.type === 'state') c.state = msg
  }
  c.command = packet => c.send(JSON.stringify({ revision: c.state?.revision, ...packet }))
  return c
}
test('blocked WebSocket falls back to HTTPS and plays with a WebSocket opponent', async () => {
  const a = make({ WebSocket: BlockedSocket, fallbackMs: 20 }), b = make()
  await until(() => a.readyState === 1 && b.readyState === 1)
  assert.equal(a.mode, 'https'); assert.equal(b.mode, 'websocket')
  a.command({ type: 'create', name: 'fallback black' }); await until(() => a.state)
  b.command({ type: 'join', roomId: a.session.roomId, name: 'WS white' })
  await until(() => a.state.status === 'playing' && b.state)
  a.command({ type: 'move', x: 0, y: 0 }); await until(() => b.state.board[0][0] === 1)
  b.command({ type: 'move', x: 1, y: 0 }); await until(() => a.state.board[0][1] === 2)
  assert.deepEqual(a.state, b.state)
  const saved = a.session; a.close()
  await until(() => !b.state.players[0].connected)
  const restored = make({ WebSocket: BlockedSocket, fallbackMs: 20 })
  await until(() => restored.readyState === 1)
  restored.command({ ...saved, type: 'reconnect' })
  await until(() => restored.state && b.state.players[0].connected)
  assert.equal(restored.state.board[0][0], 1)
  restored.command({ type: 'leave' }); await until(() => b.messages.some(m => m.type === 'closed'))
  restored.close(); b.close()
})
test('closing during a slow connection never opens it later', async () => {
  let opened = 0
  const c = make({ WebSocket: BlockedSocket, fallbackMs: 1, fetch: async (...args) => {
    if (String(args[0]).endsWith('/api/connect')) await delay(100)
    return fetch(...args)
  } })
  c.onopen = () => opened++
  await delay(20); c.close(); await delay(150)
  assert.equal(c.readyState, 3); assert.equal(opened, 0)
})
test('temporary HTTP failure closes once and does not send queued actions', async () => {
  let closes = 0, errors = 0
  const c = make({ WebSocket: BlockedSocket, fallbackMs: 1, fetch: async () => new Response('{}', { status: 503 }) })
  c.onclose = () => closes++; c.onerror = () => errors++
  await until(() => c.readyState === 3)
  assert.equal(closes, 1); assert.equal(errors, 1)
})
