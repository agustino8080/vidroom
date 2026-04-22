/**
 * VidRoom — servidor todo-en-uno
 * El HTML está embebido: NO necesitas carpeta public/
 *
 * 1. npm install
 * 2. node server.js
 * 3. Abre http://localhost:3000
 */
 
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const crypto   = require('crypto');
 
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});
 
// ─── TURN config (para producción, cambia estos valores) ──────────────────────
const TURN_SECRET   = process.env.TURN_SECRET   || '';
const TURN_HOST     = process.env.TURN_HOST     || '';
const TURN_PORT     = process.env.TURN_PORT     || '3478';
const TURN_TLS_PORT = process.env.TURN_TLS_PORT || '5349';
 
function generateTurnCredentials(id) {
  const ttl      = 3600;
  const timestamp = Math.floor(Date.now() / 1000) + ttl;
  const username  = `${timestamp}:${id}`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return { username, credential };
}
 
// ─── ICE servers API ──────────────────────────────────────────────────────────
app.get('/api/ice-servers', (req, res) => {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  if (TURN_HOST && TURN_SECRET) {
    const { username, credential } = generateTurnCredentials(req.query.socketId || 'anon');
    servers.push(
      { urls: `turn:${TURN_HOST}:${TURN_PORT}?transport=udp`, username, credential },
      { urls: `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`, username, credential },
      { urls: `turns:${TURN_HOST}:${TURN_TLS_PORT}?transport=tcp`, username, credential }
    );
  }
  res.json(servers);
});
 
app.get('/health', (req, res) => res.json({ status: 'ok', rooms: rooms.size }));
 
// ─── Almacenamiento ───────────────────────────────────────────────────────────
const rooms        = new Map();
const socketToRoom = new Map();
 
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateInviteCode() : code;
}
 
function leaveCurrentRoom(socket) {
  const code = socketToRoom.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  const user = room.users.get(socket.id);
  room.users.delete(socket.id);
  socketToRoom.delete(socket.id);
  socket.leave(code);
  if (room.users.size === 0) {
    setTimeout(() => { if (rooms.has(code) && rooms.get(code).users.size === 0) rooms.delete(code); }, 60000);
  } else {
    io.to(code).emit('user-left', { socketId: socket.id, name: user?.name || 'Alguien', users: Array.from(room.users.values()) });
  }
  console.log(`[Leave] ${user?.name} salió de ${code}`);
}
 
// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);
 
  socket.on('create-room', ({ userName, roomName }, cb) => {
    if (!userName?.trim()) return cb({ error: 'Nombre requerido' });
    const inviteCode = generateInviteCode();
    const room = { id: uuidv4(), name: (roomName || 'Mi sala').trim(), inviteCode, users: new Map() };
    const user = { socketId: socket.id, name: userName.trim() };
    room.users.set(socket.id, user);
    rooms.set(inviteCode, room);
    socketToRoom.set(socket.id, inviteCode);
    socket.join(inviteCode);
    console.log(`[Create] "${room.name}" (${inviteCode}) — ${userName}`);
    cb({ success: true, inviteCode, roomName: room.name, users: [user] });
  });
 
  socket.on('join-room', ({ userName, inviteCode }, cb) => {
    if (!userName?.trim()) return cb({ error: 'Nombre requerido' });
    const code = (inviteCode || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb({ error: 'Sala no encontrada. Verifica el código.' });
    leaveCurrentRoom(socket);
    const user = { socketId: socket.id, name: userName.trim() };
    room.users.set(socket.id, user);
    socketToRoom.set(socket.id, code);
    socket.join(code);
    socket.to(code).emit('user-joined', { socketId: socket.id, name: user.name, users: Array.from(room.users.values()) });
    console.log(`[Join] ${userName} → ${code} (${room.users.size} en sala)`);
    cb({ success: true, inviteCode: code, roomName: room.name, users: Array.from(room.users.values()) });
  });
 
  socket.on('chat-message', ({ text }) => {
    const code = socketToRoom.get(socket.id);
    const room = code && rooms.get(code);
    if (!room || !text?.trim()) return;
    const user = room.users.get(socket.id);
    io.to(code).emit('chat-message', {
      id: uuidv4(), socketId: socket.id, name: user?.name || 'Anónimo',
      text: text.trim(), time: new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
    });
  });
 
  socket.on('webrtc-offer',         ({ to, offer })     => io.to(to).emit('webrtc-offer',         { from: socket.id, offer }));
  socket.on('webrtc-answer',        ({ to, answer })    => io.to(to).emit('webrtc-answer',        { from: socket.id, answer }));
  socket.on('webrtc-ice-candidate', ({ to, candidate }) => io.to(to).emit('webrtc-ice-candidate', { from: socket.id, candidate }));
 
  socket.on('call-start', () => {
    const code = socketToRoom.get(socket.id);
    if (!code) return;
    const user = rooms.get(code)?.users.get(socket.id);
    socket.to(code).emit('call-started', { by: user?.name || 'Alguien', socketId: socket.id });
  });
 
  socket.on('call-end', () => {
    const code = socketToRoom.get(socket.id);
    if (code) socket.to(code).emit('call-ended', { socketId: socket.id });
  });
 
  socket.on('disconnecting', () => leaveCurrentRoom(socket));
  socket.on('disconnect',    () => console.log(`[-] ${socket.id}`));
});
 
// ─── HTML embebido (sin carpeta public/) ──────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>VidRoom</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg:#0b0f1c; --panel:#111827; --surface:#1a2235; --card:#202d40;
  --input-bg:#263045; --accent:#3b82f6; --accent2:#6366f1; --glow:rgba(59,130,246,.18);
  --green:#22c55e; --red:#ef4444; --tx:#f0f4ff; --txm:#7a8ba8; --txd:#4a5a72;
  --bdr:rgba(255,255,255,.08); --out:#1d4ed8; --in-bbl:#1e293b;
  --ease:.18s cubic-bezier(.4,0,.2,1);
  font-family:'Segoe UI',system-ui,sans-serif;
}
html,body{width:100%;height:100%;overflow:hidden;background:var(--bg);color:var(--tx);}
.screen{display:none;width:100%;height:100%;}
.screen.active{display:flex;}
 
