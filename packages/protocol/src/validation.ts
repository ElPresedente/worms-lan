import { LIMITS, PROTOCOL_VERSION, STATE_VERSION, PROTOCOL_ERROR_CODES, ADDRESS_REJECTIONS, CORE_REJECTIONS, REQUEST_REJECTIONS } from './constants.js';
import type { ClientMessage, ServerMessage, ValidationResult, ValidationError, ProtocolErrorCode, ValidationContext } from './types.js';
import type { GameState, GameEvent } from '@office-worms/game-core';

type Check = (value: unknown, path: string) => void;
type RecordValue = Record<string, unknown>;
class Invalid extends Error {
  constructor(readonly code: ProtocolErrorCode, readonly path: string, message: string) { super(message); }
}
function fail(path: string, message = 'Invalid message', code: ProtocolErrorCode = 'invalid-message'): never {
  throw new Invalid(code, path, message);
}
const record = (v: unknown, p: string): RecordValue => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(p, 'Expected object');
  return v as RecordValue;
};
const exact = (fields: Record<string, Check>): Check => (v, p) => {
  const o = record(v, p), keys = Object.keys(o);
  if (keys.length !== Object.keys(fields).length || keys.some(k => !Object.hasOwn(fields, k))) fail(p, 'Unexpected or missing fields');
  for (const [key, check] of Object.entries(fields)) {
    if (!Object.hasOwn(o, key)) fail(p, 'Missing field');
    check(o[key], `${p}.${key}`);
  }
};
const literal = (expected: string | number | boolean | null): Check => (v, p) => { if (v !== expected) fail(p, 'Unexpected value'); };
const oneOf = (values: readonly unknown[]): Check => (v, p) => { if (!values.includes(v)) fail(p, 'Unexpected enum value'); };
const bool: Check = (v, p) => { if (typeof v !== 'boolean') fail(p, 'Expected boolean'); };
const number = (min: number, max: number, integer = false): Check => (v, p) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isSafeInteger(v))) fail(p, 'Number outside allowed range');
};
const uint = number(0, Number.MAX_SAFE_INTEGER, true);
const positive = number(1, Number.MAX_SAFE_INTEGER, true);
const id: Check = (v, p) => { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) fail(p, 'Invalid ID'); };
const nullable = (check: Check): Check => (v, p) => { if (v !== null) check(v, p); };
const array = (check: Check, min: number, max: number): Check => (v, p) => {
  if (!Array.isArray(v) || v.length < min || v.length > max) fail(p, 'Array outside allowed length');
  for (let i = 0; i < v.length; i++) check(v[i], `${p}[${i}]`);
};
const displayName = (normalized: boolean): Check => (v, p) => {
  if (typeof v !== 'string') fail(p, 'Expected display name');
  const name = v.trim(), length = [...name].length;
  if (length < 1 || length > LIMITS.maxDisplayNameLength || /[\u0000-\u001f\u007f]/.test(v) || (normalized && v !== name)) fail(p, 'Invalid display name');
};
const vector = exact({ x: number(-1000000, 1000000), y: number(-1000000, 1000000) });
const reason = oneOf(['shot', 'timeout', 'pass']);
const terrain: Check = (v, p) => {
  exact({ width: number(32, LIMITS.maxMapWidth, true), height: number(32, LIMITS.maxMapHeight, true), cells: array(oneOf([0, 1]), 1024, LIMITS.maxMapCells) })(v, p);
  const o = v as { width: number; height: number; cells: number[] };
  if (o.cells.length !== o.width * o.height) fail(`${p}.cells`, 'Bitmap dimensions do not match cells');
};
const worm = exact({ id, playerId: id, position: vector, velocity: vector, health: number(0, 1000, true), grounded: bool });
const projectile = exact({ position: vector, velocity: vector, ageTicks: uint, shooterExited: bool });
const state: Check = (v, p) => {
  const o = record(v, p);
  if (o.version !== STATE_VERSION) fail(`${p}.version`, 'Unsupported state version', 'unsupported-state-version');
  exact({ version: literal(STATE_VERSION), tick: uint, phase: oneOf(['waiting', 'active', 'resolving', 'finished']),
    players: array(id, 2, 2), terrain, worms: array(worm, 2, 2), activePlayerIndex: number(0, 1, true),
    turnNumber: positive, turnTicksRemaining: uint, turnDurationTicks: number(60, 18000, true), wind: number(-30, 30),
    projectile: nullable(projectile), movementDirection: oneOf([-1, 0, 1]), pendingTurnEnd: nullable(reason),
    resolvingTicks: uint, winnerId: nullable(id),
  })(v, p);
  const s = v as GameState;
  if (s.players[0] === s.players[1]) fail(`${p}.players`, 'Players must be distinct');
  if (new Set(s.worms.map(w => w.id)).size !== 2 || s.players.some(player => s.worms.filter(w => w.playerId === player).length !== 1)) fail(`${p}.worms`, 'Expected one distinct worm per player');
  if (s.turnTicksRemaining > s.turnDurationTicks) fail(`${p}.turnTicksRemaining`, 'Timer exceeds duration');
  if (s.winnerId !== null && !s.players.includes(s.winnerId)) fail(`${p}.winnerId`, 'Unknown winner');
  if (s.phase !== 'finished' && s.winnerId !== null) fail(`${p}.winnerId`, 'Winner before match finished');
  if (s.phase === 'active') {
    if (s.turnTicksRemaining === 0 || s.pendingTurnEnd !== null || s.projectile !== null || s.resolvingTicks !== 0) fail(p, 'Inconsistent active state');
  } else if (s.turnTicksRemaining !== 0 || s.movementDirection !== 0) fail(p, 'Inactive turn has timer or input');
  if (s.phase === 'resolving') {
    if (s.pendingTurnEnd === null || (s.projectile !== null && s.pendingTurnEnd !== 'shot')) fail(p, 'Inconsistent resolving state');
  } else if (s.pendingTurnEnd !== null || s.projectile !== null || s.resolvingTicks !== 0) fail(p, 'Unexpected resolving fields');
  const alive = s.worms.filter(w => w.health > 0).map(w => w.playerId);
  if (s.phase === 'finished' && (alive.length > 1 || s.winnerId !== (alive[0] ?? null))) fail(p, 'Winner does not match surviving players');
  if (s.phase === 'waiting' && alive.length !== 2) fail(p, 'Waiting match needs two living players');
};
const room: Check = (v, p) => {
  exact({ roomId: id, roomRevision: positive, hostPlayerId: id, status: oneOf(['lobby', 'playing', 'finished']),
    players: array(exact({ playerId: id, displayName: displayName(true), ready: bool, connected: bool }), 1, 2), matchId: nullable(id),
  })(v, p);
  const r = v as import('./types.js').Room;
  if (new Set(r.players.map(x => x.playerId)).size !== r.players.length || r.players[0]?.playerId !== r.hostPlayerId) fail(p, 'Invalid room membership or host');
  if (r.players.some(x => !x.connected)) fail(p, 'M2 does not retain disconnected players');
  if (r.status === 'lobby') { if (r.matchId !== null) fail(`${p}.matchId`, 'Lobby cannot have match'); }
  else if (r.matchId === null || r.players.length !== 2 || r.players.some(x => x.ready)) fail(p, 'Invalid started room');
};
const action: Check = (v, p) => {
  const o = record(v, p);
  switch (o.type) {
    case 'start-turn': case 'jump': case 'end-turn': exact({ type: literal(o.type) })(v, p); break;
    case 'move': exact({ type: literal('move'), direction: oneOf([-1, 0, 1]) })(v, p); break;
    case 'fire': exact({ type: literal('fire'), angleDegrees: number(0, 180), power: number(0, 1) })(v, p); break;
    default: fail(`${p}.type`, 'Unknown action type');
  }
};
const event: Check = (v, p) => {
  const o = record(v, p), fields: Record<string, Check> = { type: literal(o.type as string) };
  switch (o.type) {
    case 'turn-started': case 'turn-ready': Object.assign(fields, { playerId: id, turnNumber: positive }); break;
    case 'shot-fired': Object.assign(fields, { playerId: id, position: vector }); break;
    case 'explosion': Object.assign(fields, { position: vector, radius: number(0, 1000000), removedCells: number(0, LIMITS.maxMapCells, true) }); break;
    case 'damage': Object.assign(fields, { wormId: id, amount: number(0, 1000, true), cause: oneOf(['explosion', 'fall', 'out-of-bounds', 'resolution-limit']) }); break;
    case 'knockback': Object.assign(fields, { wormId: id, velocity: vector }); break;
    case 'worm-landed': Object.assign(fields, { wormId: id, impactSpeed: number(0, 1000000) }); break;
    case 'resolution-limit': fields.ticks = uint; break;
    case 'worm-died': fields.wormId = id; break;
    case 'turn-ended': Object.assign(fields, { playerId: id, reason }); break;
    case 'game-finished': fields.winnerId = nullable(id); break;
    default: fail(`${p}.type`, 'Unknown event type');
  }
  exact(fields)(v, p);
};
function checkEventReferences(events: GameEvent[], s: GameState, p: string): void {
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (('playerId' in e && !s.players.includes(e.playerId)) || ('wormId' in e && !s.worms.some(w => w.id === e.wormId)) ||
        (e.type === 'game-finished' && (s.phase !== 'finished' || e.winnerId !== s.winnerId))) fail(`${p}[${i}]`, 'Event does not reference snapshot members or result');
  }
}
const base = { protocolVersion: literal(PROTOCOL_VERSION) };
const request = { ...base, requestId: id };
function clientCheck(v: unknown, p: string): void {
  const o = record(v, p), fields = { ...request, type: literal(o.type as string) };
  switch (o.type) {
    case 'hello': exact({ ...fields, displayName: displayName(false) })(v, p); break;
    case 'room.create': exact(fields)(v, p); break;
    case 'room.join': case 'room.leave': case 'room.start': exact({ ...fields, roomId: id })(v, p); break;
    case 'room.ready': exact({ ...fields, roomId: id, ready: bool })(v, p); break;
    case 'game.snapshot': exact({ ...fields, roomId: id, matchId: id })(v, p); break;
    case 'game.command': exact({ ...fields, roomId: id, matchId: id, commandId: id, action })(v, p); break;
    default: fail(`${p}.type`, 'Unknown client message type', 'unknown-type');
  }
}
function resultCheck(v: unknown, p: string): void {
  const o = record(v, p);
  if (typeof o.requestType !== 'string' || !Object.hasOwn(REQUEST_REJECTIONS, o.requestType)) fail(`${p}.requestType`, 'Unknown result request type');
  const type = o.requestType as keyof typeof REQUEST_REJECTIONS;
  const fields = { ...request, type: literal('result'), requestType: literal(type), ok: bool };
  if (o.ok === false) {
    exact({ ...fields, code: oneOf(REQUEST_REJECTIONS[type]) })(v, p); return;
  }
  switch (type) {
    case 'room.create': case 'room.join': case 'room.ready': exact({ ...fields, ok: literal(true), room })(v, p); break;
    case 'room.leave': exact({ ...fields, ok: literal(true) })(v, p); break;
    case 'room.start': exact({ ...fields, ok: literal(true), matchId: id, revision: literal(0) })(v, p); break;
    default: fail(p, 'Snapshot success must use game.snapshot');
  }
}
function serverCheck(v: unknown, p: string, context: ValidationContext): void {
  const o = record(v, p), fields = { ...base, type: literal(o.type as string) };
  switch (o.type) {
    case 'welcome': exact({ ...fields, requestId: id, connectionId: id, playerId: id, displayName: displayName(true), serverTimeMs: uint,
      limits: exact(Object.fromEntries(Object.entries(LIMITS).map(([key, value]) => [key, literal(value)]))),
    })(v, p); break;
    case 'result': resultCheck(v, p); break;
    case 'room.state': exact({ ...fields, room })(v, p); break;
    case 'room.closed': exact({ ...fields, roomId: id, matchId: id, reason: oneOf(['player-left', 'player-disconnected']) })(v, p); break;
    case 'command.result': {
      const common = { ...fields, requestId: id, commandId: id, matchId: id, accepted: bool };
      if (o.accepted === true) exact({ ...common, accepted: literal(true), revision: uint })(v, p);
      else exact({ ...common, accepted: literal(false), revision: o.revision === null ? literal(null) : uint,
        rejection: oneOf(o.revision === null ? ADDRESS_REJECTIONS : CORE_REJECTIONS),
      })(v, p);
      break;
    }
    case 'game.update': case 'game.snapshot': {
      exact({ ...fields, ...(o.type === 'game.snapshot' ? { requestId: id } : {}), roomId: id, matchId: id, revision: uint, serverTimeMs: uint,
        state, events: array(event, 0, o.type === 'game.snapshot' ? 0 : LIMITS.maxEventsPerUpdate),
      })(v, p);
      const update = v as Extract<ServerMessage, { type: 'game.update' }>;
      checkEventReferences(update.events, update.state, `${p}.events`);
      if (context.room && (update.roomId !== context.room.roomId || update.matchId !== context.room.matchId ||
        update.state.players.some((player, i) => player !== context.room!.players[i]?.playerId))) fail(p, 'Snapshot does not belong to current room');
      break;
    }
    case 'error': exact({ ...fields, requestId: nullable(id), code: oneOf(PROTOCOL_ERROR_CODES), message: (value, at) => {
      if (typeof value !== 'string' || [...value].length > 256) fail(at, 'Invalid public error message');
    } })(v, p); break;
    default: fail(`${p}.type`, 'Unknown server message type', 'unknown-type');
  }
}

