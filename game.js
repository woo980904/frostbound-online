'use strict';
/* FROSTBOUND 서버 — 멀티플레이 2차: 장비 외형 · 파티 · 몬스터 HP 공유 · 파티 경험치 · 개인 전리품 · 퀘스트 공유 · 거래
   server.js 가 hello/join/st/chat/emote 를 처리하고, 나머지 메시지는 여기로 넘긴다(handle). 상태는 모두 메모리에 있다.
   서버 권한으로 처리하는 것: 장비 외형 검증·보관, 파티 구성, 몬스터 HP·사망 확정(처치 ID 1회), 경험치·골드 계산, 개인 전리품 생성·획득(드롭 ID 1회),
   퀘스트 공유 대상 검증, 거래 내용·준비 상태·확정·완료(거래 ID 1회)와 기록.
   인벤토리·퀘스트 진행 자체는 아직 각 플레이어의 브라우저 저장소에 있다(서버 DB 없음) — 거래·획득은 서버가 확정한 결과만 클라이언트가 반영한다. */
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));
const CFG = {
  PARTY_MAX: 6, INVITE_MS: 30000,
  PARTY_XP: Object.assign({ 1: 1, 2: .7, 3: .6, 4: .5, 5: .45, 6: .4 }, safeJson(process.env.PARTY_XP)),   // 처치에 참여한(자격 있는) 파티 인원수 → 각자 받는 기본 경험치 비율
  SHARE_DIST: 25,                 // 파티원이 보상 받을 수 있는 거리(칸)
  HIT_DIST: 18, HIT_MAX: 60000,   // 공격 판정 거리, 한 번 피해 상한
  ROOM_MONS: 220, LOOT_MS: 10 * 60 * 1000, TRADE_SLOTS: 9, TRADE_MS: 5 * 60 * 1000, GOLD_MAX: 1e9 };
const FORCE_DROP = process.env.FORCE_DROP === '1';   // 시험용: 모든 드롭 100%
function safeJson(s) { try { return s ? JSON.parse(s) : {} } catch (e) { return {} } }
const PERSIST = path.join(__dirname, 'data'); try { fs.mkdirSync(PERSIST, { recursive: true }) } catch (e) { }
function record(file, obj) { try { fs.appendFileSync(path.join(PERSIST, file), JSON.stringify(obj) + '\n') } catch (e) { } }
let X; // server.js 도구 (send, bcast, sessions, rooms, str, num, log)
const id6 = () => crypto.randomBytes(5).toString('hex');
const send = (s, o) => { if (s && s.ws) s.ws.sendText(JSON.stringify(o)) };
const err = (s, code, msg) => send(s, { t: 'err', code, msg });
const clampInt = (v, lo, hi) => (typeof v === 'number' && isFinite(v)) ? Math.max(lo, Math.min(hi, Math.round(v))) : null;
const HEX = /^#[0-9a-fA-F]{6}$/;

/* ================================ 1. 장비 외형 ================================ */
const EQ_SLOTS = ['weapon', 'offhand', 'head', 'body', 'boots', 'ring', 'amulet'];
function cleanFlat(o, maxKeys, depth) { const out = {}; let n = 0; if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  for (const [k, v] of Object.entries(o)) { if (n >= maxKeys) break; if (!/^[A-Za-z0-9_]{1,14}$/.test(k)) continue;
    if (typeof v === 'number' && isFinite(v)) out[k] = Math.max(-1e6, Math.min(1e6, v)); else if (typeof v === 'boolean') out[k] = v; else if (typeof v === 'string') out[k] = X.str(v, 24); else if (v && typeof v === 'object' && !Array.isArray(v) && depth > 0) out[k] = cleanFlat(v, 16, depth - 1); else continue; n++ }
  return out }