/* ── LOGIN ─────────────────────────────────────────────── */
#s-login{
  align-items:center;justify-content:center;
  background:
    radial-gradient(ellipse at 65% 35%,rgba(59,130,246,.13) 0%,transparent 65%),
    radial-gradient(ellipse at 20% 75%,rgba(99,102,241,.10) 0%,transparent 55%),
    var(--bg);
}
.login-card{
  background:var(--panel);border:1px solid var(--bdr);border-radius:22px;
  padding:44px 40px;width:420px;max-width:95vw;
  box-shadow:0 32px 80px rgba(0,0,0,.55);
}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:6px;}
.logo-icon{
  width:44px;height:44px;border-radius:13px;
  background:linear-gradient(135deg,var(--accent),var(--accent2));
  display:flex;align-items:center;justify-content:center;font-size:24px;
}
.logo h1{font-size:24px;font-weight:700;letter-spacing:-.5px;}
.logo-sub{color:var(--txm);font-size:13px;margin-bottom:28px;}
.tabs{display:flex;gap:4px;background:var(--surface);border-radius:10px;padding:4px;margin-bottom:22px;}
.tabs button{
  flex:1;padding:8px;border:none;border-radius:8px;cursor:pointer;
  font-size:13px;font-weight:600;transition:var(--ease);
  background:transparent;color:var(--txm);
}
.tabs button.on{background:var(--card);color:var(--tx);}
.fg{margin-bottom:13px;}
.fg label{display:block;font-size:12px;color:var(--txm);margin-bottom:5px;font-weight:600;letter-spacing:.3px;}
.fg input{
  width:100%;padding:11px 14px;border-radius:10px;border:1px solid var(--bdr);
  background:var(--input-bg);color:var(--tx);font-size:14px;outline:none;transition:var(--ease);
}
.fg input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--glow);}
.fg input::placeholder{color:var(--txd);}
#inp-code{font-size:24px;font-weight:700;letter-spacing:6px;text-align:center;text-transform:uppercase;}
.btn-main{
  width:100%;padding:13px;border:none;border-radius:11px;cursor:pointer;
  background:linear-gradient(135deg,var(--accent),var(--accent2));
  color:#fff;font-size:15px;font-weight:700;transition:var(--ease);margin-top:4px;
}
.btn-main:hover{opacity:.88;transform:translateY(-1px);}
.btn-main:active{transform:scale(.98);}
.btn-main:disabled{opacity:.5;cursor:not-allowed;transform:none;}
.err{color:var(--red);font-size:13px;margin-top:8px;min-height:18px;text-align:center;}
 
/* ── APP ───────────────────────────────────────────────── */
#s-app{flex-direction:row;}
.sidebar{
  width:300px;min-width:260px;background:var(--panel);
  border-right:1px solid var(--bdr);display:flex;flex-direction:column;height:100%;
}
.sb-head{
  padding:16px 14px 12px;border-bottom:1px solid var(--bdr);
  display:flex;align-items:center;justify-content:space-between;
}
.me-info{display:flex;align-items:center;gap:10px;}
.av{
  width:38px;height:38px;border-radius:50%;flex-shrink:0;cursor:pointer;
  background:linear-gradient(135deg,var(--accent),var(--accent2));
  display:flex;align-items:center;justify-content:center;
  font-weight:700;font-size:14px;color:#fff;position:relative;
}
.av .dot{
  position:absolute;bottom:0;right:0;width:10px;height:10px;
  border-radius:50%;border:2px solid var(--panel);background:var(--green);
}
.me-name{font-weight:600;font-size:14px;}
.me-sub{font-size:11px;color:var(--txm);}
.invite-badge{
  background:var(--surface);border:1px solid var(--bdr);border-radius:10px;
  padding:10px 14px;margin:12px 14px 6px;
}
.invite-badge .lbl{font-size:10px;color:var(--txm);font-weight:600;letter-spacing:.5px;text-transform:uppercase;margin-bottom:4px;}
.invite-row{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.invite-code{font-size:22px;font-weight:700;letter-spacing:5px;color:var(--accent);font-family:monospace;}
.copy-btn{
  background:var(--accent);color:#fff;border:none;border-radius:7px;
  padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;transition:var(--ease);
}
.copy-btn:hover{opacity:.82;}
.room-name-lbl{padding:6px 14px 0;font-size:11px;color:var(--txm);}
.section-lbl{padding:10px 14px 4px;font-size:10px;font-weight:700;color:var(--txd);letter-spacing:.7px;text-transform:uppercase;}
.user-list{flex:1;overflow-y:auto;padding:0 8px 8px;}
.user-list::-webkit-scrollbar{width:3px;}
.user-list::-webkit-scrollbar-thumb{background:var(--bdr);border-radius:3px;}
.u-item{display:flex;align-items:center;gap:10px;padding:9px 8px;border-radius:10px;}
.u-item .uname{font-size:13px;font-weight:500;}
.u-item .ustatus{font-size:11px;color:var(--txm);}
.u-item.me .uname::after{content:' (tú)';color:var(--txd);font-size:11px;}
.icon-btn{
  background:transparent;border:none;cursor:pointer;padding:7px;border-radius:8px;
  color:var(--txm);display:flex;align-items:center;justify-content:center;
  transition:var(--ease);font-size:17px;
}
.icon-btn:hover{background:var(--surface);color:var(--tx);}
.chat-panel{flex:1;display:flex;flex-direction:column;background:var(--bg);height:100%;}
.chat-head{
  padding:13px 18px;display:flex;align-items:center;justify-content:space-between;
  background:var(--panel);border-bottom:1px solid var(--bdr);
}
.chat-head-left{display:flex;align-items:center;gap:12px;}
.ch-name{font-weight:700;font-size:15px;}
.ch-status{font-size:12px;color:var(--green);}
.ch-actions{display:flex;gap:2px;}
.msgs{flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:5px;}
.msgs::-webkit-scrollbar{width:4px;}
.msgs::-webkit-scrollbar-thumb{background:var(--bdr);border-radius:4px;}
.sys{
  align-self:center;font-size:11px;color:var(--txd);background:var(--surface);
  padding:3px 14px;border-radius:99px;border:1px solid var(--bdr);margin:4px 0;
}
.date-sep{text-align:center;margin:8px 0;}
.date-sep span{font-size:11px;color:var(--txd);background:var(--surface);padding:2px 12px;border-radius:99px;}
.msg{display:flex;flex-direction:column;max-width:70%;}
.msg.out{align-self:flex-end;align-items:flex-end;}
.msg.in{align-self:flex-start;align-items:flex-start;}
.bubble{padding:10px 14px;border-radius:16px;font-size:14px;line-height:1.5;word-break:break-word;}
.msg.out .bubble{background:var(--out);border-bottom-right-radius:4px;}
.msg.in  .bubble{background:var(--in-bbl);border-bottom-left-radius:4px;border:1px solid var(--bdr);}
.btime{font-size:10px;color:var(--txd);margin-top:3px;padding:0 4px;}
.bname{font-size:11px;font-weight:700;color:var(--accent);margin-bottom:2px;padding:0 2px;}
.input-bar{
  padding:11px 14px;background:var(--panel);border-top:1px solid var(--bdr);
  display:flex;align-items:flex-end;gap:8px;
}
.input-wrap{
  flex:1;background:var(--surface);border:1px solid var(--bdr);border-radius:20px;
  display:flex;align-items:flex-end;padding:8px 12px;gap:8px;transition:var(--ease);
}
.input-wrap:focus-within{border-color:var(--accent);}
.input-wrap textarea{
  flex:1;background:transparent;border:none;outline:none;resize:none;max-height:110px;
  color:var(--tx);font-size:14px;line-height:1.5;padding:0;font-family:inherit;
}
.input-wrap textarea::placeholder{color:var(--txd);}
.send-btn{
  width:36px;height:36px;border-radius:50%;
  background:linear-gradient(135deg,var(--accent),var(--accent2));
  border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;
  color:#fff;flex-shrink:0;transition:var(--ease);
}
.send-btn:hover{opacity:.85;transform:scale(1.06);}
.send-btn:active{transform:scale(.94);}
.send-btn svg{width:16px;height:16px;}
 
/* ══════════════════════════════════════════════════════
   VIDEO CALL OVERLAY
══════════════════════════════════════════════════════ */
#s-call{
  position:fixed;inset:0;z-index:200;
  background:rgba(5,8,18,.97);
  align-items:center;justify-content:center;flex-direction:column;display:none;
}
#s-call.active{display:flex;}
 
