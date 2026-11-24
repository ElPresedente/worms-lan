import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, dispatch } from '../../game-core/dist/index.js';
import { LIMITS, PROTOCOL_VERSION } from '../../protocol/dist/index.js';
import { isHostMessage, isViewMessage } from '../../client/dist/webview-bridge.js';
import { WebviewHost } from '../dist/host.js';

class Socket extends EventTarget {
  readyState = 0;
  sent = [];
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = 3; }
  send(text) { this.sent.push(JSON.parse(text)); }
  server(message) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message }) }));
  }
  respond(message, request = this.sent.at(-1)) {
    this.server({ requestId: request.requestId, ...message });
  }
}

test('the webview can send only the supported requests without an address, token or player override', () => {
  const message = request => isViewMessage({ viewId: 'editor', request });
  assert.equal(message({ type: 'connect', id: 1, name: 'Player' }), true);
  assert.equal(message({ type: 'connect', id: 1, name: 'Player', address: 'ws://example.com' }), false);
  assert.equal(message({ type: 'connect', id: 1, resumeToken: 's'.repeat(43) }), false);
  assert.equal(message({ type: 'lobby', id: 2, request: { type: 'room.join', roomId: 'public' } }), true);
  assert.equal(message({ type: 'lobby', id: 2, request: { type: 'hello', displayName: 'Player' } }), false);
  assert.equal(message({ type: 'command', id: 3, matchId: 'match', turn: 1, action: { type: 'fire', angleDegrees: 25, power: 0.3 } }), true);
  assert.equal(message({ type: 'command', id: 3, matchId: 'match', turn: 1, action: { type: 'move', direction: 4 } }), false);
  assert.equal(message({ type: 'command', id: 3, matchId: 'match', turn: 1, action: { type: 'jump', playerId: 'opponent' } }), false);
});

test('closing or hiding the panel keeps the match current, releases movement and keeps the seat private', async t => {
  const original = globalThis.WebSocket;
  const socket = new Socket();
  globalThis.WebSocket = class { constructor() { return socket; } };
  t.after(() => { globalThis.WebSocket = original; });
  const saved = [];
  const host = new WebviewHost('ws://127.0.0.1:4180/', undefined, async seat => { saved.push(seat); });
  t.after(() => host.dispose());
  const frames = [];
  const send = message => { assert.equal(isHostMessage(message), true); frames.push(message); };
  const receive = (request, viewId = 'first') => host.receive({ viewId, request });
  host.setView(send, true);
  await receive({ type: 'attach' });
  assert.equal(frames.at(-1).state.address, 'ws://127.0.0.1:4180/ws');
  await receive({ type: 'connect', id: 1, name: 'Editor' });
  socket.open();
  socket.respond({ type: 'welcome', connectionId: 'connection', playerId: 'editor', displayName: 'Editor', serverTimeMs: 0, limits: LIMITS });

  const players = [
    { playerId: 'editor', displayName: 'Editor', ready: false, connected: true },
    { playerId: 'peer', displayName: 'Peer', ready: false, connected: true },
  ];
  const room = { roomId: 'room', roomRevision: 1, hostPlayerId: 'editor', status: 'lobby', matchId: null, players };
  const joining = receive({ type: 'lobby', id: 2, request: { type: 'room.join', roomId: 'room' } });
  const token = 's'.repeat(43);
  socket.respond({ type: 'result', requestType: 'room.join', ok: true, room, resumeToken: token });
  await joining;
  assert.equal(JSON.parse(saved.at(-1)).token, token);
  assert.equal(JSON.stringify(frames).includes(token), false);
  assert.equal(isHostMessage({ ...frames.at(-1), resumeToken: token }), false);
  socket.server({ type: 'room.state', room: { ...room, roomRevision: 2, status: 'playing', matchId: 'match' } });
  const waiting = createGame({ players: ['editor', 'peer'] });
  const started = dispatch(waiting, { type: 'start-turn', playerId: 'editor' });
  const snapshot = { type: 'game.update', roomId: 'room', matchId: 'match', revision: 0, updateSequence: 0, serverTimeMs: 0, state: started.state, events: [] };
  socket.server(snapshot);

  const move = { type: 'command', id: 3, matchId: 'match', turn: 2, action: { type: 'move', direction: 1 } };
  const calls = socket.sent.length;
  await receive(move);
  assert.equal(socket.sent.length, calls);
  assert.deepEqual(frames.at(-1).reply.outcome, { kind: 'skipped' });
  const moving = receive({ ...move, id: 4, turn: 1 });
  const firstMove = socket.sent.at(-1);
  assert.equal(firstMove.action.direction, 1);
  host.setVisible(false);
  const stop = socket.sent.at(-1);
  assert.equal(stop.action.direction, 0);
  for (const request of [firstMove, stop]) {
    socket.respond({ type: 'command.result', matchId: 'match', commandId: request.commandId, accepted: true, revision: 1 }, request);
  }
  await moving;

  const hiddenFrames = frames.length;
  const finishedTurn = dispatch(started.state, { type: 'end-turn', playerId: 'editor' });
  socket.server({ ...snapshot, revision: 1, updateSequence: 1, state: finishedTurn.state, events: finishedTurn.events });
  assert.equal(socket.readyState, 1);
  assert.equal(frames.length, hiddenFrames);
  host.setVisible(true);
  assert.equal(frames.at(-1).state.match.terrainChanged, true);
  assert.equal(frames.at(-1).state.match.state.turnNumber, 2);

  host.setView();
  host.setView(send, true);
  await receive({ type: 'attach' }, 'second');
  assert.equal(frames.at(-1).viewId, 'second');
  assert.equal(frames.at(-1).state.match.state.turnNumber, 2);
  const afterReopen = socket.sent.length;
  await receive({ type: 'lobby', id: 5, request: { type: 'room.leave', roomId: 'room' } });
  assert.equal(socket.sent.length, afterReopen);
});