function cleanEq(m) { const out = { slots: {}, look: {}, race: X.str(m.race, 16) || 'human', sh: !!m.sh, bag: null, bad: [] };
  const sl = m.slots && typeof m.slots === 'object' ? m.slots : {};
  for (const k of EQ_SLOTS) { const it = sl[k]; if (!it) continue; const B = CAT.bases[it.b];
    if (!B || B.slot !== k) { out.bad.push(k + ':' + X.str(String(it.b || ''), 20)); continue }   // 모르는 장비 ID → 그 칸은 비워 보낸다(받는 쪽은 기본 외형)
    const o = { b: it.b, t: clampInt(it.t, 0, CAT.tiers) ?? 1, r: clampInt(it.r, 0, CAT.rarity - 1) || 0 };
    if (typeof it.dye === 'string' && HEX.test(it.dye)) o.dye = it.dye; const cs = clampInt(it.cs18, 0, 1e9); if (cs !== null) o.cs18 = cs; const sty = clampInt(it.sty, 0, 20); if (sty) o.sty = sty;
    if (k === 'head' && CAT.hs18.includes(it.hs18)) o.hs18 = it.hs18; const uid = clampInt(it.uid, 0, 1e9); if (uid !== null) o.uid = uid;
    for (const f of ['starter', 'starterW', 'rune', 'broken']) if (it[f]) o[f] = true; for (const f of ['dur', 'maxDur']) { const v = clampInt(it[f], 0, 100000); if (v !== null) o[f] = v } if (it.wp) o.wp = cleanFlat(it.wp, 8, 0);
    out.slots[k] = o }
  out.look = cleanFlat(m.look, 70, 1);
  if (typeof m.bag === 'string' && CAT.items[m.bag] && CAT.items[m.bag].bag) out.bag = m.bag;
  return out }
function onEq(s, m) { const e = cleanEq(m); if (e.bad.length) X.log('eq: 알 수 없는 장비 무시', s.id, e.bad.join(',')); delete e.bad; s.eq = e; if (s.room) X.bcast(s.room, { t: 'peq', id: s.id, eq: e }, s); const P = partyOf(s); if (P) partyPush(P) }

/* ================================ 2. 파티 ================================ */
const parties = new Map(); // id → { id, leader, members: [sid], invites: Map(sid → expire) }
function pMember(sid) { const o = X.sessions.get(sid); return o ? { id: o.id, nm: o.nm, lv: o.lv, race: o.race, cls: o.cls, hp: o.hp ?? null, mhp: o.mhp ?? null, alive: o.alive !== false, on: !!o.ws, z: o.room, eq: o.eq || null } : { id: sid, nm: '?', on: false } }
function partyView(P) { return { id: P.id, leader: P.leader, members: P.members.map(pMember) } }
function partyPush(P) { const v = partyView(P); for (const sid of P.members) send(X.sessions.get(sid), { t: 'party', party: v }) }
function partyOf(s) { return s.party ? parties.get(s.party) : null }
function partyRemove(s, why) { const P = partyOf(s); if (!P) return; P.members = P.members.filter(x => x !== s.id); s.party = null; send(s, { t: 'party', party: null, why });
  if (P.members.length < 2) { for (const sid of P.members) { const o = X.sessions.get(sid); if (o) { o.party = null; send(o, { t: 'party', party: null, why: 'disband' }) } } parties.delete(P.id); return }
  if (P.leader === s.id) P.leader = P.members.find(sid => { const o = X.sessions.get(sid); return o && o.ws }) || P.members[0];
  partyPush(P) }
