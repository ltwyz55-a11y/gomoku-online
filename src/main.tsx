import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowRight, Check, Copy, DoorOpen, LoaderCircle, RotateCcw, Swords, X, Crown, Handshake } from 'lucide-react'
import { useRoom } from './useRoom'
import './style.css'

function App(){
  const { name, setName, room, color, connected, loading, errorMsg, notice, setNotice, start: openRoom, send, leave } = useRoom()
  const [roomInput, setRoomInput] = useState(() => new URLSearchParams(location.search).get('room')?.replace(/\D/g, '').slice(0, 6) || '')
  const [copied, setCopied] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  useEffect(() => { if (room) setRoomInput(room.roomId) }, [room?.roomId])
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer) }, [copied])
  const start = (type: 'create' | 'join') => openRoom(type, roomInput)
  const invitation = room ? `${location.origin}${location.pathname}?room=${room.roomId}` : ''
  const copy = async () => {
    if (!room) return
    let success = false
    try { await navigator.clipboard.writeText(invitation); success = true }
    catch {
      const input = document.createElement('textarea')
      input.value = invitation; input.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
      document.body.appendChild(input); input.select(); input.setSelectionRange(0, invitation.length)
      try { success = document.execCommand('copy') } catch { /* Show a selectable link below. */ }
      input.remove()
    }
    setCopied(success); setShowInvite(!success)
    setNotice(success ? '邀请链接已复制，粘贴到微信发给朋友即可' : '请长按下方邀请链接复制，或直接发送房间号')
  }
  const me = room?.players[color-1], opponent = room?.players[color===1?1:0]
  const ready = connected && !!opponent?.connected && !loading
  const pendingOffer = room?.undoOffer !== null && room?.undoOffer !== undefined || room?.restartOffer !== null && room?.restartOffer !== undefined
  const myTurn = ready && !pendingOffer && room?.status==='playing' && room.turn===color
  const winnerColor = room?.status === 'finished' && (room.winner === 1 || room.winner === 2) ? room.winner : null
  const winnerName = winnerColor ? room?.players[winnerColor - 1]?.name || '棋友' : ''
  const winnerLabel = winnerColor ? `${winnerName}（${winnerColor === 1 ? '黑棋' : '白棋'}）` : ''
  const statusText = !room ? '' : winnerColor ? `${winnerColor === 1 ? '黑棋' : '白棋'}获胜` : room.status==='draw' ? '平局，再来一局？' : !connected ? '连接中断，正在恢复' : room.status==='waiting' ? '等待对手加入' : room.status==='finished' ? '本局结束' : !opponent?.connected ? '对手暂离，等待重连' : pendingOffer ? '等待处理对局请求' : room.turn===color ? '轮到你落子' : '等待对方落子'
  const promptUndo = room?.undoOffer === (color===1?1:0), promptRestart = room?.restartOffer === (color===1?1:0)
  const feedback = errorMsg || notice
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" onClick={e => { e.preventDefault(); if (room) leave() }}>
          <span className="brand-mark" aria-hidden="true"><span/><span/></span>
          <span>弈间五子棋</span>
        </a>
        <span className={`connection ${connected ? 'online' : ''}`}><i/>{connected ? '已连接' : '连接中…'}</span>
      </header>
      {!room ? (
        <main className="landing">
          <section className="join-card" aria-labelledby="join-title">
            <h1 id="join-title">双人五子棋</h1>
            <label className="field-label" htmlFor="nickname">你的昵称</label>
            <input id="nickname" className="text-input" maxLength={12} autoComplete="nickname" placeholder="输入昵称" value={name} onChange={e => setName(e.target.value)}/>
            <button className="primary-btn" disabled={loading} onClick={() => start('create')}>
              {loading ? <LoaderCircle className="spin" size={20}/> : <Swords size={20}/>}
              创建房间
            </button>
            <div className="divider" aria-hidden="true"/>
            <label className="field-label" htmlFor="room-code">加入朋友的房间</label>
            <div className="join-row">
              <input id="room-code" className="text-input room-field" inputMode="numeric" pattern="[0-9]*" maxLength={6} placeholder="6 位房间号" value={roomInput} onChange={e => setRoomInput(e.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={e => e.key === 'Enter' && start('join')}/>
              <button className="join-btn" disabled={loading} onClick={() => start('join')}>加入<ArrowRight size={20}/></button>
            </div>
            {feedback && <div className={errorMsg ? 'error-msg' : 'notice-msg'} role={errorMsg ? 'alert' : 'status'}>{feedback}</div>}
          </section>
        </main>
      ) : (
        <main className={`game-layout ${room.status === 'waiting' ? 'waiting-game' : ''}`}>
          <section className="play-area">
            <div className="game-title">
              <h1>{statusText}</h1>
              <button className="leave-btn" onClick={leave}><DoorOpen size={20}/><span>离开</span></button>
            </div>
            {winnerColor && (
              <div className="result-banner" role="status" aria-live="polite" aria-atomic="true">
                <Crown size={26} aria-hidden="true"/>
                <strong>胜利方：{winnerLabel}</strong>
              </div>
            )}
            <div className="players">
              <PlayerCard label="你" player={me?.name || name || '我'} color={color} active={!!myTurn || room.status === 'waiting'} connected={me?.connected !== false}/>
              <PlayerCard label="对手" player={opponent?.name || '等待加入'} color={color === 1 ? 2 : 1} active={room.turn === (color === 1 ? 2 : 1) && room.status === 'playing'} connected={!!opponent?.connected}/>
            </div>
            <div className="board-wrap">
              <div className="board-frame">
                <div className="board" role="grid" aria-label="五子棋棋盘">
                  {room.board.map((row, y) => row.map((stone, x) => (
                    <button key={`${x}-${y}`} aria-label={`${x+1}列${y+1}行${stone ? '已有棋子' : myTurn ? '落子' : '等待对手'}`} disabled={!!stone || !myTurn} className={`intersection ${stone ? 'occupied' : ''}`} style={{left:`${x/14*100}%`, top:`${y/14*100}%`}} onClick={() => send({type:'move', x, y})}>
                      {stone !== 0 && <span className={`piece ${stone === 1 ? 'piece-black' : 'piece-white'}`}>{room.lastMove?.x === x && room.lastMove.y === y && <i/>}</span>}
                    </button>
                  )))}
                  {[[3,3],[11,3],[7,7],[3,11],[11,11]].map(([x,y]) => <span key={`${x}-${y}`} className="star-point" style={{left:`${x/14*100}%`, top:`${y/14*100}%`}}/>)}
                </div>
              </div>
            </div>
          </section>
          <aside className="side-panel">
            <section className="control-card" aria-label="对局操作">
              {pendingOffer && !promptUndo && !promptRestart && <p className="notice-msg" role="status">已发送请求，等待对方回应</p>}
              {promptUndo || promptRestart ? (
                <div className="request-box">
                  <div><strong>{promptUndo ? '对手请求悔棋' : '对手请求再来一局'}</strong><p>{promptUndo ? '同意后撤回对方最近一步' : '同意后清空棋盘，黑棋先行'}</p></div>
                  <button className="accept" disabled={!ready} onClick={() => send({type:promptUndo ? 'undo-response' : 'restart-response', accept:true})}><Check size={20}/>同意</button>
                  <button className="decline" disabled={!ready} onClick={() => send({type:promptUndo ? 'undo-response' : 'restart-response', accept:false})}><X size={20}/>拒绝</button>
                </div>
              ) : (
                <div className="game-actions">
                  <button className="action-btn" disabled={!ready || room.lastMove?.color !== color || room.status !== 'playing' || pendingOffer} onClick={() => send({type:'undo'})}><RotateCcw size={20}/><span>悔棋</span></button>
                  <button className="action-btn" disabled={!ready || room.status === 'waiting' || pendingOffer} onClick={() => { if (room.status !== 'playing' || window.confirm('申请重新开始？对方同意后会清空当前棋盘。')) send({type:'restart'}) }}><RotateCcw size={20}/><span>再来一局</span></button>
                  {room.status === 'playing' && <button className="action-btn resign" disabled={!ready} onClick={() => { if (window.confirm('确定认输并结束本局吗？')) send({type:'resign'}) }}><Handshake size={20}/><span>认输</span></button>}
                </div>
              )}
            </section>
            {feedback && <div className={errorMsg ? 'toast error-toast' : 'toast'} role={errorMsg ? 'alert' : 'status'}>{feedback}</div>}
            <section className="room-card" aria-label="邀请朋友">
              <div className="room-number"><span>房间号</span><strong>{room.roomId}</strong></div>
              <button className="copy-link" onClick={copy}>{copied ? <Check size={20}/> : <Copy size={20}/>}<span>{copied ? '已复制' : '复制邀请链接'}</span></button>
              {showInvite && <><label className="field-label" htmlFor="invitation">长按下方链接复制</label><input id="invitation" className="text-input invitation" readOnly value={invitation} onFocus={e => e.target.select()}/></>}
            </section>
          </aside>
        </main>
      )}
    </div>
  )
}

function PlayerCard({label, player, color, active, connected}:{label:string; player:string; color:number; active:boolean; connected:boolean}) {
  return (
    <div className={`player-card ${active ? 'active' : ''}`}>
      <span className={`player-stone ${color === 1 ? 'black' : 'white'}`} aria-hidden="true"/>
      <div className="player-info"><span>{label} · {color === 1 ? '黑棋' : '白棋'}</span><strong>{player}</strong></div>
      <span className={`player-status ${connected ? '' : 'offline'}`}><i/>{connected ? '在线' : '暂离'}</span>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>)