/** Counts UTF-8 bytes without Buffer/TextEncoder or allocating a second copy. */
function utf8Bytes(text: string, max: number): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes++;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
    if (bytes > max) return bytes;
  }
  return bytes;
}
/** Reject non-JSON values, cycles, accessors and deep input before schema traversal/stringification. */
function jsonSize(value: unknown, cap: number): void {
  let size = 0;
  const ancestors = new Set<object>();
  const add = (n: number) => { size += n; if (size > cap) fail('$', 'Message exceeds byte limit', 'message-too-large'); };
  const stringSize = (s: string) => {
    if (s.length > cap) fail('$', 'Message exceeds byte limit', 'message-too-large');
    add(utf8Bytes(JSON.stringify(s), cap));
  };
  const visit = (v: unknown, depth: number): void => {
    if (v === null) { add(4); return; }
    if (typeof v === 'string') { stringSize(v); return; }
    if (typeof v === 'boolean') { add(v ? 4 : 5); return; }
    if (typeof v === 'number') { if (!Number.isFinite(v)) fail('$', 'Expected finite JSON number'); add(String(v).length); return; }
    if (typeof v !== 'object') fail('$', 'Expected JSON data');
    if (depth > LIMITS.maxMessageDepth) fail('$', 'Message exceeds nesting limit');
    if (ancestors.has(v)) fail('$', 'Cyclic input is not JSON');
    const isArray = Array.isArray(v);
    if ((!isArray && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) || Object.getOwnPropertySymbols(v).length) fail('$', 'Expected plain JSON data');
    ancestors.add(v); add(2);
    if (isArray) {
      if (v.length > cap) fail('$', 'Message exceeds byte limit', 'message-too-large');
      if (Object.getOwnPropertyNames(v).length !== v.length + 1) fail('$', 'Array has holes or extra fields');
      for (let i = 0; i < v.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
        if (!descriptor || !('value' in descriptor)) fail('$', 'Expected JSON array element');
        if (i) add(1); visit(descriptor.value, depth + 1);
      }
    } else {
      let index = 0;
      for (const key of Object.getOwnPropertyNames(v)) {
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        if (!descriptor.enumerable || !('value' in descriptor)) fail('$', 'Expected JSON object field');
        if (index++) add(1); stringSize(key); add(1); visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(v);
  };
  visit(value, 1);
}
function requestId(value: unknown): string | null {
  try {
    if (value === null || typeof value !== 'object') return null;
    const d = Object.getOwnPropertyDescriptor(value, 'requestId');
    return d && 'value' in d && typeof d.value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(d.value) ? d.value : null;
  } catch { return null; }
}
function failure(error: unknown, value: unknown): { ok: false; error: ValidationError } {
  const invalid = error instanceof Invalid ? error : new Invalid('invalid-message', '$', 'Expected JSON message');
  return { ok: false, error: { code: invalid.code, path: invalid.path, message: invalid.message, requestId: requestId(value) } };
}
function validate<T>(value: unknown, cap: number, check: Check): ValidationResult<T> {
  try {
    // Size and JSON safety before accessing any untrusted properties.
    jsonSize(value, cap);
    const o = record(value, '$');
    if (o.protocolVersion !== PROTOCOL_VERSION) fail('$.protocolVersion', 'Unsupported protocol version', 'unsupported-version');
    check(value, '$');
    return { ok: true, value: value as T };
  } catch (error) { return failure(error, value); }
}
function parse<T>(text: unknown, cap: number, check: (value: unknown) => ValidationResult<T>): ValidationResult<T> {
  if (typeof text !== 'string') return failure(new Invalid('invalid-message', '$', 'Expected text WebSocket message'), null);
  if (utf8Bytes(text, cap) > cap) return failure(new Invalid('message-too-large', '$', 'Message exceeds byte limit'), null);
  let value: unknown;
  try { value = JSON.parse(text); } catch { return failure(new Invalid('invalid-json', '$', 'Malformed JSON'), null); }
  return check(value);
}
export function validateClientMessage(value: unknown): ValidationResult<ClientMessage> {
  return validate(value, LIMITS.maxClientMessageBytes, clientCheck);
}
export function validateServerMessage(value: unknown, context: ValidationContext = {}): ValidationResult<ServerMessage> {
  return validate(value, LIMITS.maxServerMessageBytes, (v, p) => serverCheck(v, p, context));
}
export function parseClientMessage(text: unknown): ValidationResult<ClientMessage> {
  return parse(text, LIMITS.maxClientMessageBytes, validateClientMessage);
}
export function parseServerMessage(text: unknown, context: ValidationContext = {}): ValidationResult<ServerMessage> {
  return parse(text, LIMITS.maxServerMessageBytes, value => validateServerMessage(value, context));
}
