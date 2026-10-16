import { useEffect, useRef, useState } from 'react'

export type RoomState = {
  roomId: string; revision: number; players: { name: string; connected: boolean }[]
  board: number[][]; turn: number; status: 'waiting' | 'playing' | 'finished' | 'draw'
  winner: number; lastMove: { x: number; y: number; color: number } | null
  undoOffer: number | null; restartOffer: number | null
}
type Session = { roomId: string; token: string }
type Packet = { type: string; [key: string]: unknown }
// Some embedded browsers disable storage. Keep the current game usable in memory.
function read(key: string, session = false) {
  try { return (session ? sessionStorage : localStorage).getItem(key) } catch { return null }
}
function write(key: string, value: string | null, session = false) {
  try {
    const storage = session ? sessionStorage : localStorage
    if (value === null) storage.removeItem(key); else storage.setItem(key, value)
  } catch { /* Storage is optional for the current connection. */ }
}
function savedSession(): Session | null {
  try {
    const data = JSON.parse(read('gomoku-session', true) || 'null')
    return typeof data?.roomId === 'string' && typeof data?.token === 'string' ? data : null
  } catch { return null }
}

export function useRoom() {
  const [name, setName] = useState(() => read('gomoku-name') || '')
  const [room, setRoom] = useState<RoomState | null>(null)
  const [color, setColor] = useState(0)
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [notice, setNotice] = useState('')
  const socket = useRef<WebSocket | null>(null)
  const session = useRef(savedSession())
  const latestRoom = useRef(room)
  const nameRef = useRef(name)
  const pending = useRef<Packet | null>(null)
  const busy = useRef(false)
  const connectRef = useRef<() => void>(() => {})
  const requestTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  latestRoom.current = room; nameRef.current = name
  useEffect(() => { write('gomoku-name', name) }, [name])
  function clearBusy() { busy.current = false; setLoading(false); clearTimeout(requestTimer.current) }
  function markBusy() {
    busy.current = true; setLoading(true); clearTimeout(requestTimer.current)
    requestTimer.current = setTimeout(() => {
      clearBusy(); setErrorMsg('服务器暂未响应，正在重新连接。免费服务唤醒可能需要约一分钟。')
      socket.current?.close()
    }, 15000)
  }
  function clearSession() {
    session.current = null; write('gomoku-session', null, true)
    latestRoom.current = null; setRoom(null); setColor(0); pending.current = null; clearBusy()
  }
  useEffect(() => {
    let disposed = false, replaced = false, failures = 0, lastSeen = Date.now()
    let retry: ReturnType<typeof setTimeout> | undefined
    let handshake: ReturnType<typeof setTimeout> | undefined
    const active = (ws: WebSocket) => !disposed && socket.current === ws
    const schedule = () => {
      clearTimeout(retry)
      if (disposed || replaced) return
      retry = setTimeout(connect, Math.min(1000 * 2 ** Math.min(failures++, 3), 8000))
      if (failures >= 4) setNotice('暂时无法连接，仍在重试。请检查网络；免费服务唤醒可能需要约一分钟。')
    }
    const connect = () => {
      if (disposed || socket.current?.readyState === WebSocket.OPEN || socket.current?.readyState === WebSocket.CONNECTING) return
      replaced = false; clearTimeout(retry)
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
      socket.current = ws
      handshake = setTimeout(() => {
        if (!active(ws) || ws.readyState === WebSocket.OPEN) return
        socket.current = null; ws.close(); setConnected(false); schedule()
      }, 12000)
      ws.onopen = () => {
        if (!active(ws)) return
        clearTimeout(handshake); lastSeen = Date.now(); failures = 0; setConnected(true)
        const packet = session.current ? { type: 'reconnect', ...session.current, name: nameRef.current } : pending.current
        pending.current = null
        if (packet) { markBusy(); ws.send(JSON.stringify(packet)) }
      }
      ws.onmessage = event => {
        if (!active(ws)) return
        let data
        try { data = JSON.parse(event.data) } catch { setErrorMsg('收到无法识别的服务器消息'); return }
        lastSeen = Date.now()
        if (data.type === 'heartbeat-ack') return
        if (data.type === 'joined') {
          const restored = !!session.current
          session.current = { roomId: data.roomId, token: data.token }
          write('gomoku-session', JSON.stringify(session.current), true)
          setColor(data.color); setErrorMsg(''); setNotice(restored ? '连接已恢复' : '已加入房间')
        } else if (data.type === 'state') {
          latestRoom.current = data; setRoom(data); clearBusy()
        } else if (data.type === 'error') {
          clearBusy(); pending.current = null; setErrorMsg(data.message)
          if (['ROOM_EXPIRED', 'SESSION_EXPIRED'].includes(data.code)) { clearSession(); setNotice('请重新创建或加入房间') }
        } else if (data.type === 'closed' || data.type === 'replaced') {
          if (data.type === 'replaced') replaced = true
          clearSession(); setErrorMsg(''); setNotice(data.message || '房间已关闭')
        }
      }
      ws.onclose = () => {
        if (!active(ws)) return
        clearTimeout(handshake); clearBusy(); socket.current = null; setConnected(false)
        if (session.current) setNotice('连接中断，正在恢复对局；房间最多保留两分钟。')
        schedule()
      }
      ws.onerror = () => { if (active(ws)) setConnected(false) }
    }
    connectRef.current = connect
    const wake = () => {
      if (disposed || replaced || document.visibilityState === 'hidden') return
      const ws = socket.current
      if (!ws || ws.readyState === WebSocket.CLOSED) { connect(); return }
      if (ws.readyState === WebSocket.OPEN) {
        if (Date.now() - lastSeen > 35000) {
          socket.current = null; ws.close(); setConnected(false); connect()
        } else ws.send(JSON.stringify({ type: 'heartbeat' }))
      }
    }
    connect()
    const heartbeat = setInterval(wake, 10000)
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake); window.addEventListener('pageshow', wake)
    return () => {
      disposed = true; clearTimeout(retry); clearTimeout(handshake); clearTimeout(requestTimer.current)
      clearInterval(heartbeat); document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake); window.removeEventListener('pageshow', wake)
      const ws = socket.current; socket.current = null; ws?.close()
    }
  }, [])
  function start(type: 'create' | 'join', roomId: string) {
    if (busy.current) return
    setErrorMsg('')
    if (!name.trim()) { setErrorMsg('先输入你的昵称'); return }
    if (type === 'join' && !/^\d{6}$/.test(roomId.trim())) { setErrorMsg('请输入 6 位房间号'); return }
    const packet = { type, name: name.trim(), ...(type === 'join' ? { roomId: roomId.trim() } : {}) }
    markBusy()
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(packet))
    else { pending.current = packet; setNotice('正在连接服务器，请稍候…'); connectRef.current() }
  }
  function send(packet: Packet) {
    if (busy.current) return
    if (socket.current?.readyState !== WebSocket.OPEN) { setErrorMsg('连接中断，恢复后可继续对局'); return }
    setErrorMsg(''); markBusy()
    socket.current.send(JSON.stringify({ ...packet, revision: latestRoom.current?.revision }))
  }
  function leave() {
    if (!window.confirm('确定离开吗？离开后本房间将结束。')) return
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'leave' }))
    clearSession(); setErrorMsg(''); setNotice('已离开房间'); socket.current?.close()
  }
  return { name, setName, room, color, connected, loading, errorMsg, setErrorMsg, notice, setNotice, start, send, leave }
}
