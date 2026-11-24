import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, dispatch, step } from '../../game-core/dist/index.js';
import { LIMITS } from '#protocol';
import { RoomConnection, websocketAddress } from '../dist/connection.js';
import { GameplayControls } from '../dist/controls.js';
import { RemoteSession } from '../dist/remote-session.js';

class Socket extends EventTarget {
  readyState = 0;
  sent = [];
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; }
  server(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ protocolVersion: 2, ...message }) })); }
  get last() { return this.sent.at(-1); }
  respond(message, request = this.last) { this.server({ requestId: request.requestId, ...message }); }
}

const players = [
  { playerId: 'host', displayName: 'Host', ready: false, connected: true },
  { playerId: 'guest', displayName: 'Guest', ready: false, connected: true },
];
const options = { players: ['host', 'guest'], turnDurationSeconds: 10 };
const initial = createGame(options);
const turnStarted = dispatch(initial, { type: 'start-turn', playerId: 'host' });
const hostActive = turnStarted.state;
const waitingGuest = dispatch(hostActive, { type: 'end-turn', playerId: 'host' }).state;
const resumeToken = 's'.repeat(43);
const room = (roomId, revision, matchId = null) => ({
  roomId, roomRevision: revision, hostPlayerId: 'host', status: matchId ? 'playing' : 'lobby', matchId, players,
});
function fixture(t, playerId = 'host', timeout = 500) {
  const sockets = [];
  const connection = new RoomConnection(() => {
    const socket = new Socket();
    sockets.push(socket);
    return socket;
  }, 'Player', { timeout });
  const [socket] = sockets;
  t.after(() => connection.disconnect());
  socket.open();
  assert.equal(socket.last.type, 'hello');
  socket.respond({ type: 'welcome', connectionId: 'connection', playerId, displayName: 'Player', serverTimeMs: 100, limits: LIMITS });
  assert.equal(connection.status, 'ready');
  return { socket, sockets, connection };
}
async function enter({ socket, connection }, roomId = 'first', matchId = 'match', state = initial) {
  const join = connection.lobby({ type: 'room.join', roomId });
  socket.respond({ type: 'result', requestType: 'room.join', ok: true, room: room(roomId, 1), resumeToken });
  assert.equal((await join).ok, true);
  socket.server({ type: 'room.state', room: room(roomId, 2, matchId) });
  const snapshot = { roomId, matchId, revision: 0, updateSequence: 0, serverTimeMs: 100, state, events: [] };
  socket.server({ type: 'game.update', ...snapshot });
  return { match: connection.match, snapshot };
}
function ack(socket, revision, request = socket.last) {
  socket.respond({ type: 'command.result', commandId: request.commandId, matchId: request.matchId,
    accepted: true, revision }, request);
}

test('WebSocket addresses accept only the configured game endpoint', () => {
  assert.equal(websocketAddress(' ws://localhost:4180 '), 'ws://localhost:4180/ws');
  assert.equal(websocketAddress('wss://games.example/ws'), 'wss://games.example/ws');
  for (const bad of ['http://localhost:4180/ws', 'ws://user@localhost/ws', 'ws://localhost/elsewhere', 'ws://localhost/ws?a=b']) {
    assert.throws(() => websocketAddress(bad));
  }
});

test('network controls depend on server-assigned identity and only snapshots update state', async t => {
  const f = fixture(t, 'guest');
  const { match, snapshot } = await enter(f);
  const events = [];
  match.subscribe(update => events.push(...update.events));
  const before = f.socket.sent.length;
  assert.deepEqual(await match.command({ type: 'start-turn' }), { kind: 'skipped' });
  assert.equal(f.socket.sent.length, before);
  f.socket.server({ type: 'game.update', ...snapshot, matchId: 'old', revision: 100, state: waitingGuest });
  assert.equal(match.canControl, false);
  f.socket.server({ type: 'game.update', ...snapshot, revision: 2, updateSequence: 1, state: waitingGuest });
  assert.equal(match.canControl, true);
  const started = match.command({ type: 'start-turn' });
  assert.deepEqual(f.socket.last.action, { type: 'start-turn' });
  const request = f.socket.last;
  assert.deepEqual(await match.command({ type: 'start-turn' }), { kind: 'skipped' });
  f.socket.respond({ type: 'error', code: 'duplicate-id', message: 'duplicate-id' }, request);
  assert.equal(match.canCommand('start-turn'), false);
  ack(f.socket, 3, request);
  assert.deepEqual(await started, { kind: 'accepted' });
  assert.equal(match.state.phase, 'waiting');
  assert.equal(match.canCommand('start-turn'), false);
  const guestState = dispatch(waitingGuest, { type: 'start-turn', playerId: 'guest' });
  const update = { type: 'game.update', ...snapshot, revision: 3, updateSequence: 2, state: guestState.state, events: guestState.events };
  f.socket.server(update);
  f.socket.server(update);
  f.socket.server({ type: 'game.update', ...snapshot, revision: 1 });
  assert.equal(match.state.phase, 'active');
  assert.deepEqual(events, guestState.events);
});

