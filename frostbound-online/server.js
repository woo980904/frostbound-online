'use strict';
/* FROSTBOUND 실시간 멀티플레이 서버
   · 외부 패키지 없이 Node 내장 모듈(http, crypto)만으로 WebSocket(RFC 6455)을 처리한다 → 무료 호스팅에서 빌드가 단순하고 빠르다.
   · 같은 주소에서 게임 페이지(public/index.html)도 내준다 → 브라우저는 https://<서버>/ 로 게임을 열고 wss://<서버>/ws 로 붙는다.
   · 서버가 하는 일: 접속·해제, 세션 ID, 룸(= 게임 구역) 입장·이동, 룸 안 플레이어 목록, 위치·방향·동작 상태 중계, 채팅·감정 표현 중계,
     끊김 감지(핑/퐁), 재접속(재개 토큰으로 같은 ID 유지), 입력값 검증·크기 제한·속도 제한.
   · 전투·아이템·경험치·파티·거래는 아직 없다. 'act' 메시지는 not_implemented 로 거절한다(나중에 서버 권한 방식으로 이 자리에 붙인다).
   환경변수: PORT(기본 8787), ALLOWED_ORIGINS(쉼표로 구분, 비우면 모든 출처 허용), MAX_CONN(기본 300), ROOM_CAP(기본 60)            */
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 8787, MAX_CONN = +process.env.MAX_CONN || 300, ROOM_CAP = +process.env.ROOM_CAP || 60;
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const PUB = path.join(__dirname, 'public'), START = Date.now();
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ------------------------------ 게임 상태 ------------------------------ */
const sessions = new Map();   // id → session (연결이 끊겨도 RESUME_MS 동안 남는다)
const rooms = new Map();      // room → Set(session)
const RESUME_MS = 45000;
const LOOK_KEYS = ['build', 'skin', 'hair', 'hs', 'beard', 'outfit', 'c1', 'c2', 'acc', 'fem', 'weapon', 'wCol', 'wGlow', 'off', 'offCol', 'helm', 'helmCol', 'helm18', 'boots', 'trim', 'eye', 'faceT', 'eyeT', 'brow', 'mark', 'markC', 'tusk', 'earL', 'bHt', 'bW', 'bSh', 'bLeg', 'bHead', 'bMus', 'armSty', 'helmSty', 'wSty', 'aura', 'race14', 'sub14'];
const EMOTES = new Set(['wave', 'laugh', 'sad', 'angry', 'good', 'heart', 'dance', 'bow']);
const str = (v, n) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠-⁯]/g, '').trim().slice(0, n) : '';
const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v)) ? Math.max(lo, Math.min(hi, v)) : null;
function cleanLook(lk) { if (!lk || typeof lk !== 'object' || Array.isArray(lk)) return null; const o = {}; let n = 0;
  for (const k of LOOK_KEYS) { const v = lk[k]; if (v === undefined || v === null) continue; if (typeof v === 'number' && isFinite(v)) o[k] = Math.max(-100, Math.min(100, v)); else if (typeof v === 'boolean') o[k] = v; else if (typeof v === 'string') o[k] = str(v, 40); else continue; if (++n > 48) break }
  return o }
function pub(s) { return { id: s.id, nm: s.nm, lv: s.lv, race: s.race, cls: s.cls, z: s.room, x: s.x, y: s.y, f: s.f, mv: s.mv, ps: s.ps, lk: s.lk, on: !!s.ws } }
function roomOf(name) { let r = rooms.get(name); if (!r) { r = new Set(); rooms.set(name, r) } return r }
function bcast(room, msg, except) { const r = rooms.get(room); if (!r) return; const data = JSON.stringify(msg); for (const s of r) if (s !== except && s.ws) s.ws.sendText(data) }
function leaveRoom(s, why) { if (!s.room) return; const r = rooms.get(s.room); if (r) { r.delete(s); bcast(s.room, { t: 'pleave', id: s.id, why }); if (!r.size) rooms.delete(s.room) } s.room = null }
function joinRoom(s, room) { if (s.room === room) return true; const r = roomOf(room); if (r.size >= ROOM_CAP) { if (!r.size) rooms.delete(room); return false } leaveRoom(s, 'move'); s.room = room; r.add(s);
  s.ws && s.ws.sendText(JSON.stringify({ t: 'room', room, players: [...r].filter(o => o !== s).map(pub) })); bcast(room, { t: 'pjoin', p: pub(s) }, s); return true }
function counts() { let online = 0; for (const s of sessions.values()) if (s.ws) online++; return online }

