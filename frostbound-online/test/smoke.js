// 로컬 자동 시험: 서버를 띄우고 WebSocket 클라이언트 2개로 입장·이동·채팅·감정표현·퇴장을 확인한다 (Node 22 이상: 내장 WebSocket 사용)
const { spawn } = require('child_process'), path = require('path');
const PORT = 18000 + Math.floor(Math.random() * 1000), URL = `ws://127.0.0.1:${PORT}/ws`;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client(nm) { return new Promise((res, rej) => { const ws = new WebSocket(URL), c = { ws, nm, got: [] }; ws.onmessage = e => c.got.push(JSON.parse(e.data)); ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', nm, lv: 3, race: 'human' })); res(c) }; ws.onerror = rej }) }
const has = (c, f) => c.got.some(f), results = [];
const check = (name, v) => { results.push([name, v]); console.log((v ? 'PASS ' : 'FAIL ') + name) };
(async () => { await sleep(600);
  const a = await client('A'), b = await client('B'); await sleep(200);
  a.ws.send(JSON.stringify({ t: 'join', room: 'imperial_town', x: 50, y: 50 })); await sleep(100); b.ws.send(JSON.stringify({ t: 'join', room: 'imperial_town', x: 52, y: 50 })); await sleep(300);
  check('welcome', has(a, m => m.t === 'welcome') && has(b, m => m.t === 'welcome'));
  check('A sees B join', has(a, m => m.t === 'pjoin' && m.p.nm === 'B'));
  check('B gets room list with A', has(b, m => m.t === 'room' && m.players.some(p => p.nm === 'A')));
  a.ws.send(JSON.stringify({ t: 'st', x: 51, y: 50.5, f: -1, mv: true })); await sleep(200);
  check('B sees A move', has(b, m => m.t === 'pst' && m.x === 51 && m.f === -1));
  b.ws.send(JSON.stringify({ t: 'chat', m: 'hello' })); await sleep(200);
  check('chat relayed', has(a, m => m.t === 'chat' && m.m === 'hello' && m.nm === 'B'));
  a.ws.send(JSON.stringify({ t: 'emote', k: 'wave' })); await sleep(200);
  check('emote relayed', has(b, m => m.t === 'emote' && m.k === 'wave'));
  b.ws.close(); await sleep(400);
  check('leave relayed', has(a, m => m.t === 'pleave'));
  a.ws.close(); srv.kill(); const fail = results.filter(r => !r[1]).length; console.log(fail ? `${fail} FAILED` : 'ALL PASSED'); process.exit(fail ? 1 : 0)
})().catch(e => { console.error(e); srv.kill(); process.exit(1) });