.call-box{
  width:960px;max-width:99vw;
  background:var(--panel);border-radius:22px;border:1px solid var(--bdr);
  overflow:hidden;box-shadow:0 40px 100px rgba(0,0,0,.7);
  display:flex;flex-direction:column;
  /* altura adaptable según modo */
  max-height:96vh;
}
 
/* ── Cabecera de llamada ────────────────────────────── */
.call-head{
  padding:12px 18px;display:flex;align-items:center;justify-content:space-between;
  border-bottom:1px solid var(--bdr);flex-shrink:0;
}
.call-title{font-weight:700;font-size:15px;}
.call-timer{font-size:13px;color:var(--green);font-family:monospace;}
.call-head-actions{display:flex;gap:4px;align-items:center;}
 
/* ══ GRID NORMAL: varios tiles ══════════════════════ */
.video-grid{
  display:grid;gap:3px;background:var(--bg);
  flex:1;overflow:hidden;
  grid-template-columns:repeat(auto-fit,minmax(260px,1fr));
  /* altura máxima en modo normal */
  min-height:220px;max-height:58vh;
}
 
/* ══ MODO ENFOCADO: 1 grande + miniaturas abajo ═════ */
.video-grid.focused-mode{
  display:flex;flex-direction:column;
  max-height:72vh;
}
.focused-main{
  flex:1;background:var(--bg);position:relative;overflow:hidden;
  display:flex;align-items:center;justify-content:center;
  min-height:0;
}
.focused-main video{
  width:100%;height:100%;object-fit:contain;display:none;
}
.focused-main video.active{display:block;}
.thumb-strip{
  display:flex;gap:3px;background:var(--bg);
  padding:3px;flex-shrink:0;overflow-x:auto;
  height:90px;
}
.thumb-strip::-webkit-scrollbar{height:3px;}
.thumb-strip::-webkit-scrollbar-thumb{background:var(--bdr);border-radius:3px;}
 
/* ══ TILE base ══════════════════════════════════════ */
.vtile{
  background:var(--surface);position:relative;
  display:flex;align-items:center;justify-content:center;
  overflow:hidden;cursor:pointer;
}
/* ratio normal en grilla */
.video-grid:not(.focused-mode) .vtile{aspect-ratio:16/9;}
 
/* tile en modo miniatura (thumb-strip) */
.vtile.thumb{
  width:140px;height:84px;flex-shrink:0;border-radius:8px;
  border:2px solid transparent;transition:border-color var(--ease);
}
.vtile.thumb:hover{border-color:var(--accent);}
.vtile.thumb.active-thumb{border-color:var(--accent);}
 
/* tile expandido (ocupa focused-main) */
.vtile.expanded{
  width:100%;height:100%;border-radius:0;cursor:default;
}
 
.vtile video{width:100%;height:100%;object-fit:cover;display:none;}
.vtile video.active{display:block;}
.vtile.expanded video{object-fit:contain;}
 
.vtile .av-lg{
  width:60px;height:60px;border-radius:50%;
  background:linear-gradient(135deg,var(--accent),var(--accent2));
  display:flex;align-items:center;justify-content:center;
  font-size:24px;font-weight:700;color:#fff;pointer-events:none;
}
.vtile.thumb .av-lg{width:36px;height:36px;font-size:14px;}
 
.vtile .tname{
  position:absolute;bottom:7px;left:8px;font-size:11px;font-weight:600;
  background:rgba(0,0,0,.65);padding:2px 9px;border-radius:99px;pointer-events:none;
}
.vtile.thumb .tname{font-size:9px;bottom:4px;left:5px;padding:1px 6px;}
 
.vtile.local-tile{outline:2px solid var(--accent);outline-offset:-2px;}
.vtile .muted-icon{position:absolute;top:7px;right:7px;font-size:15px;display:none;pointer-events:none;}
.vtile.muted .muted-icon{display:block;}
 
/* Botones flotantes sobre cada tile (solo visibles en hover en modo grid) */
.vtile .tile-actions{
  position:absolute;top:6px;left:6px;display:flex;gap:4px;
  opacity:0;transition:opacity var(--ease);pointer-events:none;
}
.video-grid:not(.focused-mode) .vtile:hover .tile-actions{opacity:1;pointer-events:all;}
/* En focused-main siempre visible */
.focused-main .vtile .tile-actions{opacity:1;pointer-events:all;}
 
.tile-btn{
  background:rgba(0,0,0,.7);border:1px solid rgba(255,255,255,.18);
  border-radius:6px;padding:4px 7px;font-size:12px;cursor:pointer;
  color:#fff;line-height:1;transition:background var(--ease);
  white-space:nowrap;
}
.tile-btn:hover{background:rgba(59,130,246,.8);}
 