function onParty(s, m) { const P = partyOf(s);
  switch (m.a) {
    case 'create': if (P) return err(s, 'party', '이미 파티에 속해 있다'); { const N = { id: id6(), leader: s.id, members: [s.id], invites: new Map() }; parties.set(N.id, N); s.party = N.id; partyPush(N) } return;
    case 'invite': { const to = X.sessions.get(X.str(m.to, 20)); if (!to || !to.ws) return err(s, 'party', '그 플레이어는 접속해 있지 않다'); if (to === s) return;
      let Q = P; if (!Q) { Q = { id: id6(), leader: s.id, members: [s.id], invites: new Map() }; parties.set(Q.id, Q); s.party = Q.id }
      if (Q.leader !== s.id) return err(s, 'party', '파티장만 초대할 수 있다'); if (to.party) return err(s, 'party', `${to.nm} 님은 이미 다른 파티에 있다`); if (Q.members.length >= CFG.PARTY_MAX) return err(s, 'party', '파티가 가득 찼다');
      const exp = Date.now() + CFG.INVITE_MS; Q.invites.set(to.id, exp); send(to, { t: 'pinv', pid: Q.id, from: s.id, nm: s.nm, lv: s.lv, exp }); partyPush(Q); send(s, { t: 'info', msg: `${to.nm} 님에게 파티 초대를 보냈다 (30초)` }); return }
    case 'accept': case 'decline': { const Q = parties.get(X.str(m.pid, 20)); if (!Q) return err(s, 'party', '초대가 사라졌다 (파티 해산)'); const exp = Q.invites.get(s.id); if (!exp) return err(s, 'party', '받은 초대가 없다'); Q.invites.delete(s.id);
      const L = X.sessions.get(Q.leader); if (Date.now() > exp) { send(s, { t: 'info', msg: '초대가 만료되었다' }); return }
      if (m.a === 'decline') { send(L, { t: 'info', msg: `${s.nm} 님이 파티 초대를 거절했다` }); return }
      if (s.party) return err(s, 'party', '이미 파티에 속해 있다'); if (Q.members.length >= CFG.PARTY_MAX) return err(s, 'party', '파티가 가득 찼다');
      Q.members.push(s.id); s.party = Q.id; partyPush(Q); return }
    case 'leave': if (!P) return; partyRemove(s, 'leave'); return;
    case 'kick': { if (!P || P.leader !== s.id) return err(s, 'party', '파티장만 추방할 수 있다'); const o = X.sessions.get(X.str(m.id, 20)); if (!o || o.party !== P.id || o === s) return; partyRemove(o, 'kick'); send(o, { t: 'info', msg: '파티에서 추방되었다' }); return }
    case 'disband': { if (!P || P.leader !== s.id) return err(s, 'party', '파티장만 해산할 수 있다'); for (const sid of P.members) { const o = X.sessions.get(sid); if (o) { o.party = null; send(o, { t: 'party', party: null, why: 'disband' }) } } parties.delete(P.id); return }
    case 'leader': { if (!P || P.leader !== s.id) return; const o = X.sessions.get(X.str(m.id, 20)); if (!o || o.party !== P.id) return; P.leader = o.id; partyPush(P); return }
    default: return err(s, 'party', '모르는 파티 명령') } }
function onHp(s, m) { const hp = clampInt(m.hp, 0, 1e7), mhp = clampInt(m.mhp, 1, 1e7); if (hp === null || mhp === null) return; s.hp = Math.min(hp, mhp); s.mhp = mhp; s.alive = s.hp > 0; const P = partyOf(s); if (!P) return;
  for (const sid of P.members) if (sid !== s.id) send(X.sessions.get(sid), { t: 'php', id: s.id, hp: s.hp, mhp, alive: s.alive }) }
setInterval(() => { const now = Date.now(); for (const P of parties.values()) for (const [sid, exp] of P.invites) if (now > exp) { P.invites.delete(sid); send(X.sessions.get(sid), { t: 'pinv_x', pid: P.id }); send(X.sessions.get(P.leader), { t: 'info', msg: '파티 초대가 만료되었다' }) } }, 2000);

/* ================================ 3. 몬스터 HP 공유 (같은 들판 룸) ================================
   룸의 '주인(host)' = 가장 먼저 들어온 접속자. 주인만 들판 생성기로 몬스터를 만들고 등록(madd)한다. 몬스터마다 '조종자(ctl)'가 AI·이동을 계산해 위치를 보낸다.
   HP 는 서버가 가진다: 누구든 피해를 보내면(mhit) 서버가 검증해 깎고, 0 이 되면 처치를 한 번만 확정한다(처치 ID). */
const R = new Map(); // room → { host, mons: Map, nextId }
const shared = room => /_(field|f[nesw])$/.test(room || '');
function RS(room) { let r = R.get(room); if (!r) { r = { host: null, mons: new Map(), nextId: 1, kills: 0 }; R.set(room, r) } return r }
function monHpBound(kind, lv) { const M = CAT.mons[kind]; if (!M) return 0; return Math.round((CAT.MBAL.hp0 + lv * CAT.MBAL.hpL) * M.hpM * 10) + 500 }
function monPub(mn) { return { id: mn.id, kind: mn.kind, lv: mn.lv, x: mn.x, y: mn.y, f: mn.f, st: mn.st, hp: mn.hp, mhp: mn.mhp, ctl: mn.ctl, spi: mn.spi, by: mn.by } }
function pickHost(room) { const r = R.get(room), set = X.rooms.get(room); if (!r) return; const cand = set ? [...set].filter(o => o.ws).sort((a, b) => (a.joinT || 0) - (b.joinT || 0)) : []; const h = cand[0] ? cand[0].id : null;
  if (h !== r.host) { r.host = h; X.bcast(room, { t: 'host', id: h }); for (const mn of r.mons.values()) if (!set || ![...set].some(o => o.id === mn.ctl && o.ws)) { mn.ctl = h; X.bcast(room, { t: 'mctl', id: mn.id, ctl: h }) } } }