test('moves allow two requests in flight and blur coalesces queued input to a stop', async t => {
  const f = fixture(t);
  const { match } = await enter(f, 'first', 'match', hostActive);
  const controls = new GameplayControls(match);
  match.subscribe(update => controls.accept(update));
  const before = f.socket.sent.length;
  controls.press('KeyD');
  controls.press('KeyA');
  controls.release('KeyA');
  controls.releaseAll();
  let moves = f.socket.sent.slice(before);
  assert.deepEqual(moves.map(request => request.action.direction), [1, -1]);
  assert.equal(match.state.movementDirection, 0);
  ack(f.socket, 1, moves[0]);
  await Promise.resolve();
  moves = f.socket.sent.slice(before);
  assert.deepEqual(moves.map(request => request.action.direction), [1, -1, 0]);
  ack(f.socket, 2, moves[1]);
  ack(f.socket, 3, moves[2]);
});

test('timed out fire is never resent and a fresh snapshot clears the pending guard', async t => {
  const f = fixture(t, 'host', 40);
  const { match, snapshot } = await enter(f, 'first', 'match', hostActive);
  const action = { type: 'fire', angleDegrees: 90, power: 0 };
  const fired = match.command(action);
  assert.equal(match.canCommand('fire'), false);
  assert.deepEqual(await fired, { kind: 'unknown' });
  assert.equal(match.canCommand('fire'), false);
  assert.equal(f.socket.last.type, 'game.snapshot');
  assert.deepEqual(await match.command(action), { kind: 'skipped' });
  const next = step(hostActive).state;
  f.socket.respond({ type: 'game.snapshot', ...snapshot, revision: 1, state: next });
  await Promise.resolve();
  assert.equal(match.canCommand('fire'), true);
  assert.equal(match.state.tick, 1);
  assert.equal(f.socket.sent.filter(request => request.type === 'game.command').length, 1);
});

test('a timeout during snapshot recovery triggers a follow-up and keeps the second command locked', async () => {
  const snapshot = { roomId: 'first', matchId: 'match', revision: 0, updateSequence: 0, serverTimeMs: 100, state: hostActive, events: [] };
  const requests = [];
  const match = new RemoteSession('host', { type: 'game.update', ...snapshot }, request =>
    new Promise(resolve => requests.push({ request, resolve })));
  const fired = match.command({ type: 'fire', angleDegrees: 90, power: 0 });
  requests[0].resolve({ type: 'unknown' });
  assert.equal((await fired).kind, 'unknown');
  const refreshed = match.refresh();
  assert.equal(requests[1].request.type, 'game.snapshot');

  const jumped = match.command({ type: 'jump' });
  requests[2].resolve({ type: 'unknown' });
  assert.equal((await jumped).kind, 'unknown');
  assert.equal(requests.length, 3);

  const reply = { type: 'game.snapshot', ...snapshot };
  requests[1].resolve(reply);
  await Promise.resolve();
  assert.equal(match.canCommand('fire'), true);
  assert.equal(match.canCommand('jump'), false);
  assert.equal(requests[3].request.type, 'game.snapshot');
  requests[3].resolve(reply);
  assert.equal(await refreshed, true);
  assert.equal(match.canCommand('jump'), true);
  assert.equal(requests.length, 4);
});

test('a snapshot can replace terrain and a later broadcast of the same revision delivers its events once', async t => {
  const f = fixture(t);
  const { match, snapshot } = await enter(f, 'first', 'match', hostActive);
  const updates = [];
  match.subscribe(update => updates.push(update));
  const altered = structuredClone(hostActive);
  altered.terrain.cells[altered.terrain.cells.length - 1] = 0;
  const refreshing = match.refresh();
  f.socket.respond({ type: 'game.snapshot', ...snapshot, state: altered, revision: 1 });
  assert(await refreshing);
  assert(updates.some(update => update.terrainChanged));
  assert.equal(match.state.terrain.cells.at(-1), 0);
  const update = { type: 'game.update', ...snapshot, state: altered, revision: 1, updateSequence: 1,
    events: [{ type: 'explosion', position: { x: 20, y: 112 }, radius: 24, removedCells: 1 }] };
  f.socket.server(update);
  f.socket.server(update);
  assert.deepEqual(updates.flatMap(entry => entry.events), update.events);
});

