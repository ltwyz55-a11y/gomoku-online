import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { randomBytes, randomInt } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { createHttpTransport } from './http-transport.js'

const PORT = Number(process.env.PORT || 3001)
const RECONNECT_MS = Number(process.env.RECONNECT_MS || 120000)
const dist = resolve('dist')
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
const server = createServer((req, res) => {
  let pathname
  try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname) }
  catch { res.writeHead(400); res.end('Bad request'); return }
  if (pathname.startsWith('/api/')) { void httpTransport(req, res, pathname); return }
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (pathname === '/ws') {
    res.writeHead(426, { Upgrade: 'websocket' }); res.end('WebSocket upgrade required'); return
  }
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return
  }
  const path = pathname === '/' ? join(dist, 'index.html') : resolve(dist, '.' + pathname)
  if (!path.startsWith(dist + sep)) { res.writeHead(403); res.end(); return }
  try {
    if (!statSync(path).isFile()) throw new Error('Not a file')
    const body = readFileSync(path)
    res.writeHead(200, {
      'Content-Type': mime[extname(path)] || 'application/octet-stream',
      'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch { res.writeHead(404); res.end('Not found') }
})
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 })
const rooms = new Map()
const emptyBoard = () => Array.from({ length: 15 }, () => Array(15).fill(0))
const send = (ws, data) => { if (ws?.readyState === 1) ws.send(JSON.stringify(data)) }
const error = (ws, message, code = 'INVALID_ACTION') => send(ws, { type: 'error', message, code })
const snapshot = room => ({
  type: 'state', roomId: room.id, revision: room.revision,
  players: room.players.map(p => ({ name: p?.name || '', connected: p?.socket?.readyState === 1 })),
  board: room.board, turn: room.turn, status: room.status, winner: room.winner,
  lastMove: room.history.at(-1) || null, undoOffer: room.undoOffer, restartOffer: room.restartOffer,
})
function broadcast(room) { room.players.forEach(p => send(p?.socket, snapshot(room))) }
function changed(room) { room.revision++; broadcast(room) }
function reset(room) {
  room.board = emptyBoard(); room.history = []; room.turn = 1
  room.status = room.players.every(Boolean) ? 'playing' : 'waiting'
  room.winner = 0; room.undoOffer = null; room.restartOffer = null
}
function winAt(board, x, y, color) {
  return [[1, 0], [0, 1], [1, 1], [1, -1]].some(([dx, dy]) => {
    let count = 1
    for (const sign of [-1, 1]) {
      let cx = x + dx * sign, cy = y + dy * sign
      while (cx >= 0 && cx < 15 && cy >= 0 && cy < 15 && board[cy][cx] === color) {
        count++; cx += dx * sign; cy += dy * sign
      }
    }
    return count >= 5
  })
}
function closeRoom(room, message = '玩家离线超过两分钟，房间已关闭') {
  if (!rooms.delete(room.id)) return
  for (const p of room.players) {
    clearTimeout(p?.timer)
    if (!p?.socket) continue
    p.socket.roomId = null; p.socket.token = null
    send(p.socket, { type: 'closed', message })
  }
}
function attach(ws, room, index, name) {
  const player = room.players[index]
  clearTimeout(player.timer)
  // Replace ownership before closing the old connection: its close event must not detach the new one.
  const previous = player.socket
  player.socket = ws; player.name = name
  ws.roomId = room.id; ws.token = player.token
  if (previous && previous !== ws) {
    previous.roomId = null; previous.token = null
    send(previous, { type: 'replaced', message: '此对局已在另一个页面打开' })
    previous.close(4001, 'Session replaced')
  }
  send(ws, { type: 'joined', roomId: room.id, token: player.token, color: index + 1 })
  changed(room)
}

