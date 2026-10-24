import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createGame, dispatch, step } from '../../game-core/dist/index.js';
import { LIMITS, parseClientMessage, parseServerMessage, validateClientMessage, validateServerMessage } from '../dist/index.js';

const fixtures = JSON.parse(readFileSync(new URL('../examples/exchanges.json', import.meta.url), 'utf8'));
const client = (type, fields = {}) => ({ protocolVersion: 1, type, requestId: 'req-1', ...fields });
const error = (fields = {}) => ({ protocolVersion: 1, type: 'error', requestId: null, code: 'invalid-message', message: 'Invalid message', ...fields });
const snapshot = () => ({ protocolVersion: 1, type: 'game.update', roomId: 'room-1', matchId: 'match-1', revision: 0, serverTimeMs: 1792857600000, state: createGame({ players: ['player-1', 'player-2'] }), events: [] });
const command = action => client('game.command', { roomId: 'room-1', matchId: 'match-1', commandId: 'cmd-1', action });
function rejected(result, code = 'invalid-message') {
  assert.equal(result.ok, false, 'Input should have been rejected');
  assert.equal(result.error.code, code);
  assert.equal(typeof result.error.path, 'string');
  assert(result.error.message.length <= 256);
  return result.error;
}
for (const fixture of fixtures.exchanges) {
  test(`P0 exchange: ${fixture.name} (both boundaries)`, () => {
    assert.equal(validateClientMessage(fixture.request).ok, true);
    assert.deepEqual(parseClientMessage(JSON.stringify(fixture.request)), { ok: true, value: fixture.request });
    for (const response of [...fixture.responses, fixture.failure]) {
      assert.deepEqual(validateServerMessage(response), { ok: true, value: response });
      assert.equal(parseServerMessage(JSON.stringify(response)).ok, true);
    }
  });
}
for (const fixture of fixtures.invalid) {
  test(`P0 negative: ${fixture.name}`, () => {
    if (fixture.name === 'duplicate-id') {
      // ID reuse is connection state, not a malformed DTO. S0/P2 owns the registry.
      assert.equal(validateClientMessage(fixture.message).ok, true);
    } else rejected('raw' in fixture ? parseClientMessage(fixture.raw) : validateClientMessage(fixture.message), fixture.response.code);
    assert.equal(validateServerMessage(fixture.response).ok, true);
  });
}
test('P0 finished broadcasts', () => {
  for (const broadcast of fixtures.broadcasts) for (const message of broadcast.messages) assert.equal(validateServerMessage(message).ok, true);
});
test('wrong direction, unknown type and unknown versions are distinct', () => {
  rejected(validateClientMessage(error()), 'unknown-type');
  rejected(validateServerMessage(client('hello', { displayName: 'Host' })), 'unknown-type');
  rejected(validateClientMessage(client('hello', { protocolVersion: 2, displayName: 'Host' })), 'unsupported-version');
  rejected(validateServerMessage(error({ protocolVersion: 2 })), 'unsupported-version');
  const s = snapshot(); s.state.version = 2;
  rejected(validateServerMessage(s), 'unsupported-state-version');
});
test('malformed JSON, primitive roots and nontext frames never throw', () => {
  for (const parse of [parseClientMessage, parseServerMessage]) {
    for (const raw of ['{', '', '[', '{"protocolVersion":1,}', 'NaN', 'undefined']) rejected(parse(raw), 'invalid-json');
    for (const raw of ['null', 'true', '3', '[]', '"hello"']) rejected(parse(raw));
    for (const raw of [null, undefined, 123, new Uint8Array([123, 125])]) rejected(parse(raw));
  }
});
test('request correlation is restricted to valid IDs and never echoes raw data', () => {
  assert.equal(rejected(validateClientMessage(client('cheat')), 'unknown-type').requestId, 'req-1');
  assert.equal(rejected(validateClientMessage(client('hello', { requestId: '<secret>', displayName: 'Host' }))).requestId, null);
  assert.equal(rejected(parseClientMessage('{"secret":"password"'), 'invalid-json').requestId, null);
  const e = rejected(validateClientMessage(client('hello', { displayName: 'password\u0000' })));
  assert(!JSON.stringify(e).includes('password'));
});
test('IDs and display names: whitespace, Unicode, control chars, exact limits', () => {
  assert.equal(validateClientMessage(client('hello', { requestId: 'a'.repeat(64), displayName: '  '+ '🙂'.repeat(32) +'  ' })).ok, true);
  for (const requestId of ['', 'a'.repeat(65), 'a b', 'имя', 1, null]) rejected(validateClientMessage(client('hello', { requestId, displayName: 'Host' })));
  for (const displayName of ['', '   ', '🙂'.repeat(33), 'a\n', '\u007f', null, 1]) rejected(validateClientMessage(client('hello', { displayName })));
  const welcome = structuredClone(fixtures.exchanges[0].responses[0]); welcome.displayName = ' Host ';
  rejected(validateServerMessage(welcome));
});
test('exact fields at every level reject impersonation and unwanted state', () => {
  for (const action of [{ type: 'jump', playerId: 'player-2' }, { type: 'move', direction: 1, admin: true }, { type: 'fire', angleDegrees: 90, power: 1, state: {} }]) rejected(validateClientMessage(command(action)));
  rejected(validateClientMessage({ ...command({ type: 'jump' }), playerId: 'player-2' }));
  rejected(validateClientMessage(client('room.create', { state: snapshot().state })),'message-too-large');
  rejected(validateClientMessage(client('room.create', { terrain: {} })));
  rejected(validateClientMessage(client('hello')));
  const s = snapshot(); s.state.worms[0].position.z = 0;
  rejected(validateServerMessage(s));
});
test('all action range boundaries and numeric type errors', () => {
  for (const direction of [-1, 0, 1]) assert.equal(validateClientMessage(command({ type: 'move', direction })).ok, true);
  for (const direction of [-2, 2, 0.5, '1', null]) rejected(validateClientMessage(command({ type: 'move', direction })));
  for (const angleDegrees of [0, 90.5, 180]) for (const power of [0, 0.5, 1]) assert.equal(validateClientMessage(command({ type: 'fire', angleDegrees, power })).ok, true);
  for (const field of ['angleDegrees', 'power']) for (const value of [-1, Infinity, -Infinity, NaN, '1', null]) rejected(validateClientMessage(command({ type: 'fire', angleDegrees: 90, power: 0.5, [field]: value })));
  rejected(validateClientMessage(command({ type: 'fire', angleDegrees: 180.1, power: 1 })));
  rejected(validateClientMessage(command({ type: 'fire', angleDegrees: 90, power: 1.1 })));
  rejected(validateClientMessage(command({ type: 'teleport' })));
});
test('raw UTF-8 caps include whitespace and are checked before JSON.parse', () => {
  for (const [parse, cap, value] of [[parseClientMessage, LIMITS.maxClientMessageBytes, client('hello', { displayName: 'Владимир🙂' })], [parseServerMessage, LIMITS.maxServerMessageBytes, error({ message: 'Ошибка🙂' })]]) {
    const raw = JSON.stringify(value); const padding = cap - Buffer.byteLength(raw);
    assert.equal(parse(raw + ' '.repeat(padding)).ok, true);
    rejected(parse(raw + ' '.repeat(padding + 1)), 'message-too-large');
    rejected(parse('x'.repeat(cap + 1)), 'message-too-large');
    rejected(parse('🙂'.repeat(Math.floor(cap/4) + 1)), 'message-too-large');
  }
});
test('unknown objects cannot smuggle non-JSON data, accessors or cycles', () => {
  for (const validate of [validateClientMessage, validateServerMessage]) {
    const cycle = {}; cycle.next = cycle;
    const accessor = {}; Object.defineProperty(accessor, 'protocolVersion', { enumerable: true, get() { throw Error('getter executed'); } });
    const values = [cycle, accessor, new Date(), { x: undefined }, { x: () => 1 }, { x: Symbol() }, { x: 1n }, { x: NaN }, { x: Infinity }, { x: new Array(2) }, Object.assign([], { extra: true }), { [Symbol()]: true }];
    for (const value of values) rejected(validate(value));
    const proxy = new Proxy({}, { ownKeys() { throw Error('proxy'); } }); rejected(validate(proxy));
    let deep = {}; for (let i=0;i<17;i++) deep = { nested: deep }; rejected(validate(deep));
  }
});
test('full snapshot schema rejects broken maps, IDs, numbers and phase combinations', () => {
  const mutations = [
    s => { delete s.state.tick; }, s => { s.state.tick = 0.5; }, s => { s.state.tick = Number.MAX_SAFE_INTEGER + 1; },
    s => { s.revision = -1; }, s => { s.serverTimeMs = NaN; }, s => { s.state.phase = 'cheating'; },
    s => { s.state.players[1] = s.state.players[0]; }, s => { s.state.players.push('player-3'); },
    s => { s.state.worms[0].playerId = 'player-3'; }, s => { s.state.worms[1].id = s.state.worms[0].id; },
    s => { s.state.worms[1].playerId = 'player-1'; }, s => { s.state.worms.pop(); },
    s => { s.state.worms[0].health = 1001; }, s => { s.state.worms[0].grounded = 1; },
    s => { s.state.worms[0].position.x = 1000001; }, s => { s.state.worms[0].velocity.y = Infinity; },
    s => { s.state.terrain.cells.pop(); }, s => { s.state.terrain.cells[42] = 2; },
    s => { s.state.terrain.width = 321; }, s => { s.state.terrain.height = 31; }, s => { s.state.terrain.width = 32.5; },
    s => { s.state.turnTicksRemaining = 3601; }, s => { s.state.turnDurationTicks = 59; },
    s => { s.state.activePlayerIndex = 2; }, s => { s.state.wind = 30.1; }, s => { s.state.turnNumber = 0; },
    s => { s.state.winnerId = 'player-3'; }, s => { s.state.phase = 'finished'; },
    s => { s.state.pendingTurnEnd = 'shot'; }, s => { s.state.movementDirection = 1; },
    s => { s.state.phase = 'active'; }, s => { s.state.resolvingTicks = 1; },
    s => { s.state.projectile = { position: {x:0,y:0},velocity:{x:1,y:1},ageTicks:0,shooterExited:false }; },
  ];
  for (const mutate of mutations) { const s=snapshot(); mutate(s); rejected(validateServerMessage(s)); }
});
test('projectile payload and resolving phase are fully validated', () => {
  const s = snapshot();
  s.state = dispatch(dispatch(s.state, { type:'start-turn',playerId:'player-1' }).state,{type:'fire',playerId:'player-1',angleDegrees:90,power:0}).state;
  assert.equal(validateServerMessage(s).ok,true);
  for(const mutate of [s=>{s.state.projectile.shooterExited=0;},s=>{delete s.state.projectile.ageTicks;},s=>{s.state.projectile.ageTicks=-1;},s=>{s.state.projectile.velocity.x=NaN;},s=>{s.state.pendingTurnEnd=null;}]) {const copy=structuredClone(s);mutate(copy);rejected(validateServerMessage(copy));}
});
test('snapshot context verifies room, match and player seat order', () => {
  const s=snapshot(), room=structuredClone(fixtures.exchanges.find(e=>e.name==='start').responses[1].room);
  assert.equal(validateServerMessage(s,{room}).ok,true);
  for(const mutate of [r=>{r.roomId='other';},r=>{r.matchId='other';},r=>{r.players.reverse();}]){const r=structuredClone(room);mutate(r);rejected(validateServerMessage(s,{room:r}));}
  assert.equal(parseServerMessage(JSON.stringify(s),{room}).ok,true);
});
test('events cover all core variants, reject corrupt fields and cross references', () => {
  const events=[
    {type:'turn-started',playerId:'player-1',turnNumber:1},{type:'turn-ready',playerId:'player-2',turnNumber:2},
    {type:'shot-fired',playerId:'player-1',position:{x:1,y:2}}, {type:'explosion',position:{x:1,y:2},radius:24,removedCells:10},
    {type:'damage',wormId:'worm-1',amount:10,cause:'fall'}, {type:'knockback',wormId:'worm-1',velocity:{x:10,y:-10}},
    {type:'worm-landed',wormId:'worm-1',impactSpeed:50}, {type:'resolution-limit',ticks:1800},
    {type:'worm-died',wormId:'worm-1'}, {type:'turn-ended',playerId:'player-1',reason:'shot'},
  ];
  const s=snapshot();s.events=events;assert.equal(validateServerMessage(s).ok,true);
  for(const e of events){const missing=structuredClone(e);delete missing[Object.keys(e).at(-1)];rejected(validateServerMessage({...s,events:[missing]}));rejected(validateServerMessage({...s,events:[{...e,extra:true}]}));}
  for(const e of [{type:'worm-died',wormId:'other'},{type:'turn-ended',playerId:'other',reason:'shot'},{type:'damage',wormId:'worm-1',amount:1,cause:'other'},{type:'game-finished',winnerId:'player-1'},{type:'unknown'}]) rejected(validateServerMessage({...s,events:[e]}));
  assert.equal(validateServerMessage({...s,events:Array(128).fill(events[0])}).ok,true);
  rejected(validateServerMessage({...s,events:Array(129).fill(events[0])}));
  rejected(validateServerMessage({...s,type:'game.snapshot',requestId:'snap-1'}));
});
test('room membership, host, readiness and match lifecycle invariants', () => {
  const message=structuredClone(fixtures.exchanges.find(e=>e.name==='join').responses[1]);
  for(const mutate of [r=>{r.players[1].playerId=r.players[0].playerId;},r=>{r.hostPlayerId='other';},r=>{r.players=[];},r=>{r.players[0].connected=false;},r=>{r.roomRevision=0;},r=>{r.matchId='match-1';},r=>{r.status='playing';},r=>{r.players[0].displayName='  ';}]) {const m=structuredClone(message);mutate(m.room);rejected(validateServerMessage(m));}
});
test('results distinguish format errors, domain refusals and command acceptance', () => {
  const ack={protocolVersion:1,type:'command.result',requestId:'req-1',commandId:'cmd-1',matchId:'match-1',accepted:true,revision:1};
  assert.equal(validateServerMessage(ack).ok,true);
  for(const rejection of ['game-finished','wrong-player','wrong-phase','invalid-action']) assert.equal(validateServerMessage({...ack,accepted:false,rejection}).ok,true);
  for(const rejection of ['not-in-room','match-not-found','match-mismatch']) assert.equal(validateServerMessage({...ack,accepted:false,revision:null,rejection}).ok,true);
  for(const bad of [{...ack,revision:null},{...ack,rejection:'wrong-player'},{...ack,accepted:false},{...ack,accepted:false,rejection:'match-mismatch'},{...ack,accepted:false,revision:null,rejection:'wrong-phase'}]) rejected(validateServerMessage(bad));
  rejected(validateServerMessage({protocolVersion:1,type:'result',requestId:'r',requestType:'room.start',ok:true,matchId:'m',revision:1}));
  rejected(validateServerMessage({protocolVersion:1,type:'result',requestId:'r',requestType:'room.create',ok:false,code:'not-host'}));
  rejected(validateServerMessage({protocolVersion:1,type:'result',requestId:'r',requestType:'game.snapshot',ok:true}));
  rejected(validateServerMessage(error({code:'wrong-player'})));
  rejected(validateServerMessage(error({message:'🙂'.repeat(257)})));
});
test('welcome caps cannot extend client hard limits or omit fields', () => {
  const m=structuredClone(fixtures.exchanges[0].responses[0]);
  m.limits.maxMapWidth=2048;rejected(validateServerMessage(m));
  m.limits.maxMapWidth=320;delete m.limits.tickHz;rejected(validateServerMessage(m));
  assert(Object.isFrozen(LIMITS));
});
test('genuine core transitions validate throughout movement, timeout, projectile and finish', () => {
  let state=createGame({players:['player-1','player-2']});let revision=0;
  const accept=(transition)=>{state=transition.state;const message={...snapshot(),state,revision:revision++,events:transition.events};const validation=validateServerMessage(message);assert.equal(validation.ok,true,JSON.stringify(validation));};
  for(let turn=0;turn<10&&state.phase!=='finished';turn++){
    const playerId=state.players[state.activePlayerIndex];
    accept(dispatch(state,{type:'start-turn',playerId}));
    accept(dispatch(state,{type:'move',playerId,direction:1}));accept(step(state));
    accept(dispatch(state,{type:'move',playerId,direction:0}));
    accept(dispatch(state,{type:'jump',playerId}));
    accept(dispatch(state,{type:'fire',playerId,angleDegrees:90,power:0}));
    for(let tick=0;state.phase==='resolving'&&tick<2000;tick++)accept(step(state));
  }
  assert.equal(state.phase,'finished');
  state=createGame({players:['player-1','player-2'],turnDurationSeconds:1});
  accept(dispatch(state,{type:'start-turn',playerId:'player-1'}));
  for(let tick=0;tick<60;tick++)accept(step(state));
  assert.equal(state.phase,'waiting');
});
test('arbitrary deterministic JSON never escapes either validator', () => {
  let seed=12345;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
  const value=depth=>{const n=Math.floor(random()*(depth?7:5));if(n===0)return null;if(n===1)return random()*100;if(n===2)return random()<0.5;if(n===3)return '🙂'+random();if(n===4)return {};if(n===5)return [value(depth-1),value(depth-1)];return {protocolVersion:1,type:random()<0.5?'hello':'error',requestId:'r',nested:value(depth-1)};};
  for(let i=0;i<250;i++){const v=value(4);for(const validate of [validateClientMessage,validateServerMessage])assert.equal(typeof validate(v).ok,'boolean');for(const parse of [parseClientMessage,parseServerMessage])assert.equal(typeof parse(JSON.stringify(v)).ok,'boolean');}
});