/* ------------------------------ 메시지 처리 ------------------------------ */
const LIMITS = { st: [20, 1000], chat: [5, 6000], emote: [3, 3000], join: [6, 3000], hello: [3, 5000], ping: [10, 1000] };
function rate(s, t) { const L = LIMITS[t] || [10, 1000], now = Date.now(), b = s.rl[t] || (s.rl[t] = { n: 0, t0: now }); if (now - b.t0 > L[1]) { b.n = 0; b.t0 = now } return ++b.n <= L[0] }
function err(ws, code, msg) { ws.sendText(JSON.stringify({ t: 'err', code, msg })) }
function onMessage(ws, raw) { let m; try { m = JSON.parse(raw) } catch (e) { return err(ws, 'bad_json', '형식이 잘못된 메시지') } if (!m || typeof m.t !== 'string') return err(ws, 'bad_msg', '종류가 없는 메시지');
  const s = ws.sess;
  if (m.t === 'hello') { // 처음 인사 또는 재접속
    if (s) return err(ws, 'dup_hello', '이미 인사함');
    let ss = null; const tok = str(m.resume, 64); if (tok) for (const o of sessions.values()) if (o.token === tok && !o.ws) { ss = o; break }
    if (!ss) { ss = { id: crypto.randomBytes(6).toString('hex'), token: crypto.randomBytes(16).toString('hex'), room: null, x: 0, y: 0, f: 1, mv: false, ps: null, lk: null, rl: {} }; sessions.set(ss.id, ss) }
    clearTimeout(ss.gone); ss.ws = ws; ws.sess = ss; ss.rl = {};
    ss.nm = str(m.nm, 16) || '모험가'; ss.lv = num(m.lv, 1, 99) || 1; ss.race = str(m.race, 16) || 'human'; ss.cls = str(m.cls, 20); const lk = cleanLook(m.lk); if (lk) ss.lk = lk;
    ss.room = null; ss.moved = false;
    ws.sendText(JSON.stringify({ t: 'welcome', id: ss.id, resume: ss.token, online: counts(), serverTime: Date.now(), resumed: !!tok && ss.token === tok }));
    log('hello', ss.id, ss.nm, tok ? '(resume)' : ''); return }
  if (!s) return err(ws, 'no_hello', '먼저 hello 를 보내야 한다');
  if (!rate(s, m.t)) return err(ws, 'rate', '너무 빠르다: ' + m.t);
  switch (m.t) {
    case 'join': { const room = str(m.room, 40); if (!/^[a-z0-9_]{1,40}$/.test(room)) return err(ws, 'bad_room', '룸 이름이 잘못됨'); const x = num(m.x, 0, 400), y = num(m.y, 0, 400); if (x !== null) s.x = x; if (y !== null) s.y = y; if (!joinRoom(s, room)) err(ws, 'room_full', '룸이 가득 찼다'); return }
    case 'st': { if (!s.room) return; const x = num(m.x, 0, 400), y = num(m.y, 0, 400); if (x === null || y === null) return err(ws, 'bad_st', '좌표가 잘못됨');
      // 순간이동 막기: 한 번에 6칸 넘게 움직이면(구역 안 이동 기준) 받아들이지 않고 서버 위치를 돌려준다
      if (Math.hypot(x - s.x, y - s.y) > 6 && s.moved) { ws.sendText(JSON.stringify({ t: 'fix', x: s.x, y: s.y })); return }
      s.x = x; s.y = y; s.moved = true; s.f = m.f === -1 ? -1 : 1; s.mv = !!m.mv;
      s.ps = Array.isArray(m.ps) && typeof m.ps[0] === 'string' ? [str(m.ps[0], 20), num(m.ps[1], 0, 600000) || 0, num(m.ps[2], 1, 9999000) || 1] : null;
      const lk = m.lk ? cleanLook(m.lk) : null; if (lk) s.lk = lk; const lv = num(m.lv, 1, 99); if (lv) s.lv = lv;
      bcast(s.room, { t: 'pst', id: s.id, x: s.x, y: s.y, f: s.f, mv: s.mv, ps: s.ps, lv: s.lv, lk: lk || undefined }, s); return }
    case 'chat': { const text = str(m.m, 120); if (!text || !s.room) return; const msg = { t: 'chat', id: s.id, nm: s.nm, m: text, z: s.room, ts: Date.now() };
      // 모든 룸의 접속자에게(지역 표시와 함께) — 보낸 사람도 서버에서 돌아온 것으로 화면에 띄운다
      const data = JSON.stringify(msg); for (const o of sessions.values()) if (o.ws) o.ws.sendText(data); return }
    case 'emote': { const k = str(m.k, 12); if (!EMOTES.has(k) || !s.room) return err(ws, 'bad_emote', '없는 감정 표현'); bcast(s.room, { t: 'emote', id: s.id, k, ts: Date.now() }); return }
    case 'ping': ws.sendText(JSON.stringify({ t: 'pong', ts: m.ts, online: counts() })); return;
    case 'act': return err(ws, 'not_implemented', '전투·아이템은 아직 서버에서 처리하지 않는다');
    default: return err(ws, 'unknown', '모르는 메시지: ' + str(m.t, 16)) } }