function onJoinRoom(s, room) { s.joinT = Date.now(); if (!shared(room)) return; const r = RS(room); if (!r.host || !X.sessions.get(r.host) || !X.sessions.get(r.host).ws) r.host = null; if (!r.host) r.host = s.id;
  send(s, { t: 'mlist', room, host: r.host, mons: [...r.mons.values()].filter(x => x.alive).map(monPub) }) }
function onLeaveRoom(s, room) { if (!shared(room)) return; const r = R.get(room); if (!r) return; const set = X.rooms.get(room); if (!set || ![...set].some(o => o.ws)) { R.delete(room); return }
  for (const mn of r.mons.values()) if (mn.ctl === s.id) mn.ctl = null; pickHost(room); const h = R.get(room) && R.get(room).host; for (const mn of r.mons.values()) if (!mn.ctl) { mn.ctl = h; X.bcast(room, { t: 'mctl', id: mn.id, ctl: h }) } }
function onMadd(s, m) { if (!shared(s.room)) return; const r = RS(s.room); const list = Array.isArray(m.list) ? m.list.slice(0, 40) : []; const ok = [];
  for (const a of list) { if (r.mons.size >= CFG.ROOM_MONS) break; const kind = X.str(a.kind, 30), M = CAT.mons[kind]; if (!M) continue; const lv = clampInt(a.lv, 1, 80) || M.lv; const mhp = clampInt(a.mhp, 1, 1e7);
    // 생성 권한: 들판 생성기 몬스터는 주인만, 소환물은 소환한 몬스터의 조종자만
    const by = a.by ? r.mons.get(X.str(a.by, 12)) : null; if (by ? by.ctl !== s.id : r.host !== s.id) continue;
    if (!mhp || mhp > monHpBound(kind, lv)) continue; const x = X.num(a.x, 0, 400), y = X.num(a.y, 0, 400); if (x === null || y === null) continue;
    const mn = { id: 'm' + (r.nextId++), kind, lv, mhp, hp: mhp, x, y, f: 0, st: 'idle', ctl: s.id, alive: true, dmg: new Map(), spi: clampInt(a.spi, -1, 9999) ?? -1, by: by ? by.id : null, lid: X.str(String(a.lid || ''), 12) };
    r.mons.set(mn.id, mn); ok.push(mn) }
  if (!ok.length) return; send(s, { t: 'madded', list: ok.map(mn => ({ lid: mn.lid, id: mn.id })) }); X.bcast(s.room, { t: 'madd', list: ok.map(monPub) }, s) }
function onMpos(s, m) { const r = R.get(s.room); if (!r) return; const out = []; for (const a of (Array.isArray(m.l) ? m.l.slice(0, 120) : [])) { if (!Array.isArray(a)) continue; const mn = r.mons.get(X.str(String(a[0]), 12)); if (!mn || !mn.alive || mn.ctl !== s.id) continue;
    const x = X.num(a[1], 0, 400), y = X.num(a[2], 0, 400); if (x === null || y === null) continue; mn.x = x; mn.y = y; mn.f = X.num(a[3], -10, 10) || 0; mn.st = X.str(String(a[4] || ''), 12); out.push([mn.id, x, y, mn.f, mn.st, a[5] ? 1 : 0]) }
  if (out.length) X.bcast(s.room, { t: 'mpos', l: out }, s) }
function onMhit(s, m) { if (Array.isArray(m.l)) { for (const a of m.l.slice(0, 60)) if (Array.isArray(a)) hitOne(s, a[0], a[1]); return } hitOne(s, m.id, m.d) }   // 여러 몬스터 피해를 0.1초마다 한 번에
function hitOne(s, id, dd) { const r = R.get(s.room); if (!r) return; const mn = r.mons.get(X.str(String(id), 12)); if (!mn || !mn.alive) return;
  const d = clampInt(dd, 1, CFG.HIT_MAX); if (!d) return; if (Math.hypot(mn.x - s.x, mn.y - s.y) > CFG.HIT_DIST) return err(s, 'far', '너무 멀다');
  mn.hp = Math.max(0, mn.hp - d); mn.dmg.set(s.id, (mn.dmg.get(s.id) || 0) + d); mn.lastHit = Date.now();
  // 조종 넘기기: 지금 조종자가 멀리 있거나 6초 넘게 안 때렸으면 때린 사람에게
  const C = X.sessions.get(mn.ctl); if (mn.ctl !== s.id && (!C || !C.ws || C.room !== s.room || Math.hypot(mn.x - C.x, mn.y - C.y) > 9 || Date.now() - (mn.ctlHit || 0) > 6000)) { mn.ctl = s.id; X.bcast(s.room, { t: 'mctl', id: mn.id, ctl: s.id }) } if (mn.ctl === s.id) mn.ctlHit = Date.now();
  if (mn.hp <= 0) return monDie(s.room, r, mn);
  const now = Date.now(); if (now - (mn.hpT || 0) > 90 || mn.hp < mn.mhp * .1) { mn.hpT = now; X.bcast(s.room, { t: 'mhp', id: mn.id, hp: mn.hp }) } else if (!mn.hpPend) { mn.hpPend = setTimeout(() => { mn.hpPend = null; if (mn.alive) X.bcast(s.room, { t: 'mhp', id: mn.id, hp: mn.hp }) }, 100) } }
