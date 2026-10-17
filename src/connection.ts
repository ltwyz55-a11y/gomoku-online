type Options = { WebSocket?: typeof WebSocket; fetch?: typeof fetch; fallbackMs?: number; pollMs?: number }

/** One ordered message stream, with HTTPS polling when WebSocket cannot open. */
export class GameConnection {
  readyState = 0
  mode: 'websocket' | 'https' = 'websocket'
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  private ws: WebSocket | null = null
  private id: string | null = null
  private base: string
  private fetcher: typeof fetch
  private fallbackTimer?: ReturnType<typeof setTimeout>
  private pollTimer?: ReturnType<typeof setTimeout>
  private controllers = new Set<AbortController>()
  private chain = Promise.resolve()
  private pollMs: number
  private stopped = false

  constructor(url: string, options: Options = {}) {
    this.base = new URL(url.replace(/^ws/, 'http')).origin
    this.fetcher = options.fetch || globalThis.fetch.bind(globalThis)
    this.pollMs = options.pollMs ?? 1000
    const Socket = options.WebSocket || globalThis.WebSocket
    try {
      const ws = new Socket(url)
      this.ws = ws
      ws.onopen = () => {
        if (this.stopped || this.mode !== 'websocket') return
        clearTimeout(this.fallbackTimer); this.readyState = 1; this.onopen?.()
      }
      ws.onmessage = e => {
        if (!this.stopped && this.mode === 'websocket') this.onmessage?.({ data: String(e.data) })
      }
      ws.onerror = () => {
        if (this.readyState === 0) void this.fallback()
        else if (!this.stopped && this.mode === 'websocket') this.fail()
      }
      ws.onclose = () => {
        if (this.stopped || this.mode !== 'websocket') return
        if (this.readyState === 0) void this.fallback()
        else this.close()
      }
      this.fallbackTimer = setTimeout(() => { void this.fallback() }, options.fallbackMs ?? 8000)
    } catch { queueMicrotask(() => { void this.fallback() }) }
  }

  private async request(path: string, method = 'GET', body?: string, timeout = 15000) {
    const controller = new AbortController()
    this.controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await this.fetcher(this.base + path, {
        method, cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(this.id ? { Authorization: `Bearer ${this.id}` } : {}) },
        ...(body === undefined ? {} : { body }),
      })
      if (!response.ok && response.status !== 410) throw new Error(`Connection HTTP ${response.status}`)
      return await response.json()
    } finally { clearTimeout(timer); this.controllers.delete(controller) }
  }

  private async fallback() {
    if (this.stopped || this.mode === 'https') return
    this.mode = 'https'; clearTimeout(this.fallbackTimer)
    this.ws?.close(); this.ws = null
    try {
      // A sleeping free instance may take around a minute to wake up.
      const data = await this.request('/api/connect', 'POST', '{}', 75000)
      if (typeof data.id !== 'string') throw new Error('Invalid connection response')
      this.id = data.id
      if (this.stopped) { this.release(); return }
      this.readyState = 1; this.onopen?.(); this.poll()
    } catch { if (!this.stopped) this.fail() }
  }

  private deliver(data: { messages?: unknown[]; closed?: boolean }) {
    if (this.stopped) return
    for (const packet of data.messages || []) {
      if (this.stopped) break
      this.onmessage?.({ data: JSON.stringify(packet) })
    }
    if (data.closed) this.close()
  }

  // Polls and commands share a queue so older HTTP replies never overwrite a newer board.
  private enqueue(task: () => Promise<void>) {
    this.chain = this.chain.then(async () => { if (!this.stopped) await task() })
      .catch(() => { if (!this.stopped) this.fail() })
  }
  private poll() {
    this.enqueue(async () => {
      this.deliver(await this.request('/api/events'))
      if (!this.stopped) this.pollTimer = setTimeout(() => this.poll(), this.pollMs)
    })
  }
  send(raw: string) {
    if (this.readyState !== 1) throw new Error('Connection not open')
    if (this.mode === 'websocket') this.ws!.send(raw)
    else this.enqueue(async () => { this.deliver(await this.request('/api/command', 'POST', raw)) })
  }
  private release() {
    if (!this.id) return
    const id = this.id; this.id = null
    void this.fetcher(this.base + '/api/connection', {
      method: 'DELETE', headers: { Authorization: `Bearer ${id}` }, keepalive: true,
    }).catch(() => {})
  }
  private fail() { this.onerror?.(); this.close() }
  close() {
    if (this.stopped) return
    this.stopped = true; this.readyState = 3
    clearTimeout(this.fallbackTimer); clearTimeout(this.pollTimer)
    this.controllers.forEach(c => c.abort()); this.controllers.clear()
    this.ws?.close(); this.ws = null; this.release(); this.onclose?.()
  }
}