function onClose(ws) { const s = ws.sess; if (!s || s.ws !== ws) return; s.ws = null; leaveRoom(s, 'disconnect');
  // 재접속 대기: 같은 토큰으로 돌아오면 같은 ID 를 쓴다
  s.gone = setTimeout(() => { sessions.delete(s.id) }, RESUME_MS); log('close', s.id, s.nm) }

/* ------------------------------ WebSocket (RFC 6455) ------------------------------ */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', MAX_FRAME = 8192;
function wrap(sock) { const ws = { sock, buf: Buffer.alloc(0), alive: true, closed: false, sess: null, frags: [] };
  ws.send = (op, payload) => { if (ws.closed) return; const len = payload.length; let head; if (len < 126) { head = Buffer.alloc(2); head[1] = len } else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2) } else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2) } head[0] = 0x80 | op; try { sock.write(Buffer.concat([head, payload])) } catch (e) { } };
  ws.sendText = t => ws.send(1, Buffer.from(t));
  ws.close = (code = 1000, why = '') => { if (ws.closed) return; const b = Buffer.alloc(2 + Buffer.byteLength(why)); b.writeUInt16BE(code, 0); b.write(why, 2); ws.send(8, b); ws.closed = true; try { sock.end() } catch (e) { } setTimeout(() => sock.destroy(), 1000) };
  sock.on('data', d => { ws.buf = Buffer.concat([ws.buf, d]); if (ws.buf.length > MAX_FRAME * 4) return ws.close(1009, 'too big');
    for (;;) { const b = ws.buf; if (b.length < 2) break; const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80; let len = b[1] & 0x7f, off = 2;
      if (!masked) return ws.close(1002, 'mask required');
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4 } else if (len === 127) { if (b.length < 10) break; const L = b.readBigUInt64BE(2); if (L > BigInt(MAX_FRAME)) return ws.close(1009, 'too big'); len = Number(L); off = 10 }
      if (len > MAX_FRAME) return ws.close(1009, 'too big'); if (b.length < off + 4 + len) break;
      const mask = b.slice(off, off + 4), data = Buffer.alloc(len); for (let i = 0; i < len; i++) data[i] = b[off + 4 + i] ^ mask[i & 3]; ws.buf = b.slice(off + 4 + len);
      if (op === 8) { ws.close(1000); continue } if (op === 9) { ws.send(10, data); continue } if (op === 10) { ws.alive = true; continue }
      if (op === 1 || op === 0) { ws.frags.push(data); if (!fin) { if (ws.frags.reduce((a, x) => a + x.length, 0) > MAX_FRAME) return ws.close(1009, 'too big'); continue } const text = Buffer.concat(ws.frags).toString('utf8'); ws.frags = []; ws.alive = true; try { onMessage(ws, text) } catch (e) { log('handler error', e) } continue }
      if (op === 2) { ws.close(1003, 'text only'); return } } });
  sock.on('close', () => { ws.closed = true; onClose(ws) }); sock.on('error', () => { ws.closed = true; onClose(ws) });
  return ws }
const conns = new Set();

/* ------------------------------ HTTP ------------------------------ */
function originOk(o) { if (!ALLOWED.length) return true; return !!o && ALLOWED.includes(o) }
const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x');
  const sec = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (u.pathname === '/health' || u.pathname === '/healthz') { const body = JSON.stringify({ ok: true, service: 'frostbound', online: counts(), sessions: sessions.size, rooms: rooms.size, uptimeSec: Math.round((Date.now() - START) / 1000) });
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }, sec)); return res.end(body) }
  if (u.pathname === '/' || u.pathname === '/index.html') { const f = path.join(PUB, 'index.html'); fs.readFile(f, (e, d) => { if (e) { res.writeHead(404, sec); return res.end('index.html 없음 — npm run build 로 게임 페이지를 넣어 주세요') } res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, sec)); res.end(d) }); return }
  res.writeHead(404, sec); res.end('not found') });
server.on('upgrade', (req, sock) => { const u = new URL(req.url, 'http://x'), key = req.headers['sec-websocket-key'];
  if (u.pathname !== '/ws' || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return }
  if (!originOk(req.headers.origin)) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); log('origin denied', req.headers.origin); return }
  if (conns.size >= MAX_CONN) { sock.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return }
  const acc = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`); sock.setNoDelay(true);
  const ws = wrap(sock); conns.add(ws); sock.on('close', () => conns.delete(ws)) });
/* 끊김 감지: 15초마다 ping, 응답(또는 아무 메시지)이 없으면 연결을 끊는다 */
setInterval(() => { for (const ws of conns) { if (!ws.alive) { try { ws.sock.destroy() } catch (e) { } continue } ws.alive = false; ws.send(9, Buffer.alloc(0)) } }, 15000);
server.listen(PORT, () => log(`FROSTBOUND server on :${PORT}  (origins: ${ALLOWED.length ? ALLOWED.join(',') : 'any'})`));
process.on('SIGTERM', () => { for (const ws of conns) ws.close(1012, 'restart'); server.close(); setTimeout(() => process.exit(0), 500) });