/* ══ MODO PANTALLA COMPLETA (fullscreen del tile) ═══ */
.vtile.fullscreen-tile{
  position:fixed!important;inset:0!important;z-index:500!important;
  width:100vw!important;height:100vh!important;
  border-radius:0!important;cursor:default;
}
.vtile.fullscreen-tile video{object-fit:contain;}
.vtile.fullscreen-tile .tile-actions{opacity:1;pointer-events:all;}
.vtile.fullscreen-tile .tname{bottom:14px;left:14px;font-size:13px;}
 
/* ── Controles de llamada ───────────────────────── */
.call-ctrls{
  padding:14px 18px;display:flex;align-items:center;justify-content:center;
  gap:10px;border-top:1px solid var(--bdr);flex-shrink:0;flex-wrap:wrap;
}
.cc{
  width:48px;height:48px;border-radius:50%;border:1px solid var(--bdr);
  background:var(--surface);color:var(--tx);cursor:pointer;
  display:flex;align-items:center;justify-content:center;font-size:18px;
  transition:var(--ease);position:relative;
}
.cc:hover{background:var(--card);transform:scale(1.07);}
.cc.off{background:var(--card);border-color:var(--txd);}
.cc.active-ctrl{background:var(--accent);border-color:var(--accent);}
.cc.danger{background:var(--red);border-color:var(--red);}
.cc::after{
  content:attr(data-tip);position:absolute;bottom:calc(100% + 7px);
  left:50%;transform:translateX(-50%);
  background:var(--card);color:var(--tx);font-size:11px;padding:4px 9px;
  border-radius:6px;white-space:nowrap;opacity:0;pointer-events:none;
  transition:var(--ease);border:1px solid var(--bdr);
}
.cc:hover::after{opacity:1;}
 
/* TURN status badge */
.turn-badge{
  display:inline-flex;align-items:center;gap:5px;
  font-size:10px;font-weight:600;padding:3px 10px;border-radius:99px;
  background:var(--surface);border:1px solid var(--bdr);
}
.turn-badge .dot-s{width:7px;height:7px;border-radius:50%;background:var(--txd);}
.turn-badge.ready .dot-s{background:var(--green);}
.turn-badge.ready{color:var(--green);}
 
/* incoming call banner */
.call-banner{
  position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
  background:var(--panel);border:1px solid var(--bdr);border-radius:16px;
  padding:16px 24px;gap:16px;z-index:300;
  box-shadow:0 12px 40px rgba(0,0,0,.6);display:none;align-items:center;
}
.call-banner.show{display:flex;}
.banner-text{font-weight:600;font-size:14px;}
.banner-sub{font-size:12px;color:var(--txm);}
.banner-btns{display:flex;gap:8px;}
.b-acc{background:var(--green);}
.b-dec{background:var(--red);}
.b-acc,.b-dec{
  width:44px;height:44px;border-radius:50%;border:none;cursor:pointer;
  display:flex;align-items:center;justify-content:center;font-size:20px;transition:var(--ease);
}
.b-acc:hover,.b-dec:hover{opacity:.82;transform:scale(1.07);}
 
/* toast */
.toast{
  position:fixed;top:18px;left:50%;transform:translateX(-50%);
  background:var(--card);border:1px solid var(--bdr);border-radius:10px;
  padding:10px 20px;font-size:13px;font-weight:600;z-index:600;
  opacity:0;transition:opacity .25s;pointer-events:none;
}
.toast.show{opacity:1;}
 
@media(max-width:660px){
  .sidebar{display:none;}
  .video-grid{grid-template-columns:1fr;}
  .thumb-strip{height:72px;}
  .vtile.thumb{width:110px;height:66px;}
}
</style>
</head>
<body>
 
<div class="toast" id="toast"></div>
 
<!-- ══ LOGIN ══════════════════════════════════════════════ -->
<div id="s-login" class="screen active">
  <div class="login-card">
    <div class="logo">
      <div class="logo-icon">💬</div>
      <h1>VidRoom</h1>
    </div>
    <p class="logo-sub">Chat + Videollamada en tiempo real</p>
    <div class="tabs">
      <button id="tab-create" class="on" onclick="setTab('create')">Crear sala</button>
      <button id="tab-join" onclick="setTab('join')">Unirse con código</button>
    </div>
    <div class="fg">
      <label>Tu nombre</label>
      <input id="inp-name" type="text" placeholder="¿Cómo te llamas?" maxlength="32" autocomplete="off"/>
    </div>
    <div id="create-fields">
      <div class="fg">
        <label>Nombre de la sala <span style="color:var(--txd)">(opcional)</span></label>
        <input id="inp-room" type="text" placeholder="Mi sala de trabajo" maxlength="40"/>
      </div>
    </div>
    <div id="join-fields" style="display:none">
      <div class="fg">
        <label>Código de invitación</label>
        <input id="inp-code" type="text" placeholder="ABC123" maxlength="6" autocomplete="off"
               oninput="this.value=this.value.toUpperCase().replace(/[^A-Z0-9]/g,'')"/>
      </div>
    </div>
    <div class="err" id="login-err"></div>
    <button class="btn-main" id="auth-btn" onclick="doAuth()">Crear sala →</button>
  </div>
</div>
 
<!-- ══ APP ════════════════════════════════════════════════ -->
<div id="s-app" class="screen">
  <aside class="sidebar">
    <div class="sb-head">
      <div class="me-info">
        <div class="av" id="my-av">?<div class="dot"></div></div>
        <div>
          <div class="me-name" id="my-name-lbl">—</div>
          <div class="me-sub">En línea</div>
        </div>
      </div>
      <button class="icon-btn" onclick="copyInvite()" title="Copiar enlace">📋</button>
    </div>
    <div class="invite-badge">
      <div class="lbl">Código de invitación</div>
      <div class="invite-row">
        <div class="invite-code" id="invite-display">——</div>
        <button class="copy-btn" onclick="copyInvite()">Copiar</button>
      </div>
    </div>
    <div class="room-name-lbl" id="room-name-lbl"></div>
    <div style="padding:6px 14px 2px;display:flex;align-items:center;gap:6px;">
      <span class="turn-badge" id="turn-badge"><span class="dot-s"></span>TURN</span>
      <span style="font-size:10px;color:var(--txd)" id="turn-label">cargando…</span>
    </div>
    <div class="section-lbl">Participantes</div>
    <div class="user-list" id="user-list"></div>
    <div style="padding:12px 14px;border-top:1px solid var(--bdr);margin-top:auto;">
      <button class="btn-main" style="font-size:13px;padding:10px" onclick="leaveRoom()">Salir de la sala</button>
    </div>
  </aside>
 
  <main class="chat-panel">
    <div class="chat-head">
      <div class="chat-head-left">
        <div class="av" id="room-av" style="border-radius:10px">💬</div>
        <div>
          <div class="ch-name" id="ch-room-name">Sala</div>
          <div class="ch-status" id="ch-status">● conectado</div>
        </div>
      </div>
      <div class="ch-actions">
        <button class="icon-btn" title="Videollamada" onclick="startCall()">📹</button>
        <button class="icon-btn" title="Copiar enlace" onclick="copyInvite()">🔗</button>
      </div>
    </div>
    <div class="msgs" id="msgs">
      <div class="date-sep"><span>Hoy</span></div>
    </div>
    <div class="input-bar">
      <div class="input-wrap">
        <textarea id="msg-ta" placeholder="Escribe un mensaje…" rows="1"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat()}"
          oninput="autoResize(this)"></textarea>
      </div>
      <button class="send-btn" onclick="sendChat()">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
          <path d="M22 2L11 13"/><path d="M22 2L15 22 11 13 2 9l20-7z"/>
        </svg>
      </button>
    </div>
  </main>
