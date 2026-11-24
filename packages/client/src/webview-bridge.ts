import { ADDRESS_REJECTIONS, CORE_REJECTIONS, PROTOCOL_ERROR_CODES, PROTOCOL_VERSION,
  isGameUpdate, validateClientMessage, validateServerMessage } from '#protocol';
import type { NetworkAction, Room } from '#protocol';
import { websocketAddress } from './connection.js';
import type { LobbyRequest } from './connection.js';
import type { OnlineClient } from './network-client.js';
import type { CommandOutcome, Update } from './session.js';

export const ACTION_TYPES = ['start-turn', 'move', 'jump', 'fire', 'end-turn'] as const satisfies readonly NetworkAction['type'][];
const STATUSES = ['connecting', 'ready', 'reconnecting', 'disconnected'] as const;

export type ViewRequest =
  | { type: 'attach' | 'disconnect' | 'resync' }
  | { type: 'connect'; id: number; name: string }
  | { type: 'lobby'; id: number; request: LobbyRequest }
  | { type: 'command'; id: number; matchId: string; turn: number; action: NetworkAction }
  | { type: 'refresh'; id: number; matchId: string };
export interface ViewMessage {
  viewId: string;
  request: ViewRequest;
}

type MatchView = Update & { canControl: boolean; actions: NetworkAction['type'][] };
export interface ConnectionView {
  address: string;
  name: string;
  status: OnlineClient['status'];
  notice: string;
  playerId: string | null;
  room: Room | null;
  match: MatchView | null;
}
export type ViewReply =
  | { type: 'text'; id: number; text: string }
  | { type: 'command'; id: number; outcome: CommandOutcome }
  | { type: 'refresh'; id: number; ok: boolean };
export type HostMessage = { viewId: string } & (
  { type: 'state'; state: ConnectionView } | { type: 'reply'; reply: ViewReply }
);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, ...keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function key(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
function sequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function validAddress(value: unknown): boolean {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { return websocketAddress(value) === value; } catch { return false; }
}
function text(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length <= max;
}
function protocolMessage(value: Record<string, unknown>) {
  return validateClientMessage({ ...value, protocolVersion: PROTOCOL_VERSION, requestId: 'bridge' });
}

export function isViewMessage(value: unknown): value is ViewMessage {
  if (!record(value) || !fields(value, 'viewId', 'request') || !key(value.viewId) || !record(value.request)) return false;
  const r = value.request;
  switch (r.type) {
    case 'attach': case 'disconnect': case 'resync': return fields(r, 'type');
    case 'connect':
      return fields(r, 'type', 'id', 'name') && sequence(r.id) &&
        protocolMessage({ type: 'hello', displayName: r.name }).ok;
    case 'lobby':
      return fields(r, 'type', 'id', 'request') && sequence(r.id) && record(r.request) &&
        typeof r.request.type === 'string' && r.request.type.startsWith('room.') &&
        !Object.hasOwn(r.request, 'protocolVersion') && !Object.hasOwn(r.request, 'requestId') &&
        protocolMessage(r.request).ok;
    case 'command':
      return fields(r, 'type', 'id', 'matchId', 'turn', 'action') && sequence(r.id) && key(r.matchId) && sequence(r.turn) &&
        protocolMessage({ type: 'game.command', roomId: 'bridge', matchId: r.matchId, commandId: 'bridge', action: r.action }).ok;
    case 'refresh': return fields(r, 'type', 'id', 'matchId') && sequence(r.id) && key(r.matchId);
    default: return false;
  }
}

function validState(value: unknown): boolean {
  if (!record(value) || !fields(value, 'address', 'name', 'status', 'notice', 'playerId', 'room', 'match') ||
      !validAddress(value.address) || !text(value.name, 64) || !text(value.notice, 256) ||
      !STATUSES.some(status => status === value.status) || (value.playerId !== null && !key(value.playerId))) return false;
  if (value.room === null) return value.match === null;
  const checked = validateServerMessage({ protocolVersion: PROTOCOL_VERSION, type: 'room.state', room: value.room });
  if (!checked.ok || checked.value.type !== 'room.state') return false;
  const { room } = checked.value;
  if (!room.players.some(player => player.playerId === value.playerId)) return false;
  const match = value.match;
  if (match === null) return true;
  if (!room.matchId || !record(match) || !fields(match, 'state', 'events', 'reset', 'resynced', 'terrainChanged', 'canControl', 'actions') ||
      typeof match.reset !== 'boolean' || typeof match.resynced !== 'boolean' || typeof match.terrainChanged !== 'boolean' ||
      typeof match.canControl !== 'boolean' || !Array.isArray(match.actions) || match.actions.length > ACTION_TYPES.length ||
      !match.actions.every(action => ACTION_TYPES.some(type => action === type)) ||
      (!match.canControl && match.actions.length !== 0)) return false;
  const update = { state: match.state, events: match.events };
  return isGameUpdate(update) && update.state.players.every((id, i) => room.players[i]?.playerId === id);
}

function validReply(value: unknown): boolean {
  if (!record(value) || !sequence(value.id)) return false;
  switch (value.type) {
    case 'text': return fields(value, 'type', 'id', 'text') && text(value.text, 256);
    case 'refresh': return fields(value, 'type', 'id', 'ok') && typeof value.ok === 'boolean';
    case 'command': {
      const outcome = value.outcome;
      if (!fields(value, 'type', 'id', 'outcome') || !record(outcome)) return false;
      switch (outcome.kind) {
        case 'accepted': case 'unknown': case 'skipped': return fields(outcome, 'kind');
        case 'rejected': return fields(outcome, 'kind', 'code') &&
          [...ADDRESS_REJECTIONS, ...CORE_REJECTIONS].some(code => code === outcome.code);
        case 'error': return fields(outcome, 'kind', 'code') && PROTOCOL_ERROR_CODES.some(code => code === outcome.code);
        default: return false;
      }
    }
    default: return false;
  }
}

export function isHostMessage(value: unknown): value is HostMessage {
  if (!record(value) || !key(value.viewId)) return false;
  switch (value.type) {
    case 'state': return fields(value, 'viewId', 'type', 'state') && validState(value.state);
    case 'reply': return fields(value, 'viewId', 'type', 'reply') && validReply(value.reply);
    default: return false;
  }
}
