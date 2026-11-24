import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import {memoryHost,createConnection,memoryGet,occupiedHost} from './memory-transport.mjs';
const TCP=process.env.WORMS_TEST_TCP==='1';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGameServer, createMatchServer, loadConfig, DEFAULT_CONFIG } from '../dist/index.js';
import { TokenBucket, RequestIds, RateAbuse } from '../dist/limits.js';
import { LIMITS, validateServerMessage } from '../../protocol/dist/index.js';

const ORIGIN='http://127.0.0.1:4173';
const request=(type,fields={})=>({protocolVersion:2,type,requestId:'req-1',...fields});
async function fixture(t, options={}, createServer=createGameServer) {
  const logs=[];
  const server=createServer({config:{...DEFAULT_CONFIG,port:0},logger:entry=>logs.push(entry),...(!TCP?{httpServer:memoryHost()}:{}),...options});
  const address=await server.start();t.after(()=>server.stop());
  return {server,logs,url:`ws://127.0.0.1:${address.port}/ws`,http:`http://127.0.0.1:${address.port}`,get:route=>(TCP?fetch:memoryGet)(`http://127.0.0.1:${address.port}`+route)};
}
async function connect(t,url,options={}) {
  const ws=new WebSocket(url,{origin:ORIGIN,...(!TCP?{createConnection:createConnection(url)}:{}),...options});
  const inbox=[],waiters=[];let closeResolve;
  const closed=new Promise(resolve=>{closeResolve=resolve;});
  ws.on('error',()=>{});
  ws.on('message',data=>{const message=JSON.parse(data.toString());assert.equal(validateServerMessage(message).ok,true);if(waiters.length)waiters.shift()(message);else inbox.push(message);});
  ws.on('close',(code)=>closeResolve(code));
  t.after(()=>ws.terminate());
  await once(ws,'open');
  return {ws,closed,send:value=>ws.send(typeof value==='string'?value:JSON.stringify(value)),next(){if(inbox.length)return Promise.resolve(inbox.shift());return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Message timeout')),2000);waiters.push(value=>{clearTimeout(timer);resolve(value);});});}};
}
async function hello(client,id='hello-1',name='Host') {client.send(request('hello',{requestId:id,displayName:name}));const m=await client.next();assert.equal(m.type,'welcome');return m;}
async function refused(url,options={}) {
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(url,{origin:ORIGIN,...(!TCP?{createConnection:createConnection(url)}:{}),...options});
    ws.on('error',()=>{});ws.on('open',()=>{ws.terminate();reject(Error('Unexpected upgrade'));});
    ws.on('unexpected-response',(_request,response)=>{response.resume();ws.terminate();resolve(response.statusCode);});
  });
}
test('two WebSocket clients get unique server identities; health endpoint stays independent',async t=>{
  const f=await fixture(t);const a=await connect(t,f.url),b=await connect(t,f.url);
  const wa=await hello(a,'hello-a','  Host  '),wb=await hello(b,'hello-b','Guest');
  assert.equal(wa.displayName,'Host');assert.notEqual(wa.playerId,wb.playerId);assert.notEqual(wa.connectionId,wb.connectionId);
  assert.equal(f.server.connectionCount,2);assert.deepEqual(wa.limits,LIMITS);
  const response=await f.get('/health');assert.equal(response.status,200);assert.equal((await response.json()).stage,'S0');
  assert.equal((await f.get('/')).status,404);
  a.ws.close(1000);assert.equal(await a.closed,1000);await delay(10);assert.equal(f.server.connectionCount,1);
  assert(f.logs.some(e=>e.event==='handshake-completed'));assert(f.logs.some(e=>e.event==='connection-closed'));
});
test('Origin, endpoint and subprotocol are checked before upgrade',async t=>{
  const f=await fixture(t);
  assert.equal(await refused(f.url,{origin:'https://untrusted.example'}),403);
  assert.equal(await refused(f.url,{origin:'null'}),403);
  assert.equal(await refused(f.url,{origin:undefined}),403);
  assert.equal(await refused(f.url.replace('/ws','/other')),404);
  assert.equal(await refused(f.url+'?token=secret'),404);
  assert.equal(await refused(f.url,{headers:{'Sec-WebSocket-Protocol':'other'}}),400);
  assert.equal(f.server.connectionCount,0);
});
test('native clients without Origin require explicit configuration',async t=>{
  const f=await fixture(t,{config:{...DEFAULT_CONFIG,port:0,allowNoOrigin:true}});
  const c=await connect(t,f.url,{origin:undefined});await hello(c);
  assert.equal(await refused(f.url,{origin:'http://untrusted'}),403);
});
test('real built-in WebSocket client interoperates with server',{skip:!TCP&&'Requires TCP; run npm run test:server:tcp'},async t=>{
  const f=await fixture(t,{config:{...DEFAULT_CONFIG,port:0,allowNoOrigin:true}});
  const ws=new globalThis.WebSocket(f.url);t.after(()=>ws.close());
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  const reply=new Promise(resolve=>{ws.onmessage=e=>resolve(JSON.parse(e.data));});
  ws.send(JSON.stringify(request('hello',{displayName:'Native'})));assert.equal((await reply).type,'welcome');
});
test('handshake gate and second hello do not reassign identity',async t=>{
  const f=await fixture(t),c=await connect(t,f.url);
  c.send(request('room.create'));assert.equal((await c.next()).code,'handshake-required');
  const w=await hello(c,'hello-2');
  c.send(request('hello',{requestId:'hello-3',displayName:'Other'}));assert.equal((await c.next()).code,'already-initialized');
  assert.equal(f.logs.filter(x=>x.event==='handshake-completed').length,1);assert.equal(f.logs.find(x=>x.event==='handshake-completed').playerId,w.playerId);
});
test('handshake timeout closes silent connection', {timeout:8000},async t=>{
  const f=await fixture(t),c=await connect(t,f.url);assert.equal(await c.closed,1008);
});
test('malformed JSON, unknown type and forged playerId never reach handler',async t=>{
  const accepted=[];const f=await fixture(t,{onRequest:(r,s)=>{accepted.push(r);s.send({protocolVersion:2,type:'result',requestId:r.requestId,requestType:'room.leave',ok:true});}}),c=await connect(t,f.url);
  c.send('{');assert.equal((await c.next()).code,'invalid-json');
  c.send(request('hello',{displayName:'\u0000private'}));assert.equal((await c.next()).code,'invalid-message');
  await hello(c);
  c.send(request('cheat',{requestId:'bad-type'}));assert.equal((await c.next()).code,'unknown-type');
  c.send(request('game.command',{requestId:'spoof',roomId:'room',matchId:'match',commandId:'cmd',action:{type:'jump',playerId:'victim'}}));assert.equal((await c.next()).code,'invalid-message');
  c.send(request('room.leave',{requestId:'good',roomId:'room'}));assert.equal((await c.next()).ok,true);assert.equal(accepted.length,1);
});
test('unsupported version gets an error and policy close',async t=>{
  const f=await fixture(t),c=await connect(t,f.url);c.send(request('hello',{protocolVersion:1,displayName:'Host'}));
  assert.equal((await c.next()).code,'unsupported-version');assert.equal(await c.closed,1008);
});
test('binary, invalid UTF-8, bad masking and fragmented oversize messages are closed',async t=>{
  const f=await fixture(t);
  const binary=await connect(t,f.url);binary.ws.send(Buffer.from('{}'));assert.equal((await binary.next()).code,'invalid-message');assert.equal(await binary.closed,1003);
  const utf8=await connect(t,f.url);utf8.ws.send(Buffer.from([0xc3,0x28]),{binary:false});assert.equal(await utf8.closed,1007);
  const mask=await connect(t,f.url);mask.ws.send('{}',{mask:false});assert.equal(await mask.closed,1002);
  const large=await connect(t,f.url);large.ws.send('x'.repeat(3000),{fin:false});large.ws.send('x'.repeat(2000),{fin:true});assert.equal(await large.closed,1009);
  const valid=await connect(t,f.url);await hello(valid);
});
test('valid fragmented text messages are reassembled and compression is disabled',async t=>{
  const f=await fixture(t),c=await connect(t,f.url,{perMessageDeflate:true});
  const text=JSON.stringify(request('hello',{displayName:'Fragment'}));c.ws.send(text.slice(0,30),{fin:false});c.ws.send(text.slice(30),{fin:true});
  assert.equal((await c.next()).type,'welcome');assert.equal(c.ws.extensions,'');
});
test('request/command duplicates are rejected atomically before handler',async t=>{
  const handled=[];const f=await fixture(t,{onRequest:(r,s)=>{handled.push([r.commandId,s.identity]);s.send({protocolVersion:2,type:'command.result',requestId:r.requestId,commandId:r.commandId,matchId:r.matchId,accepted:false,revision:null,rejection:'not-in-room'});}}),c=await connect(t,f.url);
  const w=await hello(c);
  const cmd=request('game.command',{requestId:'a',commandId:'cmd-a',roomId:'room',matchId:'match',action:{type:'jump'}});
  c.send(cmd);assert.equal((await c.next()).type,'command.result');
  c.send(cmd);assert.equal((await c.next()).code,'duplicate-id');
  c.send({...cmd,requestId:'b'});assert.equal((await c.next()).code,'duplicate-id');
  c.send({...cmd,requestId:'b',commandId:'cmd-b'});assert.equal((await c.next()).type,'command.result');
  assert.equal(handled.length,2);assert.equal(handled[0][1].playerId,w.playerId);assert(Object.isFrozen(handled[0][1]));
});
test('S0 explicitly refuses room commands while S1 dispatcher is absent',async t=>{
  const f=await fixture(t),c=await connect(t,f.url);await hello(c);
  c.send(request('room.create',{requestId:'create'}));assert.equal((await c.next()).code,'not-implemented');
});
test('global and snapshot-specific rate limits are applied',async t=>{
  const f=await fixture(t),c=await connect(t,f.url);await hello(c);
  for(let i=0;i<3;i++)c.send(request('game.snapshot',{requestId:'snap-'+i,roomId:'room',matchId:'match'}));
  assert.equal((await c.next()).code,'not-implemented');assert.equal((await c.next()).code,'not-implemented');assert.equal((await c.next()).code,'rate-limited');
  const flood=await connect(t,f.url);await hello(flood);
  for(let i=0;i<80;i++)flood.send('{');const codes=[];for(let i=0;i<80;i++)codes.push((await flood.next()).code);
  assert(codes.includes('rate-limited'));assert(codes.includes('invalid-json'));
});
test('maximum connections includes peers which have not said hello',async t=>{
  const f=await fixture(t),clients=[];
  for(let i=0;i<LIMITS.maxConnections;i++)clients.push(await connect(t,f.url));
  assert.equal(await refused(f.url),503);assert.equal(f.server.connectionCount,64);
  clients[0].ws.close();await clients[0].closed;await delay(10);
  const replacement=await connect(t,f.url);await hello(replacement);
});
test('handler dispatch is serialized and exceptions close only the affected client',async t=>{
  const order=[];let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{onRequest:async(r,s)=>{order.push(r.requestId);if(r.requestId==='first')await gate;if(r.requestId==='fail')throw Error('secret exception');s.send({protocolVersion:2,type:'result',requestId:r.requestId,requestType:'room.leave',ok:true});}});
  const c=await connect(t,f.url);await hello(c);
  c.send(request('room.leave',{requestId:'first',roomId:'room'}));c.send(request('room.leave',{requestId:'second',roomId:'room'}));
  await delay(20);assert.deepEqual(order,['first']);release();assert.equal((await c.next()).requestId,'first');assert.equal((await c.next()).requestId,'second');
  c.send(request('room.leave',{requestId:'fail',roomId:'room'}));assert.equal((await c.next()).code,'internal-error');assert.equal(await c.closed,1011);
  const other=await connect(t,f.url);await hello(other);assert(!JSON.stringify(f.logs).includes('secret exception'));
});
test('invalid outgoing DTO is blocked; disconnected identities are released once',async t=>{
  const identities=[];const f=await fixture(t,{onRequest:(_r,s)=>s.send({protocolVersion:2,type:'cheat'}),onDisconnect:i=>identities.push(i)}),c=await connect(t,f.url);
  const w=await hello(c);c.send(request('room.create',{requestId:'create'}));assert.equal(await c.closed,1011);await delay(10);
  assert.equal(identities.length,1);assert.equal(identities[0].playerId,w.playerId);assert.equal(f.server.connectionCount,0);
});
test('logger errors cannot crash network handling; normal logs never contain payloads or names',async t=>{
  const f=await fixture(t),c=await connect(t,f.url);await hello(c,'hello-1','PrivateName');c.send('{"privateToken":"SuperSecret"');await c.next();
  const output=JSON.stringify(f.logs);assert(!output.includes('PrivateName'));assert(!output.includes('SuperSecret'));assert(!output.includes('privateToken'));
  const badLogger=await fixture(t,{logger:()=>{throw Error('logger');}}),other=await connect(t,badLogger.url);await hello(other);
});
test('shutdown closes active connections and is idempotent',async t=>{
  const f=await fixture(t),c=await connect(t,f.url);await hello(c);
  const stopping=f.server.stop();await stopping;assert.equal(await c.closed,1001);await f.server.stop();assert.equal(f.server.connectionCount,0);
});
test('configuration is explicit and rejects malformed host/port/Origin options',()=>{
  assert.deepEqual(loadConfig([]),DEFAULT_CONFIG);
  assert.deepEqual(loadConfig(['--host','0.0.0.0','--port','5000','--origin','http://192.168.1.10:4173','--allow-no-origin']),{host:'0.0.0.0',port:5000,allowedOrigins:['http://192.168.1.10:4173'],allowNoOrigin:true});
  assert.equal(loadConfig([],{WORMS_HOST:'::1',WORMS_PORT:'4181',WORMS_ORIGINS:'https://example.test',WORMS_ALLOW_NO_ORIGIN:'true'}).allowNoOrigin,true);
  assert.equal(loadConfig(['--port','4182'],{WORMS_PORT:'4181'}).port,4182);
  for(const args of [['--port','0'],['--port','1.2'],['--port','1e3'],['--port','65536'],['--host','not-a-host'],['--origin','*'],['--origin','http://host/path'],['--origin','null'],['--origin','http://u:p@host'],['--port'],['--unknown']])assert.throws(()=>loadConfig(args));
  assert.throws(()=>loadConfig([],{WORMS_ALLOW_NO_ORIGIN:'yes'}));
  assert.equal(loadConfig(['--port','4180','--allow-no-origin'],{WORMS_PORT:'invalid',WORMS_ALLOW_NO_ORIGIN:'invalid'}).port,4180);
});
test('monotonic token buckets, sustained overload and atomic ID bounds',()=>{
  const bucket=new TokenBucket(2,2,1000);assert(bucket.take(1000));assert(bucket.take(1000));assert(!bucket.take(1000));assert(!bucket.take(0));assert(bucket.take(1500));assert(!bucket.take(1500));assert(bucket.take(5000));assert(bucket.take(5000));assert(!bucket.take(5000));
  const ids=new RequestIds(2);assert.equal(ids.reserve('r1','c1'),'accepted');assert.equal(ids.reserve('r2','c1'),'duplicate-id');assert.equal(ids.reserve('r2','c2'),'accepted');assert.equal(ids.reserve('r3','c3'),'resource-limit');assert.equal(ids.reserve('r1','c4'),'duplicate-id');
  const abuse=new RateAbuse();for(let n=0;n<5000;n+=500)assert(!abuse.denied(n));assert(abuse.denied(5000));assert(!abuse.denied(7000));
});
test('listen failure is reported without exposing raw exceptions',async t=>{
  const server=createGameServer({httpServer:occupiedHost(),config:{...DEFAULT_CONFIG,port:4180},logger:()=>{}});t.after(()=>server.stop());
  await assert.rejects(server.start(),/Unable to listen/);
});
test('CLI help and invalid configuration work from project and package directories',async()=>{
  const main=fileURLToPath(new URL('../dist/main.js',import.meta.url));
  const directories=[new URL('../../../',import.meta.url),new URL('../',import.meta.url)];
  async function cli(args,cwd){return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[main,...args],{windowsHide:true,cwd});
    let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
    child.once('error',reject);child.once('close',code=>resolve({code,output}));
  });}
  for(const cwd of directories){
    const help=await cli(['--help'],cwd);assert.equal(help.code,0,help.output);assert(help.output.includes('/ws'));assert(help.output.includes('(S2)'));
    const invalid=await cli(['--port','0'],cwd);assert.equal(invalid.code,1,invalid.output);assert(invalid.output.includes('Port must be 1..65535'));assert(!invalid.output.includes(' at '));
  }
});

