import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'

// An authenticated, short-polling connection uses exactly the same game handler as WebSocket.
export function createHttpTransport(onConnection) {
  const peers = new Map()
  class Peer extends EventEmitter {
    readyState = 1
    messages = []
    touched = Date.now()
    send(raw) {
      if (this.readyState !== 1) return
      if (this.messages.length >= 128) { this.close(); return }
      this.messages.push(JSON.parse(raw))
    }
    close() { if (this.readyState === 1) { this.readyState = 3; this.emit('close') } }
    drain() { return { messages: this.messages.splice(0), closed: this.readyState !== 1 } }
  }
  const sweep = setInterval(() => {
    for (const [id, peer] of peers) {
      if (Date.now() - peer.touched > 45000) { peer.close(); peers.delete(id) }
    }
  }, 5000)
  sweep.unref()
  const reply = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  return async (req, res, path) => {
    if (path === '/api/connect' && req.method === 'POST') {
      req.resume()
      if (peers.size >= 1000) { reply(res, 503, { error: '服务繁忙，请稍后重试' }); return }
      const id = randomBytes(32).toString('hex'), peer = new Peer()
      peers.set(id, peer); onConnection(peer)
      reply(res, 201, { id }); return
    }
    const id = req.headers.authorization?.replace(/^Bearer /, '')
    const peer = peers.get(id)
    if (!peer) { req.resume(); reply(res, 401, { error: '连接已失效，请重新连接' }); return }
    peer.touched = Date.now()
    if (path === '/api/events' && req.method === 'GET') { reply(res, 200, peer.drain()); return }
    if (path === '/api/connection' && req.method === 'DELETE') {
      peer.close(); peers.delete(id); reply(res, 200, { ok: true }); return
    }
    if (path !== '/api/command' || req.method !== 'POST') {
      req.resume(); reply(res, 404, { error: '接口不存在' }); return
    }
    if (peer.readyState !== 1) { req.resume(); reply(res, 410, peer.drain()); return }
    let size = 0, chunks = []
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > 4096) { reply(res, 413, { error: '消息过长' }); return }
        chunks.push(chunk)
      }
      // Recheck ownership after asynchronous body reading.
      if (peer.readyState !== 1) { reply(res, 410, peer.drain()); return }
      peer.emit('message', Buffer.concat(chunks))
      reply(res, 200, peer.drain())
    } catch {
      if (!res.headersSent && !res.destroyed) reply(res, 400, { error: '请求未完成' })
    }
  }
}