function onMgone(s, m) { const r = R.get(s.room); if (!r) return; const mn = r.mons.get(X.str(String(m.id), 12)); if (!mn || (mn.ctl !== s.id && r.host !== s.id)) return; r.mons.delete(mn.id); X.bcast(s.room, { t: 'mgone', id: mn.id }, s) }
// 조종 요청: 가만히 있는(idle) 몬스터 가까이 간 사람이 지금 조종자보다 가까우면 넘겨준다 → 몬스터가 가까운 사람을 노린다
function onMtake(s, m) { const r = R.get(s.room); if (!r) return; const mn = r.mons.get(X.str(String(m.id), 12)); if (!mn || !mn.alive || mn.ctl === s.id) return; const C = X.sessions.get(mn.ctl);
  const dMe = Math.hypot(mn.x - s.x, mn.y - s.y); if (dMe > 9) return; const ok = !C || !C.ws || C.room !== s.room || (mn.st === 'idle' || mn.st === 'return') && Math.hypot(mn.x - C.x, mn.y - C.y) > dMe + 1;
  if (!ok) return; mn.ctl = s.id; X.bcast(s.room, { t: 'mctl', id: mn.id, ctl: s.id }) }
const pendLoot = new Map(); // dropId → { owner(sid), item, exp, kill }
function genGear(lv, role) { const t = Math.max(1, Math.min(7, Math.floor((lv + 4) / 5))), keys = Object.keys(CAT.bases), b = keys[Math.floor(Math.random() * keys.length)];
  const W8 = role === 'boss' ? [0, 10, 50, 30, 10] : role === 'rare' ? [20, 45, 25, 8, 2] : [70, 22, 6, 1.6, .4]; let x = Math.random() * W8.reduce((a, c) => a + c, 0), r = 0; for (; r < 4; r++) { x -= W8[r]; if (x < 0) break } return { b, t, r } }
function monDie(room, r, mn) { mn.alive = false; mn.hp = 0; clearTimeout(mn.hpPend); const kid = 'k' + Date.now().toString(36) + (++r.kills); const M = CAT.mons[mn.kind];
  X.bcast(room, { t: 'mdie', id: mn.id, kid });
  // 보상 자격: 피해를 준 사람(같은 룸·접속 중·살아 있음) + 그 사람의 파티원 중 같은 룸·거리 안·살아 있음·접속 중
  const set = X.rooms.get(room) || new Set(), here = s => s && s.ws && set.has(s) && s.alive !== false;
  const elig = new Map(); // sid → { s, contrib }
  for (const [sid, d] of mn.dmg) { const o = X.sessions.get(sid); if (here(o) && d > 0) elig.set(sid, { s: o, contrib: true }) }
  for (const { s: o } of [...elig.values()]) { const P = partyOf(o); if (!P) continue; for (const sid of P.members) { if (elig.has(sid)) continue; const q = X.sessions.get(sid); if (here(q) && Math.hypot(q.x - mn.x, q.y - mn.y) <= CFG.SHARE_DIST) elig.set(sid, { s: q, contrib: false }) } }
  // 파티별 인원 → 배율
  const groups = new Map(); for (const [sid, e] of elig) { const k = e.s.party || ('solo:' + sid); groups.set(k, (groups.get(k) || 0) + 1) }
  const base = Math.round((8 + mn.lv * 5) * (M ? M.xpM : 1)), rec = { t: Date.now(), room, kid, kind: mn.kind, lv: mn.lv, rewards: [] };
  for (const [sid, e] of elig) { const n = groups.get(e.s.party || ('solo:' + sid)), mult = CFG.PARTY_XP[Math.min(n, 6)] ?? .4, xp = Math.max(1, Math.round(base * mult));
    const gold = Math.round(mn.lv * (1.5 + Math.random() * 1.5) * (M && M.boss ? 10 : M && M.elite ? 3 : 1));
    const loot = []; if (M) for (const [id, ch] of M.drops) { if (!FORCE_DROP && Math.random() >= ch) continue; let item = null; if (id === '@gear') item = { gear: genGear(mn.lv, M.boss ? 'boss' : M.role) }; else if (CAT.items[id]) item = { id, qty: 1 }; if (!item) continue;
      const did = 'd' + id6(); pendLoot.set(did, { owner: sid, item, exp: Date.now() + CFG.LOOT_MS, kid }); loot.push(Object.assign({ did, x: mn.x + (Math.random() - .5), y: mn.y + (Math.random() - .5) }, item)) }
    send(e.s, { t: 'mreward', kid, id: mn.id, kind: mn.kind, lv: mn.lv, xp, gold, mult, party: n, contrib: e.contrib, loot }); rec.rewards.push({ sid, nm: e.s.nm, xp, gold, loot: loot.length }) }
  record('kills.log', rec); r.mons.delete(mn.id) }