</div>
 
<!-- ══ VIDEO CALL ══════════════════════════════════════════ -->
<div id="s-call">
  <div class="call-box" id="call-box">
    <div class="call-head">
      <div>
        <div class="call-title" id="call-room-title">Videollamada</div>
        <div class="call-timer" id="call-timer">00:00</div>
      </div>
      <div class="call-head-actions">
        <!-- Modo: grilla / enfocado -->
        <button class="cc" id="btn-layout" onclick="toggleLayout()" data-tip="Cambiar vista" style="width:36px;height:36px;font-size:14px;">⊞</button>
        <button class="icon-btn" onclick="copyInvite()" title="Invitar">🔗</button>
      </div>
    </div>
 
    <!-- Contenedor de video: cambia estructura según modo -->
    <div class="video-grid" id="video-grid"></div>
 
    <div class="call-ctrls">
      <button class="cc" id="btn-mic"    onclick="toggleMic()"    data-tip="Silenciar">🎤</button>
      <button class="cc" id="btn-cam"    onclick="toggleCam()"    data-tip="Cámara">📷</button>
      <button class="cc" id="btn-screen" onclick="toggleScreen()" data-tip="Compartir pantalla">🖥️</button>
      <button class="cc" id="btn-layout2" onclick="toggleLayout()" data-tip="Vista enfocada">⊞</button>
      <button class="cc danger"          onclick="endCall()"       data-tip="Colgar">📵</button>
    </div>
  </div>
</div>
 
<!-- Incoming call banner -->
<div class="call-banner" id="call-banner">
  <div>
    <div class="banner-text" id="banner-who">Videollamada entrante</div>
    <div class="banner-sub">VidRoom</div>
  </div>
  <div class="banner-btns">
    <button class="b-acc" onclick="acceptCall()" title="Aceptar">📹</button>
    <button class="b-dec" onclick="declineCall()" title="Rechazar">❌</button>
  </div>
</div>
 
<script src="/socket.io/socket.io.js"></script>
<script>
/* ═══════════════════════════════════════════════════
   ESTADO GLOBAL
═══════════════════════════════════════════════════ */
const socket = io();
let me = { name:'', socketId:'' };
let room = { inviteCode:'', name:'', users:[] };
let activeTab = 'create';
 
let iceServers = [
  { urls:'stun:stun.l.google.com:19302' },
  { urls:'stun:stun1.l.google.com:19302' }
];
 
let localStream  = null;
let screenStream = null;
let peerConns    = {};
let callActive   = false;
let callTimer    = null;
let callSeconds  = 0;
let micOn = true, camOn = true;
 
/* ── Estado de vista de video ─────────────────────── */
// 'grid'    → todos los tiles en cuadrícula igual
// 'focused' → 1 grande arriba + miniaturas abajo
let viewMode    = 'grid';
let pinnedId    = null;   // socketId del tile expandido en modo focused
let fullscreenId = null;  // socketId del tile en pantalla completa
 
