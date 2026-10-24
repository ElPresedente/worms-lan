/** Fixed protocol v1 caps, shared by producers and validators. No platform APIs. */
export const PROTOCOL_VERSION = 1;
export const STATE_VERSION = 1;
export const LIMITS = Object.freeze({
  maxClientMessageBytes: 4096,
  maxServerMessageBytes: 262144,
  maxOutgoingQueueBytes: 1048576,
  maxIdLength: 64,
  maxDisplayNameLength: 32,
  maxPlayersPerRoom: 2,
  maxRooms: 32,
  maxConnections: 64,
  maxRequestsPerConnection: 100000,
  maxMapWidth: 320,
  maxMapHeight: 180,
  maxMapCells: 57600,
  maxEventsPerUpdate: 128,
  maxMessageDepth: 16,
  clientMessagesPerSecond: 30,
  clientMessageBurst: 60,
  snapshotRequestsPerSecond: 1,
  snapshotRequestBurst: 2,
  snapshotHz: 10,
  tickHz: 60,
  handshakeTimeoutMs: 5000,
  requestTimeoutMs: 5000,
} as const);
export const PROTOCOL_ERROR_CODES = [
  'invalid-json', 'invalid-message', 'unknown-type', 'unsupported-state-version',
  'unsupported-version', 'handshake-required', 'already-initialized', 'duplicate-id',
  'message-too-large', 'rate-limited', 'resource-limit', 'not-implemented', 'internal-error',
] as const;
export const ADDRESS_REJECTIONS = ['not-in-room', 'match-not-found', 'match-mismatch'] as const;
export const CORE_REJECTIONS = ['game-finished', 'wrong-player', 'wrong-phase', 'invalid-action'] as const;
/** Domain rejections are scoped to their request, not interchangeable protocol errors. */
export const REQUEST_REJECTIONS = {
  'room.create': ['already-in-room', 'resource-limit'],
  'room.join': ['room-not-found', 'room-full', 'room-not-joinable', 'already-in-room'],
  'room.leave': ['not-in-room'],
  'room.ready': ['not-in-room', 'room-not-in-lobby'],
  'room.start': ['not-in-room', 'not-host', 'room-not-in-lobby', 'players-not-ready'],
  'game.snapshot': ADDRESS_REJECTIONS,
} as const;