function onPick(s, m) { const did = X.str(String(m.did), 20), L = pendLoot.get(did); if (!L || L.owner !== s.id) return send(s, { t: 'picked', did, ok: false, why: '없는 전리품' }); if (Date.now() > L.exp) { pendLoot.delete(did); return send(s, { t: 'picked', did, ok: false, why: '시간이 지나 사라졌다' }) }
  pendLoot.delete(did); send(s, { t: 'picked', did, ok: true, item: L.item }) }
setInterval(() => { const now = Date.now(); for (const [k, L] of pendLoot) if (now > L.exp) pendLoot.delete(k) }, 60000);

/* ================================ 5. 퀘스트 공유 ================================ */
function onQshare(s, m) { const qid = X.str(m.qid, 40), Q = CAT.quests[qid]; if (!Q) return err(s, 'quest', '없는 퀘스트'); if (!Q.share) return err(s, 'quest', '개인 전용 퀘스트는 공유할 수 없다'); const P = partyOf(s); if (!P) return err(s, 'quest', '파티가 없다');
  let n = 0; for (const sid of P.members) { if (sid === s.id) continue; const o = X.sessions.get(sid); if (!o || !o.ws) continue; send(o, { t: 'qoffer', qid, from: s.id, nm: s.nm }); n++ } send(s, { t: 'info', msg: n ? `퀘스트를 파티원 ${n}명에게 공유했다` : '접속 중인 파티원이 없다' }) }
function onQresp(s, m) { const to = X.sessions.get(X.str(m.to, 20)); if (!to || to.party !== s.party || !s.party) return; send(to, { t: 'qresp', qid: X.str(m.qid, 40), id: s.id, nm: s.nm, ok: !!m.ok, why: X.str(m.why, 60) }) }

/* ================================ 6. 거래 ================================
   신청 → 수락 → 양쪽이 물건·골드를 올림(바뀌면 준비 해제) → 양쪽 준비 → 양쪽 최종 확정 → 서버가 양쪽에 소지 확인 요청 → 둘 다 확인되면 한 번에 완료.
   어느 단계에서든 취소·연결 끊김·시간 초과면 아무것도 옮기지 않는다(물건은 완료 순간까지 각자 가방에 그대로 있다). 완료는 거래 ID 당 한 번. */
