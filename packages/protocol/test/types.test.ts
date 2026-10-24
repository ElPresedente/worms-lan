import { LIMITS, parseClientMessage, parseServerMessage } from '../dist/index.js';
import type { ClientMessage, ServerMessage, NetworkAction } from '../dist/index.js';

const valid: ClientMessage = { protocolVersion: 1, type: 'game.command', requestId: 'r', roomId: 'room', matchId: 'match', commandId: 'cmd', action: { type: 'fire', angleDegrees: 90, power: 0.5 } };
void valid;
// @ts-expect-error Identity belongs to the server, not a network action.
const spoof: NetworkAction = { type: 'jump', playerId: 'other' };
// @ts-expect-error Incomplete payload cannot be sent.
const missing: ClientMessage = { protocolVersion: 1, type: 'room.join', requestId: 'r' };
// @ts-expect-error A success cannot carry a domain refusal.
const invalidAck: ServerMessage = { protocolVersion: 1, type: 'command.result', requestId: 'r', commandId: 'cmd', matchId: 'match', accepted: true, revision: 1, rejection: 'wrong-player' };
// @ts-expect-error Address refusals do not assert a revision of a different match.
const invalidRevision: ServerMessage = { protocolVersion: 1, type: 'command.result', requestId: 'r', commandId: 'cmd', matchId: 'match', accepted: false, revision: 1, rejection: 'match-mismatch' };
// @ts-expect-error A protocol error is not a game rejection.
const wrongCode: ServerMessage = { protocolVersion: 1, type: 'error', requestId: null, code: 'wrong-player', message: 'x' };
void [spoof, missing, invalidAck, invalidRevision, wrongCode];
// @ts-expect-error Limits are immutable.
LIMITS.tickHz = 30;
const input: unknown = null;
const client = parseClientMessage(input);
if (client.ok && client.value.type === 'game.command') {
  const action: NetworkAction = client.value.action;
  void action;
  // @ts-expect-error Validated network actions still carry no identity.
  void action.playerId;
} else if (!client.ok) {
  const code: string = client.error.code;
  void code;
}
const server = parseServerMessage(input);
if (server.ok && server.value.type === 'command.result') {
  const result = server.value;
  if (result.accepted) {
    const revision: number = result.revision;
    void revision;
    // @ts-expect-error Accepted result has no rejection.
    void result.rejection;
  } else if (result.revision === null) {
    const code: 'not-in-room' | 'match-not-found' | 'match-mismatch' = result.rejection;
    void code;
  }
}
