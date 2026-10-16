import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowRight, Check, Copy, DoorOpen, Link2, LoaderCircle, RotateCcw, Shield, Sparkles, Swords, X, Crown, Handshake } from 'lucide-react'
import './style.css'

type Stone = 0 | 1 | 2
type RoomState = { roomId:string; players:{name:string;connected:boolean}[]; board:Stone[][]; turn:number; status:'waiting'|'playing'|'finished'|'draw'; winner:number; lastMove:{x:number;y:number}|null; undoOffer:number|null; restartOffer:number|null }
type Session = { roomId:string; token:string }
type Packet = { type:string; name?:string; roomId?:string; token?:string; [key:string]:unknown }
const savedName = () => localStorage.getItem('gomoku-name') || ''
const readSession = ():Session|null => {
  try { const value=JSON.parse(localStorage.getItem('gomoku-session')||'null'); return value?.roomId&&value?.token?value:null }
  catch { localStorage.removeItem('gomoku-session'); return null }
}

function App(){
  const [name,setName]=useState(savedName()), [roomInput,setRoomInput]=useState(''), [room,setRoom]=useState<RoomState|null>(null), [color,setColor]=useState(0)
  const [errorMsg,setErrorMsg]=useState(''), [notice,setNotice]=useState(''), [connected,setConnected]=useState(false), [copied,setCopied]=useState(false), [loading,setLoading]=useState(false)
  const socketRef=useRef<WebSocket|null>(null), pendingRef=useRef<Packet|null>(null), lastPongRef=useRef(Date.now()), connectRef=useRef<()=>void>(()=>{})
  const wsUrl=useMemo(()=>`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`,[])
  useEffect(()=>{localStorage.setItem('gomoku-name',name)},[name])
  useEffect(()=>{
    const restorePacket=()=>{const session=readSession();return session?{type:'reconnect',...session,name:savedName()||'棋友'}:null}
    pendingRef.current=restorePacket()
    let disposed=false
    const handle=(d:any)=>{
      if(d.type==='error'){
        const reconnecting=pendingRef.current?.type==='reconnect'
        pendingRef.current=null;setLoading(false);setErrorMsg(d.message)
        if(reconnecting){localStorage.removeItem('gomoku-session');setRoom(null);setNotice('房间已失效，请重新创建或加入房间')}
      }else if(d.type==='joined'){
        const wasReconnect=pendingRef.current?.type==='reconnect'
        setColor(d.color);localStorage.setItem('gomoku-session',JSON.stringify({roomId:d.roomId,token:d.token}));setLoading(false);pendingRef.current=null;setErrorMsg('');setNotice(wasReconnect?'连接已恢复':'已加入房间')
      }else if(d.type==='state'){setRoom(d);setRoomInput(d.roomId);setErrorMsg('')}
      else if(d.type==='closed'){setRoom(null);localStorage.removeItem('gomoku-session');setNotice('房间已关闭')}
      else if(d.type==='heartbeat-ack')lastPongRef.current=Date.now()
    }
    const connect=()=>{
      if(disposed||socketRef.current?.readyState===WebSocket.CONNECTING||socketRef.current?.readyState===WebSocket.OPEN)return
      const ws=new WebSocket(wsUrl);socketRef.current=ws
      ws.onopen=()=>{setConnected(true);lastPongRef.current=Date.now();if(pendingRef.current){ws.send(JSON.stringify(pendingRef.current));setLoading(true)}}
      ws.onclose=()=>{if(socketRef.current===ws){setConnected(false);setLoading(false);pendingRef.current=restorePacket()??pendingRef.current;if(pendingRef.current?.type==='reconnect')setNotice('连接中断，正在尝试恢复…')}}
      ws.onerror=()=>setConnected(false)
      ws.onmessage=e=>{try{handle(JSON.parse(e.data))}catch{setErrorMsg('收到无法识别的服务器消息')}}
    }
    connectRef.current=connect
    const onVisibility=()=>{if(document.visibilityState!=='visible')return;const ws=socketRef.current;if(!ws||ws.readyState===WebSocket.CLOSED){pendingRef.current=restorePacket();connect()}else if(ws.readyState===WebSocket.OPEN){if(Date.now()-lastPongRef.current>90000)ws.close();else ws.send(JSON.stringify({type:'heartbeat'}))}}
    connect()
    const retry=setInterval(()=>{const ws=socketRef.current;if(!ws||ws.readyState===WebSocket.CLOSED){pendingRef.current=restorePacket();connect()}else if(ws.readyState===WebSocket.OPEN){if(Date.now()-lastPongRef.current>90000){ws.close();return}ws.send(JSON.stringify({type:'heartbeat'}))}},30000)
    document.addEventListener('visibilitychange',onVisibility)
    window.addEventListener('pageshow',onVisibility)
    return()=>{disposed=true;clearInterval(retry);document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('pageshow',onVisibility);socketRef.current?.close()}
  },[wsUrl])
  const send=(data:object)=>{if(socketRef.current?.readyState===WebSocket.OPEN)socketRef.current.send(JSON.stringify(data));else setErrorMsg('连接中断，请稍候重试')}
  const start=(type:'create'|'join')=>{setErrorMsg('');if(!name.trim()){setErrorMsg('先输入你的昵称');return}if(type==='join'&&!/^\d{6}$/.test(roomInput.trim())){setErrorMsg('请输入 6 位房间号');return}localStorage.removeItem('gomoku-session');setRoom(null);setLoading(true);const packet={type,name:name.trim(),...(type==='join'?{roomId:roomInput.trim()}:{})};pendingRef.current=packet;if(socketRef.current?.readyState===WebSocket.OPEN)send(packet);else{setErrorMsg('正在连接服务器…');connectRef.current()}}
  const leave=()=>{pendingRef.current=null;localStorage.removeItem('gomoku-session');socketRef.current?.close();setRoom(null);setColor(0);setRoomInput('');setErrorMsg('');setNotice('已离开房间')}
  const copy=async()=>{if(!room)return;try{await navigator.clipboard.writeText(`${location.origin}${location.pathname}?room=${room.roomId}`);setCopied(true);setTimeout(()=>setCopied(false),1800)}catch{setErrorMsg('复制失败，请手动记下房间号')}}
  useEffect(()=>{const id=new URLSearchParams(location.search).get('room');if(id)setRoomInput(id)},[])
  const me=room?.players[color-1], opponent=room?.players[color===1?1:0], myTurn=room?.status==='playing'&&room.turn===color
  const statusText=!room?'':!connected?'连接中断，正在恢复':room.status==='waiting'?'等待对手加入':room.status==='draw'?'平局，再来一局？':room.status==='finished'?(room.winner===color?'恭喜你赢了！':'本局结束'):(myTurn?'轮到你落子':'等待对方落子')
  const promptUndo=room?.undoOffer===(color===1?2:1),promptRestart=room?.restartOffer===(color===1?2:1)
  return <div className="app-shell"><header className="topbar"><a className="brand" href="#" onClick={e=>{e.preventDefault();if(room)leave()}}><span className="brand-mark"><span/><span/></span><span>弈间</span><span className="brand-tag">GOMOKU CLUB</span></a><div className="top-right"><span className={`connection ${connected?'online':''}`}><i/>{connected?'服务已连接':'正在连接'}</span><span className="avatar">{name.trim().slice(0,1)||'弈'}</span></div></header>
  {!room?<main className="landing"><section className="hero"><div className="eyebrow"><Sparkles size={14}/> 一局棋，连接彼此</div><h1>好棋友，<span>棋盘上见。</span></h1><p>邀一位朋友，安静地下一盘棋。</p><div className="hero-art"><div className="art-board">{Array.from({length:7},(_,i)=><React.Fragment key={i}><span className="art-line h" style={{top:`${12.5+i*12.5}%`}}/><span className="art-line v" style={{left:`${12.5+i*12.5}%`}}/></React.Fragment>)}{['black s1','white s2','black s3','white s4','black s5','white s6','black s7','white s8'].map((s,i)=><i key={i} className={`stone ${s}`}/>)}</div><div className="art-caption">十九道，落子从容</div></div></section><section className="join-card"><div className="card-head"><span className="small-icon"><Swords size={18}/></span><div><h2>开始一盘</h2><p>创建房间，或加入朋友的对局</p></div></div><label className="field-label" htmlFor="nickname">你的昵称</label><input id="nickname" className="text-input" maxLength={12} placeholder="棋盘上的名字" value={name} onChange={e=>setName(e.target.value)}/><button className="primary-btn" disabled={loading} onClick={()=>start('create')}>{loading?<LoaderCircle className="spin" size={17}/>:<Swords size={17}/>}创建新房间<ArrowRight size={17}/></button><div className="divider"><span>或者加入对局</span></div><div className="join-row"><input className="text-input room-field" inputMode="numeric" maxLength={6} placeholder="输入 6 位房间号" value={roomInput} onChange={e=>setRoomInput(e.target.value.replace(/\D/g,'').slice(0,6))} onKeyDown={e=>e.key==='Enter'&&start('join')}/><button className="join-btn" disabled={loading} onClick={()=>start('join')}>加入<ArrowRight size={16}/></button></div>{errorMsg&&<div className="error-msg">{errorMsg}</div>}{notice&&!errorMsg&&<div className="notice-msg">{notice}</div>}<div className="privacy"><Shield size={14}/> 无需注册，房间只对持有房间号的人开放</div></section></main>:<main className="game-layout"><section className="play-area"><div className="game-title"><div><div className="eyebrow"><span className="live-dot"/> 实时对局 <span className="round-pill">房间 {room.roomId}</span></div><h1>{statusText}</h1><p>{room.status==='waiting'?'把房间号分享给朋友，棋盘马上开始。':room.status==='playing'?(myTurn?'想好就落子，祝你手气好。':'对手正在思考中…'):room.status==='draw'?'棋逢对手，不妨再下一盘。':'落子如有神，一盘好棋。'}</p></div><button className="icon-button leave-btn" onClick={leave}><DoorOpen size={17}/><span>离开房间</span></button></div><div className="board-wrap"><div className="board-frame"><div className="board" role="grid" aria-label="五子棋棋盘">{room.board.map((row,y)=>row.map((stone,x)=><button key={`${x}-${y}`} aria-label={`${x+1}列${y+1}行${stone?'已有棋子':myTurn?'落子':'等待对手'}`} disabled={!!stone||!myTurn} className={`intersection ${stone?'occupied':''} ${room.lastMove?.x===x&&room.lastMove.y===y?'last-move':''}`} style={{left:`${x/14*100}%`,top:`${y/14*100}%`}} onClick={()=>send({type:'move',x,y})}>{stone!==0&&<span className={`piece ${stone===1?'piece-black':'piece-white'}`}>{room.lastMove?.x===x&&room.lastMove.y===y&&<i/>}</span>}</button>))}<div className="star-point" style={{left:'28.571%',top:'28.571%'}}/><div className="star-point" style={{left:'71.429%',top:'28.571%'}}/><div className="star-point" style={{left:'50%',top:'50%'}}/><div className="star-point" style={{left:'28.571%',top:'71.429%'}}/><div className="star-point" style={{left:'71.429%',top:'71.429%'}}/></div></div><div className="board-meta"><span>15 × 15</span><span>黑棋先行</span></div></div><div className="players"><PlayerCard label="你" player={me?.name||name||'我'} color={color} active={!!myTurn||room.status==='waiting'} connected={me?.connected!==false} isMe/><div className="versus">VS</div><PlayerCard label="对手" player={opponent?.name||'等待加入…'} color={color===1?2:1} active={room.turn===(color===1?2:1)&&room.status==='playing'} connected={!!opponent?.connected} isMe={false}/></div></section><aside className="side-panel"><div className="room-card"><div className="room-card-top"><div><div className="eyebrow">私人棋局</div><h3>邀请朋友</h3></div><span className="lock-mark"><Link2 size={17}/></span></div><p>分享房间号给朋友，准备好就开局。</p><div className="room-number"><span>{room.roomId.split('').map((d,i)=><b key={i}>{d}</b>)}</span><button title="复制邀请链接" onClick={copy}>{copied?<Check size={17}/>:<Copy size={17}/>}</button></div><button className="copy-link" onClick={copy}>{copied?'已复制邀请链接':'复制邀请链接'} <ArrowRight size={15}/></button>{room.status==='waiting'&&<div className="waiting-indicator"><span className="pulse"/>等待朋友加入中</div>}</div><div className="control-card"><div className="section-label">对局操作</div>{promptUndo?<div className="request-box"><div><b>对手请求悔棋</b><small>接受后将撤回最近一步</small></div><button className="accept" onClick={()=>send({type:'undo-response',accept:true})}><Check size={15}/></button><button className="decline" onClick={()=>send({type:'undo-response',accept:false})}><X size={15}/></button></div>:promptRestart?<div className="request-box"><div><b>对手想再来一局</b><small>接受后棋盘将重新开始</small></div><button className="accept" onClick={()=>send({type:'restart-response',accept:true})}><Check size={15}/></button><button className="decline" onClick={()=>send({type:'restart-response',accept:false})}><X size={15}/></button></div>:<><button className="action-row" disabled={!room.lastMove||room.status!=='playing'||room.undoOffer!==null} onClick={()=>send({type:'undo'})}><RotateCcw size={16}/><span>请求悔棋</span><ArrowRight size={15}/></button><button className="action-row" disabled={room.status==='waiting'} onClick={()=>send({type:'restart'})}><RotateCcw size={16}/><span>{room.status==='playing'?'申请再来一局':'再来一局'}</span><ArrowRight size={15}/></button>{room.status==='playing'&&<button className="action-row resign" onClick={()=>send({type:'resign'})}><Handshake size={16}/><span>认输</span><ArrowRight size={15}/></button>}</>}</div>{(errorMsg||notice)&&<div className={errorMsg?'toast error-toast':'toast'}>{errorMsg||notice}</div>}<div className="tip-card"><span className="tip-icon"><Crown size={16}/></span><div><b>一点小提示</b><p>连成五子即可获胜。棋逢对手，享受过程。</p></div></div><div className="footer-note">弈间 · 一方棋盘，两位知己 <span>✳</span></div></aside></main>}
  <footer className="page-footer"><span>弈间 GOMOKU CLUB</span><span>把时间留给好棋</span></footer></div>
}
function PlayerCard({label,player,color,active,connected,isMe}:{label:string;player:string;color:number;active:boolean;connected:boolean;isMe:boolean}){return <div className={`player-card ${active?'active':''}`}><div className={`player-stone ${color===1?'black':'white'}`}><i/></div><div className="player-info"><span>{label} · {color===1?'黑棋':'白棋'}</span><b>{player}{isMe&&<em>你</em>}</b></div><span className={`player-status ${connected?'':'offline'}`}><i/>{connected?'在线':'暂离'}</span></div>}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>)