test('pending request count is bounded while an async dispatcher stalls',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const f=await fixture(t,{onRequest:()=>gate}),c=await connect(t,f.url);await hello(c);
  for(let i=0;i<59;i++)c.send(request('room.create',{requestId:'queued-'+i}));
  await delay(100);
  c.send(request('room.create',{requestId:'queued-59'}));c.send(request('room.create',{requestId:'queued-60'}));
  assert.equal((await c.next()).code,'resource-limit');assert.equal(await c.closed,1013);
});
test('stop during startup waits for listen completion; stopped servers cannot restart',async t=>{
  const server=createGameServer({httpServer:memoryHost(),config:{...DEFAULT_CONFIG,port:0},logger:()=>{}});t.after(()=>server.stop());
  const started=server.start();const stopped=server.stop();await started;await stopped;
  assert.equal(server.connectionCount,0);await assert.rejects(server.start(),/only start once/);
});
test('outgoing socket queue is bounded even when the peer stops reading',{skip:TCP&&'Deterministic stream backpressure test'},async t=>{
  let refusedSend=false;
  const f=await fixture(t,{onRequest:(request,session)=>{
    const message={protocolVersion:2,type:'error',requestId:request.requestId,code:'internal-error',message:'x'.repeat(256)};
    for(let i=0;i<5000;i++){if(!session.send(message)){refusedSend=true;break;}}
  }}),c=await connect(t,f.url);await hello(c);
  const socket=c.ws._socket.peer,original=socket._write;let held;
  socket._write=function(chunk,encoding,callback){held={chunk,encoding,callback};};
  c.send(request('room.create',{requestId:'backpressure'}));await delay(20);assert(refusedSend);assert(held);
  socket._write=original;original.call(socket,held.chunk,held.encoding,held.callback);
  assert.equal(await c.closed,1013);
});