/* ═══════════════════════════════════════════════════
   ICE SERVERS
═══════════════════════════════════════════════════ */
async function loadIceServers() {
  try {
    const res = await fetch(\`/api/ice-servers?socketId=\${socket.id}\`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    iceServers = await res.json();
    const hasTurn = iceServers.some(s => s.urls && String(s.urls).startsWith('turn'));
    const badge = document.getElementById('turn-badge');
    const label = document.getElementById('turn-label');
    if (hasTurn) { badge.classList.add('ready'); label.textContent = 'TURN activo'; }
    else { label.textContent = 'Solo STUN'; }
  } catch(e) {
    document.getElementById('turn-label').textContent = 'No disponible';
  }
}
 
/* ═══════════════════════════════════════════════════
   UI HELPERS
═══════════════════════════════════════════════════ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function toast(msg, ms=2800) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), ms);
}
function initials(n) { return n.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase()||'?'; }
function escHtml(t)  { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function autoResize(el) { el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,110)+'px'; }
function nowTime()   { return new Date().toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit'}); }
 
/* ═══════════════════════════════════════════════════
   LOGIN
═══════════════════════════════════════════════════ */
function setTab(tab) {
  activeTab = tab;
  document.getElementById('tab-create').classList.toggle('on', tab==='create');
  document.getElementById('tab-join').classList.toggle('on', tab==='join');
  document.getElementById('create-fields').style.display = tab==='create' ? 'block' : 'none';
  document.getElementById('join-fields').style.display   = tab==='join'   ? 'block' : 'none';
  document.getElementById('auth-btn').textContent = tab==='create' ? 'Crear sala →' : 'Unirse →';
  document.getElementById('login-err').textContent = '';
}
 
function doAuth() {
  const name = document.getElementById('inp-name').value.trim();
  if (!name) { document.getElementById('login-err').textContent='Escribe tu nombre'; return; }
  const btn = document.getElementById('auth-btn');
  btn.disabled = true; btn.textContent = 'Conectando…';
  if (activeTab === 'create') {
    const roomName = document.getElementById('inp-room').value.trim() || 'Mi sala';
    socket.emit('create-room', { userName:name, roomName }, res => {
      btn.disabled = false;
      if (res.error) { document.getElementById('login-err').textContent=res.error; btn.textContent='Crear sala →'; return; }
      enterApp(name, res);
    });
  } else {
    const code = document.getElementById('inp-code').value.trim().toUpperCase();
    if (code.length < 6) { document.getElementById('login-err').textContent='El código tiene 6 caracteres'; btn.disabled=false; btn.textContent='Unirse →'; return; }
    socket.emit('join-room', { userName:name, inviteCode:code }, res => {
      btn.disabled = false;
      if (res.error) { document.getElementById('login-err').textContent=res.error; btn.textContent='Unirse →'; return; }
      enterApp(name, res);
    });
  }
}
document.addEventListener('keydown', e => {
  if (e.key==='Enter' && document.getElementById('s-login').classList.contains('active')) doAuth();
  if (e.key==='Escape' && fullscreenId) exitFullscreen();
});
 
/* ═══════════════════════════════════════════════════
   ENTRAR A LA APP
═══════════════════════════════════════════════════ */
function enterApp(name, res) {
  me.name = name; me.socketId = socket.id;
  room.inviteCode = res.inviteCode; room.name = res.roomName; room.users = res.users;
  document.getElementById('my-av').childNodes[0].textContent = initials(name);
  document.getElementById('my-name-lbl').textContent = name;
  document.getElementById('invite-display').textContent = res.inviteCode;
  document.getElementById('room-name-lbl').textContent = res.roomName;
  document.getElementById('ch-room-name').textContent = res.roomName;
  document.getElementById('call-room-title').textContent = 'Videollamada — '+res.roomName;
  renderUserList(); updateStatus();
  addSysMsg('Entraste a la sala · '+nowTime());
  showScreen('s-app');
  loadIceServers();
  document.getElementById('msg-ta').focus();
}
 
/* ═══════════════════════════════════════════════════
   USUARIOS
═══════════════════════════════════════════════════ */
function renderUserList() {
  const el = document.getElementById('user-list');
  el.innerHTML = '';
  room.users.forEach(u => {
    const d = document.createElement('div');
    d.className = 'u-item'+(u.socketId===socket.id?' me':'');
    d.innerHTML = \`<div class="av" style="width:32px;height:32px;font-size:12px">\${initials(u.name)}<div class="dot"></div></div>
      <div><div class="uname">\${escHtml(u.name)}</div><div class="ustatus">En línea</div></div>\`;
    el.appendChild(d);
  });
}
function updateStatus() {
  document.getElementById('ch-status').textContent = \`● \${room.users.length} participante\${room.users.length!==1?'s':''}\`;
}
function leaveRoom() { if(callActive) endCall(); location.reload(); }
function copyInvite() {
  const link = \`\${location.origin}?code=\${room.inviteCode}\`;
  navigator.clipboard.writeText(link).then(()=>toast('🔗 Enlace copiado'));
}
 
/* ═══════════════════════════════════════════════════
   CHAT
═══════════════════════════════════════════════════ */
function sendChat() {
  const ta = document.getElementById('msg-ta');
  const text = ta.value.trim();
  if (!text) return;
  socket.emit('chat-message', { text });
  ta.value=''; ta.style.height='auto';
}
function addMsg(p, isMine) {
  const area = document.getElementById('msgs');
  const d = document.createElement('div');
  d.className='msg '+(isMine?'out':'in');
  d.innerHTML = isMine
    ? \`<div class="bubble">\${escHtml(p.text)}</div><div class="btime">\${p.time} ✓✓</div>\`
    : \`<div class="bname">\${escHtml(p.name)}</div><div class="bubble">\${escHtml(p.text)}</div><div class="btime">\${p.time}</div>\`;
  area.appendChild(d); area.scrollTop=area.scrollHeight;
}
function addSysMsg(txt) {
  const area = document.getElementById('msgs');
  const d = document.createElement('div');
  d.className='sys'; d.textContent=txt;
  area.appendChild(d); area.scrollTop=area.scrollHeight;
}
 
/* ═══════════════════════════════════════════════════
   WEBRTC
═══════════════════════════════════════════════════ */
async function getLocalStream() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
  } catch(e) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video:false, audio:true });
      toast('⚠️ Cámara no disponible, solo audio');
    } catch(e2) { toast('❌ Sin acceso a micrófono/cámara'); localStream=null; }
  }
  return localStream;
}
 
async function startCall() {
  if (callActive) return;
  const stream = await getLocalStream();
  if (!stream) return;
  callActive = true;
  openCallOverlay();
  addVideoTile(socket.id, me.name, stream, true);
  socket.emit('call-start');
  for (const u of room.users) {
    if (u.socketId === socket.id) continue;
    await createOffer(u.socketId);
  }
}
 
async function createOffer(targetId) {
  const pc = createPC(targetId);
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('webrtc-offer', { to:targetId, offer });
}
 
function createPC(peerId) {
  if (peerConns[peerId]) peerConns[peerId].close();
  const pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('webrtc-ice-candidate', { to:peerId, candidate:e.candidate });
  };
  pc.ontrack = e => {
    const user = room.users.find(u=>u.socketId===peerId);
    addVideoTile(peerId, user?.name||'Participante', e.streams[0], false);
  };
  pc.onconnectionstatechange = () => {
    if (['disconnected','failed','closed'].includes(pc.connectionState)) removeVideoTile(peerId);
  };
  peerConns[peerId] = pc;
  return pc;
}
 
function openCallOverlay() {
  document.getElementById('s-call').classList.add('active');
  callSeconds=0;
  if(callTimer) clearInterval(callTimer);
  callTimer = setInterval(()=>{
    callSeconds++;
    const m=String(Math.floor(callSeconds/60)).padStart(2,'0');
    const s=String(callSeconds%60).padStart(2,'0');
    document.getElementById('call-timer').textContent=m+':'+s;
  },1000);
}
 
function endCall() {
  Object.values(peerConns).forEach(pc=>pc.close()); peerConns={};
  if(localStream){localStream.getTracks().forEach(t=>t.stop()); localStream=null;}
  if(screenStream){screenStream.getTracks().forEach(t=>t.stop()); screenStream=null;}
  socket.emit('call-end');
  clearInterval(callTimer); callActive=false;
  document.getElementById('s-call').classList.remove('active');
  // Reset view state
  viewMode='grid'; pinnedId=null; fullscreenId=null;
  document.getElementById('video-grid').className='video-grid';
  document.getElementById('video-grid').innerHTML='';
  updateLayoutBtn();
  toast('📵 Llamada finalizada');
}
 
/* ═══════════════════════════════════════════════════
   GESTIÓN DE TILES DE VIDEO
═══════════════════════════════════════════════════ */
 
// Registro: socketId → { stream, name, isLocal }
const tileRegistry = {};
 
function addVideoTile(id, name, stream, isLocal) {
  tileRegistry[id] = { stream, name, isLocal };
  rebuildGrid();
}
 
function removeVideoTile(id) {
  delete tileRegistry[id];
  if (pinnedId === id) pinnedId = null;
  if (fullscreenId === id) exitFullscreen();
  rebuildGrid();
}
 
/* Construye el DOM del grid según viewMode y pinnedId */
function rebuildGrid() {
  if (fullscreenId) return; // No reconstruir mientras hay pantalla completa
  const grid = document.getElementById('video-grid');
  const ids = Object.keys(tileRegistry);
 
  if (viewMode === 'grid' || ids.length <= 1) {
    // ── MODO GRILLA ──────────────────────────────────
    grid.className = 'video-grid';
    grid.innerHTML = '';
    ids.forEach(id => {
      const { stream, name, isLocal } = tileRegistry[id];
      grid.appendChild(buildTile(id, name, stream, isLocal, 'grid'));
    });
  } else {
    // ── MODO ENFOCADO ────────────────────────────────
    grid.className = 'video-grid focused-mode';
    grid.innerHTML = '';
 
    // Determinamos cuál va grande (pinnedId o el primero remoto)
    const focusId = pinnedId || ids.find(id => !tileRegistry[id].isLocal) || ids[0];
 
    // Contenedor principal
    const main = document.createElement('div');
    main.className = 'focused-main';
    const { stream, name, isLocal } = tileRegistry[focusId];
    main.appendChild(buildTile(focusId, name, stream, isLocal, 'expanded'));
    grid.appendChild(main);
 
    // Miniaturas de los demás
    const strip = document.createElement('div');
    strip.className = 'thumb-strip';
    ids.forEach(id => {
      if (id === focusId) return;
      const t = tileRegistry[id];
      const thumb = buildTile(id, t.name, t.stream, t.isLocal, 'thumb');
      if (id === pinnedId) thumb.classList.add('active-thumb');
      strip.appendChild(thumb);
    });
    if (strip.children.length > 0) grid.appendChild(strip);
  }
}
 
/* Crea el elemento DOM de un tile */
function buildTile(id, name, stream, isLocal, mode) {
  const tile = document.createElement('div');
  tile.id = 'vt-'+id;
 
  if (mode === 'grid') {
    tile.className = 'vtile' + (isLocal ? ' local-tile' : '');
  } else if (mode === 'thumb') {
    tile.className = 'vtile thumb' + (isLocal ? ' local-tile' : '');
    // Clic en miniatura → enfocar ese tile
    tile.onclick = () => { pinnedId = id; rebuildGrid(); };
  } else {
    tile.className = 'vtile expanded' + (isLocal ? ' local-tile' : '');
  }
 
  // Botones flotantes de control del tile
  const actions = document.createElement('div');
  actions.className = 'tile-actions';
 
  if (mode !== 'thumb') {
    // Botón expandir/enfocar (solo en modo grid) o contraer (en expanded)
    if (mode === 'grid') {
      const btnFocus = document.createElement('button');
      btnFocus.className = 'tile-btn';
      btnFocus.textContent = '⛶ Enfocar';
      btnFocus.onclick = (e) => { e.stopPropagation(); pinnedId = id; viewMode = 'focused'; rebuildGrid(); updateLayoutBtn(); };
      actions.appendChild(btnFocus);
    } else if (mode === 'expanded') {
      const btnShrink = document.createElement('button');
      btnShrink.className = 'tile-btn';
      btnShrink.textContent = '⊞ Grilla';
      btnShrink.onclick = (e) => { e.stopPropagation(); viewMode = 'grid'; pinnedId = null; rebuildGrid(); updateLayoutBtn(); };
      actions.appendChild(btnShrink);
    }
 
    // Botón pantalla completa
    const btnFull = document.createElement('button');
    btnFull.className = 'tile-btn';
    btnFull.textContent = '⛶ Pantalla completa';
    btnFull.onclick = (e) => { e.stopPropagation(); enterFullscreen(id); };
    actions.appendChild(btnFull);
  }
 
  tile.appendChild(actions);
 
  // Video
  const vid = document.createElement('video');
  vid.id = 'vid-'+id;
  vid.autoplay = true;
  vid.playsInline = true;
  if (isLocal) vid.muted = true;
  vid.srcObject = stream;
  vid.className = 'active';
  tile.appendChild(vid);
 
  // Avatar fallback
  const avLg = document.createElement('div');
  avLg.className = 'av-lg';
  avLg.textContent = initials(name);
  tile.appendChild(avLg);
 
  vid.onloadedmetadata = () => { avLg.style.display = 'none'; };
  // Si el track ya tiene datos
  if (stream.getVideoTracks().length > 0) {
    const vt = stream.getVideoTracks()[0];
    if (vt.readyState === 'live' && vt.enabled) avLg.style.display = 'none';
  }
 
  // Nombre
  const tname = document.createElement('div');
  tname.className = 'tname';
  tname.textContent = name + (isLocal ? ' (tú)' : '');
  tile.appendChild(tname);
 
  // Ícono mute
  const mIcon = document.createElement('div');
  mIcon.className = 'muted-icon';
  mIcon.textContent = '🔇';
  tile.appendChild(mIcon);
 
  return tile;
}
 
/* ── PANTALLA COMPLETA ──────────────────────────── */
function enterFullscreen(id) {
  if (!tileRegistry[id]) return;
  fullscreenId = id;
 
  const { stream, name, isLocal } = tileRegistry[id];
  const tile = buildTile(id, name, stream, isLocal, 'expanded');
  tile.classList.add('fullscreen-tile');
 
  // Botón para salir
  const btnExit = document.createElement('button');
  btnExit.className = 'tile-btn';
  btnExit.textContent = '✕ Salir de pantalla completa';
  btnExit.style.cssText = 'position:absolute;top:14px;right:14px;font-size:13px;padding:6px 12px;z-index:10;';
  btnExit.onclick = exitFullscreen;
  tile.appendChild(btnExit);
 
  // Añadir hint ESC
  const hint = document.createElement('div');
  hint.style.cssText = 'position:absolute;bottom:14px;right:14px;font-size:11px;color:rgba(255,255,255,.5);pointer-events:none;';
  hint.textContent = 'ESC para salir';
  tile.appendChild(hint);
 
  tile.id = 'fullscreen-tile';
  document.body.appendChild(tile);
  toast('⛶ Pantalla completa — ESC para salir');
}
 
function exitFullscreen() {
  const el = document.getElementById('fullscreen-tile');
  if (el) el.remove();
  fullscreenId = null;
  rebuildGrid();
}
 
/* ── ALTERNAR VISTA GRID ↔ FOCUSED ─────────────── */
function toggleLayout() {
  const ids = Object.keys(tileRegistry);
  if (ids.length <= 1) { toast('Necesitas más participantes para cambiar la vista'); return; }
 
  if (viewMode === 'grid') {
    viewMode = 'focused';
    // Enfocar automáticamente el primer tile remoto
    pinnedId = ids.find(id => !tileRegistry[id].isLocal) || ids[0];
    toast('Vista enfocada — clic en miniatura para cambiar');
  } else {
    viewMode = 'grid';
    pinnedId = null;
    toast('Vista en cuadrícula');
  }
  rebuildGrid();
  updateLayoutBtn();
}
 
function updateLayoutBtn() {
  const icon = viewMode === 'focused' ? '⊟' : '⊞';
  const tip  = viewMode === 'focused' ? 'Vista grilla' : 'Vista enfocada';
  ['btn-layout','btn-layout2'].forEach(id => {
    const b = document.getElementById(id);
    if (b) { b.textContent = icon; b.setAttribute('data-tip', tip); }
  });
}
 
/* ── MIC / CAM / PANTALLA ──────────────────────── */
function toggleMic() {
  if(!localStream) return;
  micOn=!micOn;
  localStream.getAudioTracks().forEach(t=>t.enabled=micOn);
  const btn=document.getElementById('btn-mic');
  btn.textContent=micOn?'🎤':'🔇'; btn.classList.toggle('off',!micOn);
  document.getElementById('vt-'+socket.id)?.classList.toggle('muted',!micOn);
  if (document.getElementById('fullscreen-tile')?.id === 'vt-'+socket.id)
    document.getElementById('fullscreen-tile')?.classList.toggle('muted',!micOn);
}
 
function toggleCam() {
  if(!localStream) return;
  camOn=!camOn;
  localStream.getVideoTracks().forEach(t=>t.enabled=camOn);
  const btn=document.getElementById('btn-cam');
  btn.textContent=camOn?'📷':'🙈'; btn.classList.toggle('off',!camOn);
}
 
async function toggleScreen() {
  const btn = document.getElementById('btn-screen');
  if (screenStream) {
    screenStream.getTracks().forEach(t=>t.stop()); screenStream=null;
    if(localStream){
      const track=localStream.getVideoTracks()[0];
      if(track) Object.values(peerConns).forEach(pc=>{
        const s=pc.getSenders().find(s=>s.track?.kind==='video'); s?.replaceTrack(track);
      });
    }
    btn.classList.remove('active-ctrl');
    toast('📷 Cámara restaurada'); return;
  }
  try {
    screenStream=await navigator.mediaDevices.getDisplayMedia({video:true});
    const track=screenStream.getVideoTracks()[0];
    Object.values(peerConns).forEach(pc=>{
      const s=pc.getSenders().find(s=>s.track?.kind==='video'); s?.replaceTrack(track);
    });
    track.onended=()=>toggleScreen();
    btn.classList.add('active-ctrl');
    toast('🖥️ Compartiendo pantalla');
  } catch(e){ toast('❌ No se pudo compartir pantalla'); }
}
 
function acceptCall()  { document.getElementById('call-banner').classList.remove('show'); startCall(); }
function declineCall() { document.getElementById('call-banner').classList.remove('show'); toast('Llamada rechazada'); }
 
/* ═══════════════════════════════════════════════════
   SOCKET EVENTS
═══════════════════════════════════════════════════ */
socket.on('connect', () => { me.socketId=socket.id; });
 
socket.on('user-joined', d => {
  room.users=d.users; renderUserList(); updateStatus();
  addSysMsg(\`\${d.name} se unió · \${nowTime()}\`);
  toast(\`👋 \${d.name} se unió\`);
  if(callActive) createOffer(d.socketId);
});
 
socket.on('user-left', d => {
  room.users=d.users; renderUserList(); updateStatus();
  addSysMsg(\`\${d.name} salió · \${nowTime()}\`);
  removeVideoTile(d.socketId);
  if(peerConns[d.socketId]){peerConns[d.socketId].close(); delete peerConns[d.socketId];}
});
 
socket.on('chat-message', p => addMsg(p, p.socketId===socket.id));
 
socket.on('call-started', d => {
  if(callActive) return;
  document.getElementById('banner-who').textContent=\`\${d.by} inicia videollamada\`;
  document.getElementById('call-banner').classList.add('show');
  setTimeout(()=>document.getElementById('call-banner').classList.remove('show'),20000);
});
 
socket.on('call-ended', d => {
  removeVideoTile(d.socketId);
  if(peerConns[d.socketId]){peerConns[d.socketId].close(); delete peerConns[d.socketId];}
});
 
socket.on('webrtc-offer', async ({from,offer}) => {
  const stream=await getLocalStream();
  const pc=createPC(from);
  if(stream) stream.getTracks().forEach(t=>pc.addTrack(t,stream));
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer=await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('webrtc-answer',{to:from,answer});
  if(!callActive){ callActive=true; openCallOverlay(); if(stream) addVideoTile(socket.id,me.name,stream,true); }
});
 
socket.on('webrtc-answer', async ({from,answer}) => {
  const pc=peerConns[from]; if(pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
});
 
socket.on('webrtc-ice-candidate', async ({from,candidate}) => {
  const pc=peerConns[from];
  if(pc&&candidate) try{ await pc.addIceCandidate(new RTCIceCandidate(candidate)); }catch(e){}
});
 
socket.on('disconnect', ()=>toast('⚠️ Conexión perdida…'));
socket.on('reconnect',  ()=>{ toast('✅ Reconectado'); loadIceServers(); });
 
/* URL auto-fill */
const urlCode = new URLSearchParams(location.search).get('code');
if(urlCode && urlCode.length===6){
  setTab('join');
  document.getElementById('inp-code').value=urlCode.toUpperCase();
  document.getElementById('inp-name').focus();
}
</script>
</body>
</html>
`;
 
app.get('/', (req, res) => res.send(HTML));
app.get('*', (req, res) => res.status(404).send('Not found'));
 
// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 VidRoom corriendo en http://localhost:${PORT}`);
  console.log('   Abre esa URL en tu navegador\n');
});
 
