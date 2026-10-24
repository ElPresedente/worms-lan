import type { Action, GameState, GameEvent, Rejection } from '@office-worms/game-core';
import type { LIMITS, PROTOCOL_ERROR_CODES, ADDRESS_REJECTIONS, REQUEST_REJECTIONS } from './constants.js';

type WithoutIdentity<T> = T extends Action ? Omit<T, 'playerId'> : never;
export type NetworkAction = WithoutIdentity<Action>;
export type Limits = typeof LIMITS;
export type ProtocolErrorCode = typeof PROTOCOL_ERROR_CODES[number];
export type AddressRejection = typeof ADDRESS_REJECTIONS[number];
export type RoomRequestType = keyof typeof REQUEST_REJECTIONS;
interface Envelope<T extends string> { protocolVersion: 1; type: T }
interface Request<T extends string> extends Envelope<T> { requestId: string }
export interface RoomPlayer { playerId: string; displayName: string; ready: boolean; connected: boolean }
export interface Room {
  roomId: string; roomRevision: number; hostPlayerId: string;
  status: 'lobby' | 'playing' | 'finished'; players: RoomPlayer[]; matchId: string | null;
}
export type ClientMessage =
  | (Request<'hello'> & { displayName: string })
  | Request<'room.create'>
  | (Request<'room.join' | 'room.leave' | 'room.start'> & { roomId: string })
  | (Request<'room.ready'> & { roomId: string; ready: boolean })
  | (Request<'game.command'> & { roomId: string; matchId: string; commandId: string; action: NetworkAction })
  | (Request<'game.snapshot'> & { roomId: string; matchId: string });
export type RequestFailure = {
  [K in RoomRequestType]: Request<'result'> & { requestType: K; ok: false; code: typeof REQUEST_REJECTIONS[K][number] }
}[RoomRequestType];
export type RequestSuccess = Request<'result'> & { ok: true } & (
  | { requestType: 'room.create' | 'room.join' | 'room.ready'; room: Room }
  | { requestType: 'room.leave' }
  | { requestType: 'room.start'; matchId: string; revision: 0 }
);
export type CommandResult = Request<'command.result'> & { commandId: string; matchId: string } & (
  | { accepted: true; revision: number }
  | { accepted: false; revision: number; rejection: Rejection }
  | { accepted: false; revision: null; rejection: AddressRejection }
);
export interface SnapshotFields {
  roomId: string; matchId: string; revision: number; serverTimeMs: number;
  state: GameState; events: GameEvent[];
}
export type ServerMessage =
  | (Request<'welcome'> & { connectionId: string; playerId: string; displayName: string; serverTimeMs: number; limits: Limits })
  | RequestSuccess | RequestFailure | CommandResult
  | (Envelope<'room.state'> & { room: Room })
  | (Envelope<'room.closed'> & { roomId: string; matchId: string; reason: 'player-left' | 'player-disconnected' })
  | (Envelope<'game.update'> & SnapshotFields)
  | (Request<'game.snapshot'> & SnapshotFields)
  | (Envelope<'error'> & { requestId: string | null; code: ProtocolErrorCode; message: string });

export interface ValidationError {
  code: ProtocolErrorCode;
  /** JSON path, with no values from untrusted payloads. */
  path: string;
  message: string;
  requestId: string | null;
}
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: ValidationError };
/** Optional trusted current room allows cross-message identity checks. */
export interface ValidationContext { room?: Room }