function acceptConnection(ws) {
  ws.isAlive = true
  ws.on('error', () => {}) // Malformed transport frames close only this client.
  ws.on('pong', () => { ws.isAlive = true })
  let windowStart = Date.now(), count = 0
  ws.on('message', raw => {
    if (Date.now() - windowStart > 1000) { windowStart = Date.now(); count = 0 }
    if (++count > 60) { ws.close(1008, 'Too many requests'); return }
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return error(ws, '无法识别的消息') }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return error(ws, '无法识别的消息')
    if (msg.type === 'heartbeat') { send(ws, { type: 'heartbeat-ack' }); return }
    if (['create', 'join', 'reconnect'].includes(msg.type)) {
      if (ws.roomId) return error(ws, '请先离开当前房间')
      const name = String(msg.name || '棋友').trim().slice(0, 12) || '棋友'
      if (msg.type === 'create') {
        if (rooms.size >= 500) return error(ws, '当前房间较多，请稍后重试')
        let id
        do { id = String(randomInt(100000, 1000000)) } while (rooms.has(id))
        const room = { id, revision: 0, players: [{ token: randomBytes(24).toString('hex') }, null] }
        reset(room); rooms.set(id, room); attach(ws, room, 0, name); return
      }
      const room = rooms.get(String(msg.roomId || ''))
      if (!room) return error(ws, '房间不存在或已关闭，请重新创建', 'ROOM_EXPIRED')
      if (msg.type === 'reconnect') {
        const index = room.players.findIndex(p => p && p.token === msg.token)
        if (index < 0) return error(ws, '重连信息已失效，请重新加入房间', 'SESSION_EXPIRED')
        attach(ws, room, index, name); return
      }
      if (room.players.every(Boolean)) return error(ws, '房间已满，请创建新房间', 'ROOM_FULL')
      const index = room.players.findIndex(p => !p)
      room.players[index] = { token: randomBytes(24).toString('hex') }
      reset(room); attach(ws, room, index, name); return
    }
    const room = rooms.get(ws.roomId)
    if (!room) return error(ws, '请先加入一个房间', 'ROOM_EXPIRED')
    const player = room.players.findIndex(p => p?.token === ws.token && p.socket === ws)
    if (player < 0) return error(ws, '此连接已失效', 'SESSION_EXPIRED')
    if (msg.type === 'leave') { closeRoom(room, '有玩家主动离开，房间已结束'); return }
    // All game commands carry the version they were based on. A duplicate can never alter a later position.
    if (msg.revision !== room.revision) {
      error(ws, '棋局已更新，请根据最新棋盘操作', 'STALE_STATE'); send(ws, snapshot(room)); return
    }
    const color = player + 1
    if (!room.players.every(p => p?.socket?.readyState === 1)) return error(ws, '等待对方重新连接后继续')
    if (msg.type === 'move') {
      const { x, y } = msg
      if (room.status !== 'playing') return error(ws, '当前不能落子')
      if (room.turn !== color) return error(ws, '还没轮到你落子')
      if (room.undoOffer !== null || room.restartOffer !== null) return error(ws, '请先处理对局请求')
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 14 || y < 0 || y > 14 || room.board[y][x]) return error(ws, '这个位置不能落子')
      room.board[y][x] = color; room.history.push({ x, y, color })
      if (winAt(room.board, x, y, color)) { room.status = 'finished'; room.winner = color }
      else if (room.history.length === 225) room.status = 'draw'
      else room.turn = color === 1 ? 2 : 1
    } else if (msg.type === 'undo') {
      if (room.status !== 'playing' || room.history.at(-1)?.color !== color) return error(ws, '只能请求撤回自己刚落下的一子')
      if (room.undoOffer !== null || room.restartOffer !== null) return error(ws, '已有待处理的请求')
      room.undoOffer = player
    } else if (msg.type === 'undo-response') {
      if (room.undoOffer === null || room.undoOffer === player || typeof msg.accept !== 'boolean') return error(ws, '当前没有待处理的悔棋请求')
      if (msg.accept) { const move = room.history.pop(); room.board[move.y][move.x] = 0; room.turn = move.color }
      room.undoOffer = null
    } else if (msg.type === 'resign') {
      if (room.status !== 'playing') return error(ws, '当前对局已结束')
      room.status = 'finished'; room.winner = color === 1 ? 2 : 1
      room.undoOffer = null; room.restartOffer = null
    } else if (msg.type === 'restart') {
      if (room.undoOffer !== null || room.restartOffer !== null) return error(ws, '已有待处理的请求')
      room.restartOffer = player
    } else if (msg.type === 'restart-response') {
      if (room.restartOffer === null || room.restartOffer === player || typeof msg.accept !== 'boolean') return error(ws, '当前没有待处理的再来一局请求')
      if (msg.accept) reset(room)
      else room.restartOffer = null
    } else return error(ws, '无法识别的操作')
    changed(room)
  })
  ws.on('close', () => {
    const room = rooms.get(ws.roomId)
    const p = room?.players.find(p => p?.socket === ws)
    if (!p) return
    p.socket = null
    // Each absent player owns exactly one timer; another player's reconnect cannot cancel it.
    clearTimeout(p.timer)
    p.timer = setTimeout(() => closeRoom(room), RECONNECT_MS)
    p.timer.unref?.()
    changed(room)
  })
}
wss.on('connection', acceptConnection)
const httpTransport = createHttpTransport(acceptConnection)
const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue }
    ws.isAlive = false; ws.ping()
  }
}, 30000)
heartbeatTimer.unref?.()
server.listen(PORT, '0.0.0.0', () => console.log(`Gomoku server listening on ${server.address().port}`))