async function receive(client, predicate) {
  for (;;) {
    const message = await client.next();
    if (predicate(message)) return message;
  }
}

function sendRequest(client, type, requestId, fields = {}) {
  client.send(request(type, { requestId, ...fields }));
  return receive(client, message => message.requestId === requestId);
}

async function createRoom(host) {
  const result = await sendRequest(host, 'room.create', 'create');
  assert.equal(result.ok, true);
  assert.deepEqual(await host.next(), { protocolVersion: 2, type: 'room.state', room: result.room });
  assert.match(result.resumeToken, /^[A-Za-z0-9_-]{43}$/);
  return result;
}

async function startMatch(host, guest) {
  const { room: { roomId }, resumeToken: hostToken } = await createRoom(host);
  const join = await sendRequest(guest, 'room.join', 'join', { roomId });
  assert.equal(join.ok, true);
  assert.match(join.resumeToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(join.resumeToken, hostToken);
  assert.deepEqual((await host.next()).room, join.room);
  assert.deepEqual((await guest.next()).room, join.room);

  for (const player of [host, guest]) {
    const ready = await sendRequest(player, 'room.ready', 'ready', { roomId, ready: true });
    assert.equal(ready.ok, true);
    assert.deepEqual((await host.next()).room, ready.room);
    assert.deepEqual((await guest.next()).room, ready.room);
  }

  const starting = sendRequest(host, 'room.start', 'start', { roomId });
  host.send(request('room.start', { requestId: 'second-start', roomId }));
  const start = await starting;
  const { matchId } = start;
  assert.equal(start.ok, true);
  assert.equal(start.revision, 0);
  assert.notEqual(matchId, roomId);
  const playing = await host.next();
  assert.equal(playing.type, 'room.state');
  assert.equal(playing.room.status, 'playing');
  assert.equal(playing.room.matchId, matchId);
  assert(playing.room.players.every(player => !player.ready && player.connected));
  assert.deepEqual(await guest.next(), playing);
  const initial = await host.next();
  assert.equal(initial.type, 'game.update');
  assert.equal(initial.revision, 0);
  assert.equal(initial.state.phase, 'waiting');
  assert.deepEqual(initial.events, []);
  assert.deepEqual(await guest.next(), initial);
  assert.equal((await host.next()).code, 'room-not-in-lobby');
  return { roomId, matchId, initial, hostToken, guestToken: join.resumeToken };
}

test('S1 lobby serializes competing joins, resets readiness and transfers the host role', async t => {
  const f = await fixture(t, {}, createMatchServer);
  const host = await connect(t, f.url), first = await connect(t, f.url), second = await connect(t, f.url);
  const [, firstIdentity, secondIdentity] = await Promise.all([hello(host), hello(first), hello(second)]);
  assert.equal((await (await f.get('/health')).json()).stage, 'S2');
  const { room: { roomId, roomRevision } } = await createRoom(host);
  assert.equal(roomRevision, 1);
  assert.equal((await sendRequest(host, 'room.create', 'another')).code, 'already-in-room');
  const ready = await sendRequest(host, 'room.ready', 'ready', { roomId, ready: true });
  assert.equal(ready.room.roomRevision, 2);
  assert.deepEqual((await host.next()).room, ready.room);
  const repeated = await sendRequest(host, 'room.ready', 'repeated', { roomId, ready: true });
  assert.deepEqual(repeated.room, ready.room);
  assert.equal((await sendRequest(host, 'room.start', 'premature', { roomId })).code, 'players-not-ready');
  assert.equal((await sendRequest(host, 'game.snapshot', 'lobby-snapshot', { roomId, matchId: 'none' })).code, 'match-not-found');

  const candidates = [[first, firstIdentity], [second, secondIdentity]];
  const results = await Promise.all(candidates.map(([client]) => sendRequest(client, 'room.join', 'join', { roomId })));
  assert.deepEqual(results.map(result => result.ok).sort(), [false, true]);
  const index = results.findIndex(result => result.ok);
  const [guest, guestIdentity] = candidates[index];
  const [outside] = candidates[1 - index];
  assert.equal(results[1 - index].code, 'room-full');
  const joined = results[index].room;
  assert.equal(joined.roomRevision, 3);
  assert.deepEqual(joined.players.map(player => player.ready), [false, false]);
  assert.deepEqual(await guest.next(), await host.next());
  assert.equal((await sendRequest(guest, 'room.start', 'guest-start', { roomId })).code, 'not-host');
  assert.equal((await sendRequest(outside, 'room.ready', 'outside-ready', { roomId, ready: true })).code, 'not-in-room');

  const guestReady = await sendRequest(guest, 'room.ready', 'guest-ready', { roomId, ready: true });
  assert.equal(guestReady.room.players[1].ready, true);
  assert.deepEqual(await guest.next(), await host.next());
  const left = await sendRequest(host, 'room.leave', 'leave', { roomId });
  assert.equal(left.ok, true);
  const promoted = await guest.next();
  assert.equal(promoted.type, 'room.state');
  assert.equal(promoted.room.hostPlayerId, guestIdentity.playerId);
  assert.equal(promoted.room.roomRevision, 5);
  assert.deepEqual(promoted.room.players.map(player => player.ready), [false]);

  const rejoined = await sendRequest(outside, 'room.join', 'new-guest', { roomId });
  assert.equal(rejoined.ok, true);
  assert.deepEqual(await guest.next(), await outside.next());
  guest.ws.close(1000);
  const afterDisconnect = await outside.next();
  assert.equal(afterDisconnect.room.players.length, 1);
  assert.equal(afterDisconnect.room.hostPlayerId, afterDisconnect.room.players[0].playerId);
  assert.equal((await sendRequest(outside, 'room.leave', 'empty', { roomId })).ok, true);
  assert.equal((await sendRequest(host, 'room.join', 'after-close', { roomId })).code, 'room-not-found');
});

test('S1 room limit releases capacity after the last member leaves', async t => {
  const f = await fixture(t, {}, createMatchServer);
  const hosts = await Promise.all(Array.from({ length: LIMITS.maxRooms }, () => connect(t, f.url)));
  await Promise.all(hosts.map(client => hello(client)));
  const [first] = await Promise.all(hosts.map(createRoom));
  const extra = await connect(t, f.url);
  await hello(extra);
  assert.equal((await sendRequest(extra, 'room.create', 'over-limit')).code, 'resource-limit');
  assert.equal((await sendRequest(hosts[0], 'room.leave', 'free-slot', { roomId: first.room.roomId })).ok, true);
  await createRoom(extra);
});

test('S1 two WebSockets play the same match through destruction, turn changes and victory', { timeout: 15000 }, async t => {
  const f = await fixture(t, {}, createMatchServer);
  const host = await connect(t, f.url), guest = await connect(t, f.url), outside = await connect(t, f.url);
  const [hostIdentity, guestIdentity] = await Promise.all([hello(host), hello(guest), hello(outside)]);
  const { roomId, matchId, initial, guestToken } = await startMatch(host, guest);
  const address = { roomId, matchId };
  const command = (client, id, action, fields = {}) => sendRequest(client, 'game.command', id, {
    commandId: 'cmd-' + id, ...address, ...fields, action,
  });
  assert.deepEqual(initial.state.players, [hostIdentity.playerId, guestIdentity.playerId]);
  assert.equal(initial.state.terrain.width, 320);
  assert.equal(initial.state.terrain.height, 180);
  assert.equal(initial.state.turnDurationTicks, 3600);
  await delay(150);
  const waiting = await sendRequest(host, 'game.snapshot', 'waiting', address);
  assert.equal(waiting.revision, 0);
  assert.equal(waiting.state.tick, 0);
  assert.equal(waiting.state.turnTicksRemaining, 0);
  assert.equal((await sendRequest(outside, 'room.join', 'playing', { roomId })).code, 'room-not-joinable');
  assert.equal((await command(outside, 'outside-action', { type: 'start-turn' })).rejection, 'not-in-room');
  const mismatch = await command(host, 'wrong-match', { type: 'start-turn' }, { matchId: 'wrong' });
  assert.equal(mismatch.rejection, 'match-mismatch');
  assert.equal(mismatch.revision, null);
  assert.equal((await command(guest, 'wrong-turn', { type: 'start-turn' })).rejection, 'wrong-player');
  assert.equal((await command(host, 'fire-too-soon', { type: 'fire', angleDegrees: 90, power: 0 })).rejection, 'wrong-phase');

  const started = await command(host, 'first-turn', { type: 'start-turn' });
  assert.equal(started.accepted, true);
  assert.equal(started.revision, 1);
  const active = await receive(host, message => message.type === 'game.update' && message.state.tick >= 2);
  assert.equal(active.state.phase, 'active');
  assert.equal(active.state.turnTicksRemaining, 3600 - active.state.tick);
  assert.equal(active.revision, active.state.tick + 1);
  assert.deepEqual(await receive(guest, message => message.type === 'game.update' && message.revision === active.revision), active);

  const fire = { type: 'fire', angleDegrees: 90, power: 0 };
  const shot = await command(host, 'shot', fire);
  assert.equal(shot.accepted, true);
  const duplicate = await command(host, 'duplicate-shot', fire, { commandId: 'cmd-shot' });
  assert.deepEqual(duplicate, { ...shot, requestId: 'duplicate-shot' });
  const resolving = await sendRequest(host, 'game.snapshot', 'resolving', address);
  assert.equal(resolving.type, 'game.snapshot');
  assert.equal(resolving.state.phase, 'resolving');
  assert(resolving.revision >= shot.revision);
  assert.deepEqual(resolving.events, []);

  const following = message => message.type === 'game.update' && message.state.phase === 'waiting';
  const seen = [];
  let previous = active;
  const nextTurn = await receive(guest, message => {
    if (message.type === 'game.update') {
      assert(message.revision > previous.revision);
      // Unix time is stamped in whole milliseconds, so allow one millisecond of rounding.
      assert(message.serverTimeMs - previous.serverTimeMs >= 99);
      seen.push(...message.events);
      previous = message;
    }
    return following(message);
  });
  assert.deepEqual(await receive(host, following), nextTurn);
  assert.equal(nextTurn.state.players[nextTurn.state.activePlayerIndex], guestIdentity.playerId);
  assert(nextTurn.state.worms[0].health < 100);
  assert.notDeepEqual(nextTurn.state.terrain.cells, initial.state.terrain.cells);
  assert.equal(seen.filter(event => event.type === 'shot-fired').length, 1);
  assert(seen.some(event => event.type === 'explosion'));

  assert.equal((await command(guest, 'guest-turn', { type: 'start-turn' })).accepted, true);
  assert.equal((await command(guest, 'guest-pass', { type: 'end-turn' })).accepted, true);
  assert.equal((await command(host, 'last-turn', { type: 'start-turn' })).accepted, true);
  assert.equal((await command(host, 'last-shot', fire)).accepted, true);
  const isFinished = message => message.type === 'game.update' && message.state.phase === 'finished';
  const finished = await receive(host, isFinished);
  assert.deepEqual(await receive(guest, isFinished), finished);
  assert.equal(finished.state.winnerId, guestIdentity.playerId);
  assert.deepEqual(finished.events.at(-1), { type: 'game-finished', winnerId: guestIdentity.playerId });
  const finishedRoom = await host.next();
  assert.equal(finishedRoom.type, 'room.state');
  assert.equal(finishedRoom.room.status, 'finished');
  assert.deepEqual(await guest.next(), finishedRoom);
  assert.equal((await command(host, 'late-action', { type: 'start-turn' })).rejection, 'game-finished');
  assert.equal((await sendRequest(host, 'room.start', 'restart', { roomId })).code, 'room-not-in-lobby');
  guest.ws.terminate();
  await receive(host, message => message.type === 'room.state' && !message.room.players[1].connected);
  const rejoined = await connect(t, f.url);
  const welcome = await sendRequest(rejoined, 'hello', 'finished-resume', { resumeToken: guestToken });
  assert.equal(welcome.playerId, guestIdentity.playerId);
  assert.equal(welcome.resumed.room.status, 'finished');
  assert.deepEqual(welcome.resumed.snapshot.state, finished.state);
  assert.deepEqual(welcome.resumed.snapshot.events, []);
  await receive(host, message => message.type === 'room.state' && message.room.players[1].connected);
  assert.equal((await sendRequest(rejoined, 'room.leave', 'finished-leave', { roomId })).ok, true);
  assert.deepEqual(await host.next(), { protocolVersion: 2, type: 'room.closed', ...address, reason: 'player-left' });
  assert.equal((await sendRequest(host, 'game.snapshot', 'after-leave', address)).code, 'not-in-room');
});

test('S2 reconnects during flight and returns the original result for a fire without a consumed acknowledgement', async t => {
  const f = await fixture(t, {}, createMatchServer);
  const host = await connect(t, f.url), guest = await connect(t, f.url);
  const [identity] = await Promise.all([hello(host), hello(guest)]);
  const { roomId, matchId, hostToken, initial } = await startMatch(host, guest);
  const address = { roomId, matchId };
  assert.equal((await sendRequest(host, 'game.command', 'turn', {
    ...address, commandId: 'turn', action: { type: 'start-turn' },
  })).accepted, true);
  const action = { type: 'fire', angleDegrees: 90, power: 0 };
  host.send(request('game.command', { ...address, requestId: 'first-shot', commandId: 'shot', action }));
  const flight = await receive(guest, message => message.type === 'game.update' && message.state.projectile !== null);
  host.ws.terminate();
  const away = await receive(guest, message => message.type === 'room.state' && !message.room.players[0].connected);
  assert.equal(away.room.matchId, matchId);
  const returning = await connect(t, f.url);
  const welcome = await sendRequest(returning, 'hello', 'restore', { resumeToken: hostToken });
  assert.equal(welcome.playerId, identity.playerId);
  assert.notEqual(welcome.connectionId, identity.connectionId);
  assert.equal(welcome.resumed.room.players[0].connected, true);
  assert.equal(welcome.resumed.snapshot.state.phase, 'resolving');
  assert(welcome.resumed.snapshot.revision >= flight.revision);
  assert.deepEqual(welcome.resumed.snapshot.events, []);
  await receive(guest, message => message.type === 'room.state' && message.room.players[0].connected);

  const retained = await sendRequest(returning, 'game.command', 'repeated-shot', {
    ...address, commandId: 'shot', action: { power: 0, angleDegrees: 90, type: 'fire' },
  });
  assert.equal(retained.accepted, true);
  assert(retained.revision <= flight.revision);
  const conflict = await sendRequest(returning, 'game.command', 'different-shot', {
    ...address, commandId: 'shot', action: { ...action, power: 1 },
  });
  assert.equal(conflict.code, 'command-id-conflict');
  const recovered = await receive(returning, message => message.type === 'game.update' && message.state.phase === 'waiting');
  assert.equal(recovered.state.turnNumber, 2);
  assert(recovered.state.worms[0].health < 100);
  assert.notDeepEqual(recovered.state.terrain.cells, initial.state.terrain.cells);
  assert(!JSON.stringify(f.logs).includes(hostToken));
});

test('S2 retains the waiting turn and drops held movement without stopping active time', async t => {
  const f = await fixture(t, {}, createMatchServer);
  let host = await connect(t, f.url);
  const guest = await connect(t, f.url);
  await Promise.all([hello(host), hello(guest)]);
  const { roomId, matchId, hostToken } = await startMatch(host, guest);
  const address = { roomId, matchId };
  const returning = await connect(t, f.url);
  assert.equal((await sendRequest(returning, 'hello', 'occupied', { resumeToken: hostToken })).code, 'resume-in-use');
  host.ws.terminate();
  await receive(guest, message => message.type === 'room.state' && !message.room.players[0].connected);
  const restored = await sendRequest(returning, 'hello', 'waiting', { resumeToken: hostToken });
  assert.equal(restored.resumed.snapshot.state.phase, 'waiting');
  assert.equal(restored.resumed.snapshot.state.tick, 0);
  host = returning;
  for (const action of [{ type: 'start-turn' }, { type: 'move', direction: 1 }]) {
    assert.equal((await sendRequest(host, 'game.command', action.type, { ...address, commandId: action.type, action })).accepted, true);
  }
  const moving = await receive(guest, message => message.type === 'game.update' && message.state.movementDirection === 1);
  host.ws.terminate();
  const stopped = await receive(guest, message => message.type === 'game.update' && message.state.movementDirection === 0);
  assert.equal(stopped.state.phase, 'active');
  assert(stopped.state.turnTicksRemaining < moving.state.turnTicksRemaining);
});

test('S2 expires the absent player’s seat and frees both members', async t => {
  const f = await fixture(t, { resumeRetentionMs: 150 }, createMatchServer);
  const host = await connect(t, f.url), guest = await connect(t, f.url);
  await Promise.all([hello(host), hello(guest)]);
  const { roomId, matchId, hostToken } = await startMatch(host, guest);
  host.ws.terminate();
  await receive(guest, message => message.type === 'room.state' && !message.room.players[0].connected);
  const closed = await receive(guest, message => message.type === 'room.closed');
  const address = { roomId, matchId };
  assert.deepEqual(closed, { protocolVersion: 2, type: 'room.closed', ...address, reason: 'player-disconnected' });
  assert.equal((await sendRequest(guest, 'room.join', 'closed-join', { roomId })).code, 'room-not-found');
  const returning = await connect(t, f.url);
  assert.equal((await sendRequest(returning, 'hello', 'expired', { resumeToken: hostToken })).code, 'resume-unavailable');
  assert.notEqual((await createRoom(guest)).room.roomId, roomId);
});