test('closed matches clear the seat and reconnecting restores the same session without resending a pending action', async t => {
  const f = fixture(t);
  const first = await enter(f);
  const begun = first.match.command({ type: 'start-turn' });
  const firstId = f.socket.last.commandId;
  ack(f.socket, 1);
  assert.equal((await begun).kind, 'accepted');
  f.socket.server({ type: 'room.closed', roomId: 'first', matchId: 'match', reason: 'player-left' });
  assert.equal(f.connection.match, undefined);
  assert.equal(f.connection.resumeToken, undefined);
  const second = await enter(f, 'second', 'match-2');
  const pending = second.match.command({ type: 'start-turn' });
  assert.notEqual(f.socket.last.commandId, firstId);
  f.socket.dispatchEvent(new Event('close'));
  assert.equal((await pending).kind, 'unknown');
  assert.equal(f.connection.status, 'reconnecting');
  assert.equal(f.connection.match, second.match);
  assert.equal(second.match.canControl, false);
  assert.match(f.connection.notice, /Результат/);

  f.connection.resync();
  const resumedSocket = f.sockets.at(-1);
  resumedSocket.open();
  assert.equal(resumedSocket.last.resumeToken, resumeToken);
  resumedSocket.respond({ type: 'welcome', connectionId: 'new-connection', playerId: 'host', displayName: 'Host',
    serverTimeMs: 101, limits: LIMITS, resumed: { room: room('second', 4, 'match-2'),
      snapshot: { ...second.snapshot, revision: 2, updateSequence: 1, state: step(hostActive).state } } });
  assert.equal(f.connection.status, 'ready');
  assert.equal(f.connection.match, second.match);
  assert.equal(second.match.state.tick, 1);
  assert.equal(second.match.canCommand('fire'), true);
  assert.deepEqual(resumedSocket.sent.map(request => request.type), ['hello']);

  const fired = second.match.command({ type: 'fire', angleDegrees: 90, power: 0 });
  assert.notEqual(resumedSocket.last.commandId, f.socket.last.commandId);
  ack(resumedSocket, 3);
  assert.equal((await fired).kind, 'accepted');
});

test('a gap requests a fresh snapshot without replaying repeated or late events', async t => {
  const f = fixture(t);
  const { match, snapshot } = await enter(f);
  const updates = [];
  match.subscribe(update => updates.push(update));
  const event = { type: 'turn-ready', playerId: 'guest', turnNumber: 2 };
  const current = { ...snapshot, state: waitingGuest, revision: 12, updateSequence: 3 };
  const latest = { type: 'game.update', ...current, events: [event] };
  f.socket.server(latest);
  f.socket.server(latest);
  f.socket.server({ ...latest, revision: 6, updateSequence: 2 });
  assert.equal(f.socket.last.type, 'game.snapshot');
  f.socket.respond({ type: 'game.snapshot', ...current });
  assert.equal(await match.refresh(), true);
  assert.equal(match.state.players[match.state.activePlayerIndex], 'guest');
  assert(updates.some(update => update.resynced));
  assert.deepEqual(updates.flatMap(update => update.events), [event]);
});

test('automatic attempts stop when the server has released the seat', async t => {
  const sockets = [];
  const connection = new RoomConnection(() => {
    const socket = new Socket();
    sockets.push(socket);
    return socket;
  }, 'Host', { resumeToken, retryDelay: 1 });
  t.after(() => connection.disconnect());
  const [first] = sockets;
  assert.equal(connection.status, 'reconnecting');
  first.open();
  first.respond({ type: 'error', code: 'resume-in-use', message: 'resume-in-use' });
  await new Promise(resolve => setTimeout(resolve, 10));
  const next = sockets.at(-1);
  assert.notEqual(first, next);
  next.open();
  next.respond({ type: 'error', code: 'resume-unavailable', message: 'resume-unavailable' });
  await Promise.resolve();
  assert.equal(connection.status, 'disconnected');
  assert.equal(connection.resumeToken, undefined);
  assert.match(connection.notice, /недоступно/);
});