const trades = new Map(); // tid → { id, a, b, side: {sid: {items, gold, ready, conf, ok}}, stage, t0 }
const tradeOf = s => s.trade ? trades.get(s.trade) : null;
function tView(T, forS) { const v = { tid: T.id, stage: T.stage }; for (const sid of [T.a, T.b]) { const o = X.sessions.get(sid), sd = T.side[sid]; v[sid === forS.id ? 'me' : 'them'] = { id: sid, nm: o ? o.nm : '?', lv: o ? o.lv : 0, items: sd.items, gold: sd.gold, ready: sd.ready, conf: sd.conf } } return v }
function tPush(T) { for (const sid of [T.a, T.b]) { const o = X.sessions.get(sid); send(o, Object.assign({ t: 'tr_state' }, tView(T, o))) } }
function tEnd(T, why, by) { if (!trades.has(T.id)) return; trades.delete(T.id); for (const sid of [T.a, T.b]) { const o = X.sessions.get(sid); if (o) { o.trade = null; send(o, { t: 'tr_end', tid: T.id, ok: false, why, by }) } } record('trades.log', { t: Date.now(), tid: T.id, done: false, why, a: T.a, b: T.b }) }
function cleanTradeItem(it) { if (!it || typeof it !== 'object') return null; const uid = clampInt(it.uid, 0, 1e9); if (uid === null) return null;
  if (it.gear && typeof it.gear === 'object') { const g = it.gear, B = CAT.bases[g.b]; if (!B) return null; const o = { b: g.b, t: clampInt(g.t, 0, CAT.tiers) ?? 1, r: clampInt(g.r, 0, CAT.rarity - 1) || 0, q: clampInt(g.q, 0, 4) ?? 1 };
    o.aff = Array.isArray(g.aff) ? g.aff.slice(0, 8).filter(a => Array.isArray(a) && typeof a[0] === 'string' && typeof a[1] === 'number' && isFinite(a[1])).map(a => [X.str(a[0], 20), Math.max(-1e5, Math.min(1e5, a[1]))]) : [];
    for (const k of ['dur', 'maxDur', 'cb', 'cs18']) { const v = clampInt(g[k], 0, 1e9); if (v !== null) o[k] = v } if (typeof g.dye === 'string' && HEX.test(g.dye)) o.dye = g.dye; if (CAT.hs18.includes(g.hs18)) o.hs18 = g.hs18; if (typeof g.sk === 'string') o.sk = X.str(g.sk, 20); if (g.crafted) o.crafted = true; if (typeof g.name === 'string') o.name = X.str(g.name, 30); o.broken = !!g.broken; const sty = clampInt(g.sty, 0, 20); if (sty) o.sty = sty;
    return { uid, gear: o } }
  const I = CAT.items[it.id]; if (!I) return null; if (I.type === 'quest' || it.id === 'pouch_mat') return { bad: '퀘스트·귀속 물건은 거래할 수 없다' }; const qty = clampInt(it.qty, 1, 9999); if (!qty) return null; return { uid, id: it.id, qty } }
