import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { randomBytes } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

const PORT = Number(process.env.PORT || 3001)
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' }
const server = createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname
  if (pathname === '/health') {
    res.writeHead(200, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'})
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (pathname === '/ws') {
    res.writeHead(426, {'Content-Type':'text/plain; charset=utf-8', 'Upgrade':'websocket'})
    res.end('WebSocket upgrade required')
    return
  }
  const dist = join(process.cwd(), 'dist')
  if (!existsSync(dist)) { res.writeHead(200, {'Content-Type':'text/plain; charset=utf-8'}); res.end('Build the web client with npm run build.'); return }
  const requested = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '')
  const candidate = resolve(dist, requested)
  const safeCandidate = candidate.startsWith(resolve(dist) + sep) ? candidate : join(dist, 'index.html')
  const path = requested && existsSync(safeCandidate) ? safeCandidate : join(dist, 'index.html')
  try { res.writeHead(200, {'Content-Type':mime[extname(path)] || 'application/octet-stream'}); res.end(readFileSync(path)) }
  catch { res.writeHead(404); res.end('Not found') }
})
const wss = new WebSocketServer({ server, path: '/ws' })
const rooms = new Map()
const EMPTY = () => Array.from({ length: 15 }, () => Array(15).fill(0))
const send = (ws, data) => { if (ws?.readyState === 1) ws.send(JSON.stringify(data)) }
const snapshot = (room) => ({ type: 'state', roomId: room.id, players: room.players.map(p => ({ name: p?.name || '', connected: !!p?.socket && p.socket.readyState === 1 })), board: room.board, turn: room.turn, status: room.status, winner: room.winner, lastMove: room.lastMove, undoOffer: room.undoOffer, restartOffer: room.restartOffer })
function broadcast(room) { const state = snapshot(room); room.players.forEach(p => p && send(p.socket, state)) }
function error(ws, message) { send(ws, { type: 'error', message }) }
function reset(room) { room.board = EMPTY(); room.turn = 1; room.status = room.players.every(Boolean) ? 'playing' : 'waiting'; room.winner = 0; room.lastMove = null; room.undoOffer = null; room.restartOffer = null }
function winAt(board, x, y, stone) {
  for (const [dx, dy] of [[1,0],[0,1],[1,1],[1,-1]]) {
    let count = 1
    for (const sign of [-1,1]) { let cx=x+dx*sign, cy=y+dy*sign; while(cx>=0&&cx<15&&cy>=0&&cy<15&&board[cy][cx]===stone){count++;cx+=dx*sign;cy+=dy*sign} }
    if(count>=5) return true
  }
  return false
}
function closeRoom(room) { rooms.delete(room.id); for (const p of room.players) send(p?.socket, { type:'closed' }) }

wss.on('connection', ws => {
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()) } catch { return error(ws, '无法识别的消息') }
    if (msg.type === 'heartbeat') { send(ws, { type: 'heartbeat-ack' }); return }
    if (msg.type === 'create' || msg.type === 'join' || msg.type === 'reconnect') {
      const name = String(msg.name || '棋友').trim().slice(0, 12) || '棋友'
      if (msg.type === 'create') {
        let id; do { id = String(Math.floor(100000 + Math.random() * 900000)) } while (rooms.has(id))
        const token = randomBytes(18).toString('hex')
        const room = { id, board: EMPTY(), turn: 1, status: 'waiting', winner: 0, lastMove: null, undoOffer: null, restartOffer: null, players: [{ name, token, socket: ws }, null], cleanup: null }
        rooms.set(id, room); ws.roomId = id; ws.token = token; send(ws, { type: 'joined', roomId: id, token, color: 1 }); broadcast(room); return
      }
      const room = rooms.get(String(msg.roomId || ''))
      if (!room) return error(ws, '房间不存在或已关闭')
      if (msg.type === 'reconnect') {
        const index = room.players.findIndex(p => p?.token === msg.token)
        if (index < 0) return error(ws, '重连信息已失效，请重新加入房间')
        if (room.cleanup) { clearTimeout(room.cleanup); room.cleanup = null }
        room.players[index].socket = ws; room.players[index].name = name; ws.roomId=room.id; ws.token=msg.token
        send(ws, { type: 'joined', roomId: room.id, token: msg.token, color: index + 1 }); broadcast(room); return
      }
      if (room.players.every(Boolean)) return error(ws, '房间已满，请创建新房间')
      if (room.cleanup) { clearTimeout(room.cleanup); room.cleanup = null }
      const token = randomBytes(18).toString('hex'); const index = room.players.findIndex(p => !p)
      room.players[index] = { name, token, socket: ws }; ws.roomId=room.id; ws.token=token
      reset(room); send(ws, { type: 'joined', roomId: room.id, token, color: index + 1 }); broadcast(room); return
    }
    const room = rooms.get(ws.roomId)
    if (!room) return error(ws, '请先加入一个房间')
    const player = room.players.findIndex(p => p?.token === ws.token)
    if (player < 0) return error(ws, '你已离开房间')
    const color = player + 1
    if (msg.type === 'move') {
      const { x, y } = msg
      if (room.status !== 'playing') return error(ws, '当前不能落子')
      if (room.turn !== color) return error(ws, '还没轮到你落子')
      if (!Number.isInteger(x)||!Number.isInteger(y)||x<0||x>14||y<0||y>14||room.board[y][x]) return error(ws, '这个位置不能落子')
      room.board[y][x] = color; room.lastMove = { x, y }; room.undoOffer = null
      if (winAt(room.board,x,y,color)) { room.status='finished'; room.winner=color }
      else if (room.board.every(row => row.every(Boolean))) room.status='draw'
      else room.turn = color === 1 ? 2 : 1
      broadcast(room); return
    }
    if (msg.type === 'undo') { if (room.status !== 'playing' || !room.lastMove) return error(ws, '目前沒有可悔的棋'); room.undoOffer=player; broadcast(room); return }
    if (msg.type === 'undo-response') {
      if (room.undoOffer == null || room.undoOffer === player) return error(ws, '当前没有待处理的悔棋请求')
      if (msg.accept) { const m=room.lastMove; room.board[m.y][m.x]=0; room.turn=room.turn===1?2:1; room.lastMove=null }
      room.undoOffer=null; broadcast(room); return
    }
    if (msg.type === 'resign') { if (room.status !== 'playing') return error(ws, '当前对局已结束'); room.status='finished'; room.winner=color===1?2:1; broadcast(room); return }
    if (msg.type === 'restart') { room.restartOffer=player; broadcast(room); return }
    if (msg.type === 'restart-response') {
      if (room.restartOffer == null || room.restartOffer === player) return error(ws, '当前没有待处理的再来一局请求')
      if (msg.accept) reset(room); else room.restartOffer=null
      broadcast(room); return
    }
  })
  ws.on('close', () => {
    const room=rooms.get(ws.roomId); if(!room) return
    const p=room.players.find(p=>p?.token===ws.token); if(!p || p.socket!==ws) return
    p.socket=null; broadcast(room)
    room.cleanup=setTimeout(()=>closeRoom(room), 120000); room.cleanup.unref?.()
  })
})
const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue }
    ws.isAlive = false
    ws.ping()
  }
}, 30000)
heartbeatTimer.unref?.()
server.listen(PORT, '0.0.0.0', () => console.log(`Gomoku server listening on ${PORT}`))