function onTrade(s, m) { const T = tradeOf(s);
  switch (m.a) {
    case 'req': { if (T) return err(s, 'trade', '이미 거래 중이다'); const o = X.sessions.get(X.str(m.to, 20)); if (!o || !o.ws || o === s) return err(s, 'trade', '상대가 접속해 있지 않다'); if (o.room !== s.room || Math.hypot(o.x - s.x, o.y - s.y) > 12) return err(s, 'trade', '가까이 있어야 거래를 신청할 수 있다'); if (o.trade) return err(s, 'trade', '상대가 이미 거래 중이다');
      const N = { id: 't' + id6(), a: s.id, b: o.id, side: { [s.id]: { items: [], gold: 0, ready: false, conf: false, ok: null }, [o.id]: { items: [], gold: 0, ready: false, conf: false, ok: null } }, stage: 'ask', t0: Date.now() }; trades.set(N.id, N); s.trade = N.id; o.trade = N.id;
      send(o, { t: 'tr_ask', tid: N.id, from: s.id, nm: s.nm, lv: s.lv }); send(s, { t: 'info', msg: `${o.nm} 님에게 거래를 신청했다` }); N.askT = setTimeout(() => { if (trades.get(N.id) && N.stage === 'ask') tEnd(N, '상대가 응답하지 않았다') }, 20000); return }
    case 'answer': { if (!T || T.b !== s.id || T.stage !== 'ask') return; clearTimeout(T.askT); if (!m.ok) return tEnd(T, `${s.nm} 님이 거래를 거절했다`, s.id); T.stage = 'open'; tPush(T); return }
    case 'set': { if (!T || T.stage !== 'open') return; const items = []; for (const it of (Array.isArray(m.items) ? m.items : []).slice(0, CFG.TRADE_SLOTS)) { const c = cleanTradeItem(it); if (!c) return err(s, 'trade', '잘못된 물건'); if (c.bad) return err(s, 'trade', c.bad); if (items.some(x => x.uid === c.uid)) return err(s, 'trade', '같은 물건을 두 번 올릴 수 없다'); items.push(c) }
      const gold = clampInt(m.gold, 0, CFG.GOLD_MAX); if (gold === null) return err(s, 'trade', '골드가 잘못됨');
      T.side[s.id].items = items; T.side[s.id].gold = gold; for (const sid of [T.a, T.b]) { T.side[sid].ready = false; T.side[sid].conf = false } tPush(T); return }
    case 'ready': { if (!T || T.stage !== 'open') return; T.side[s.id].ready = !!m.v; if (!m.v) T.side[s.id].conf = false; tPush(T); return }
    case 'confirm': { if (!T || T.stage !== 'open') return; const A = T.side[T.a], B = T.side[T.b]; if (!(A.ready && B.ready)) return err(s, 'trade', '양쪽이 먼저 준비해야 한다'); T.side[s.id].conf = true; tPush(T);
      if (A.conf && B.conf) { T.stage = 'verify'; for (const sid of [T.a, T.b]) { const o = X.sessions.get(sid), mine = T.side[sid], other = T.side[sid === T.a ? T.b : T.a]; send(o, { t: 'tr_verify', tid: T.id, give: mine.items, gold: mine.gold, recvN: other.items.length }) } T.vT = setTimeout(() => { if (trades.get(T.id) && T.stage === 'verify') tEnd(T, '확인 응답이 없어 취소했다') }, 8000) } return }
    case 'verified': { if (!T || T.stage !== 'verify') return; const sd = T.side[s.id]; if (!m.ok) { clearTimeout(T.vT); return tEnd(T, `${s.nm}: ${X.str(m.why, 60) || '확인 실패'}`, s.id) } sd.ok = true;
      if (T.side[T.a].ok && T.side[T.b].ok) { clearTimeout(T.vT); trades.delete(T.id); T.stage = 'done'; const A = T.side[T.a], B = T.side[T.b];
        for (const [sid, mine, other] of [[T.a, A, B], [T.b, B, A]]) { const o = X.sessions.get(sid); if (o) { o.trade = null; send(o, { t: 'tr_done', tid: T.id, give: mine.items.map(x => ({ uid: x.uid, qty: x.qty || 1 })), recv: other.items, gold: other.gold - mine.gold }) } }
        record('trades.log', { t: Date.now(), tid: T.id, done: true, a: { id: T.a, nm: (X.sessions.get(T.a) || {}).nm, items: A.items, gold: A.gold }, b: { id: T.b, nm: (X.sessions.get(T.b) || {}).nm, items: B.items, gold: B.gold } }); X.log('trade done', T.id) } return }
    case 'cancel': if (T) tEnd(T, `${s.nm} 님이 거래를 취소했다`, s.id); return;
    default: return err(s, 'trade', '모르는 거래 명령') } }
setInterval(() => { const now = Date.now(); for (const T of trades.values()) if (now - T.t0 > CFG.TRADE_MS) tEnd(T, '거래 시간이 초과되었다') }, 5000);

/* ================================ 연결 ================================ */
function onDisconnect(s) { const T = tradeOf(s); if (T) tEnd(T, `${s.nm} 님의 연결이 끊겨 거래를 취소했다`, s.id); const P = partyOf(s); if (P) partyPush(P) }
function onGone(s) { const P = partyOf(s); if (P) partyRemove(s, 'gone') }
function onHello(s) { const P = partyOf(s); if (P) partyPush(P) }
const LIM = { eq: [6, 3000], party: [10, 5000], hp: [8, 1000], madd: [20, 1000], mpos: [12, 1000], mhit: [25, 1000], mgone: [40, 1000], mtake: [10, 1000], pick: [20, 1000], qshare: [8, 5000], qresp: [10, 5000], trade: [20, 3000] };
function handle(s, m) { switch (m.t) {
  case 'eq': onEq(s, m); return true; case 'party': onParty(s, m); return true; case 'hp': onHp(s, m); return true;
  case 'madd': onMadd(s, m); return true; case 'mpos': onMpos(s, m); return true; case 'mhit': onMhit(s, m); return true; case 'mgone': onMgone(s, m); return true; case 'mtake': onMtake(s, m); return true; case 'pick': onPick(s, m); return true;
  case 'qshare': onQshare(s, m); return true; case 'qresp': onQresp(s, m); return true; case 'trade': onTrade(s, m); return true } return false }
function pubExtra(s) { return { eq: s.eq || null, party: s.party || null } }
module.exports = { init: x => { X = x }, handle, LIM, onJoinRoom, onLeaveRoom, onDisconnect, onGone, onHello, pubExtra, CFG, _state: { parties, trades, R, pendLoot } };
