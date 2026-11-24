import { randomUUID } from 'node:crypto';
import { Match } from './match.js';
import { LIMITS, PROTOCOL_VERSION } from './protocol.js';
import type { AddressRejection, RequestFailure, Room, ServerMessage } from './protocol.js';
import type { AuthenticatedRequest, Identity, Session } from './server.js';

interface Member { session: Session; ready: boolean }
interface HostedRoom {
  id: string;
  revision: number;
  members: Member[];
  match?: Match;
  status: Room['status'];
}

const protocolVersion = PROTOCOL_VERSION;
type WithoutEnvelope<T> = T extends ServerMessage ? Omit<T, 'protocolVersion' | 'requestId'> : never;
// Preserve the association between each request and its valid rejection codes.
type FailureDetails<T = RequestFailure> = T extends RequestFailure ? Pick<T, 'requestType' | 'code'> : never;
type Reply = WithoutEnvelope<Extract<ServerMessage, { requestId: string }>>;

export class Rooms {
  private readonly rooms = new Map<string, HostedRoom>();
  private readonly membership = new Map<string, HostedRoom>();

  request(request: AuthenticatedRequest, session: Session): void {
    const { playerId } = session.identity;
    const { requestId } = request;
    const reply = (message: Reply) => session.send({ protocolVersion, requestId, ...message });
    const reject = (details: FailureDetails) => reply({ type: 'result', ok: false, ...details });
    const room = this.membership.get(playerId);
    const requestType = request.type;
    if (requestType === 'room.create') {
      if (room) { reject({ requestType, code: 'already-in-room' }); return; }
      if (this.rooms.size >= LIMITS.maxRooms) { reject({ requestType, code: 'resource-limit' }); return; }
      const created: HostedRoom = { id: randomUUID(), revision: 1, status: 'lobby', members: [{ session, ready: false }] };
      this.rooms.set(created.id, created);
      this.membership.set(playerId, created);
      reply({ type: 'result', requestType, ok: true, room: this.describe(created) });
      this.broadcastRoom(created);
      return;
    }
    if (requestType === 'room.join') {
      if (room) { reject({ requestType, code: 'already-in-room' }); return; }
      const target = this.rooms.get(request.roomId);
      if (!target) { reject({ requestType, code: 'room-not-found' }); return; }
      if (target.status !== 'lobby') { reject({ requestType, code: 'room-not-joinable' }); return; }
      if (target.members.length >= LIMITS.maxPlayersPerRoom) { reject({ requestType, code: 'room-full' }); return; }
      if (!this.revise(target)) { reject({ requestType, code: 'room-not-found' }); return; }
      for (const member of target.members) member.ready = false;
      target.members.push({ session, ready: false });
      this.membership.set(playerId, target);
      reply({ type: 'result', requestType, ok: true, room: this.describe(target) });
      this.broadcastRoom(target);
      return;
    }

    const selected = room?.id === request.roomId ? room : undefined;
    if (requestType === 'game.command' || requestType === 'game.snapshot') {
      const match = selected?.match;
      if (!match || match.id !== request.matchId) {
        const code: AddressRejection = !selected ? 'not-in-room' : !match ? 'match-not-found' : 'match-mismatch';
        if (requestType === 'game.snapshot') reject({ requestType, code });
        else reply({ type: 'command.result', commandId: request.commandId, matchId: request.matchId,
          accepted: false, revision: null, rejection: code });
        return;
      }
      if (requestType === 'game.snapshot') { reply({ type: 'game.snapshot', ...match.snapshot() }); return; }
      const outcome = match.command({ ...request.action, playerId });
      if (outcome) reply({ type: 'command.result', commandId: request.commandId, matchId: match.id, ...outcome });
      return;
    }

    if (!selected) { reject({ requestType, code: 'not-in-room' }); return; }
    if (requestType === 'room.leave') {
      reply({ type: 'result', requestType, ok: true });
      this.leave(selected, playerId, 'player-left');
      return;
    }
    if (requestType === 'room.ready') {
      if (selected.status !== 'lobby') { reject({ requestType, code: 'room-not-in-lobby' }); return; }
      const member = selected.members.find(item => item.session.identity.playerId === playerId)!;
      const changed = member.ready !== request.ready;
      if (changed && !this.revise(selected)) return;
      member.ready = request.ready;
      reply({ type: 'result', requestType, ok: true, room: this.describe(selected) });
      if (changed) this.broadcastRoom(selected);
      return;
    }

    const [host, guest] = selected.members;
    if (host!.session.identity.playerId !== playerId) { reject({ requestType, code: 'not-host' }); return; }
    if (selected.status !== 'lobby') { reject({ requestType, code: 'room-not-in-lobby' }); return; }
    if (!host!.ready || !guest?.ready) { reject({ requestType, code: 'players-not-ready' }); return; }
    const match = this.createMatch(selected, [playerId, guest.session.identity.playerId]);
    if (!this.revise(selected)) return;
    selected.match = match;
    selected.status = 'playing';
    for (const member of selected.members) member.ready = false;
    reply({ type: 'result', requestType, ok: true, matchId: match.id, revision: 0 });
    this.broadcastRoom(selected);
    match.begin();
  }

  disconnect({ playerId }: Identity): void {
    const room = this.membership.get(playerId);
    if (room) this.leave(room, playerId, 'player-disconnected');
  }

  stop(): void {
    for (const room of this.rooms.values()) this.remove(room);
  }

  private createMatch(room: HostedRoom, players: readonly [string, string]): Match {
    return new Match(randomUUID(), room.id, players, snapshot => {
      this.broadcast(room, { protocolVersion, type: 'game.update', ...snapshot });
      if (snapshot.state.phase === 'finished' && this.revise(room)) {
        room.status = 'finished';
        this.broadcastRoom(room);
      }
    }, code => this.close(room, code));
  }

  private leave(room: HostedRoom, playerId: string, reason: 'player-left' | 'player-disconnected'): void {
    this.membership.delete(playerId);
    room.members = room.members.filter(member => member.session.identity.playerId !== playerId);
    if (room.match) {
      this.remove(room);
      this.broadcast(room, { protocolVersion, type: 'room.closed', roomId: room.id, matchId: room.match.id, reason });
    } else if (room.members.length === 0) {
      this.remove(room);
    } else if (this.revise(room)) {
      for (const member of room.members) member.ready = false;
      this.broadcastRoom(room);
    }
  }

  private remove(room: HostedRoom): void {
    room.match?.stop();
    this.rooms.delete(room.id);
    for (const { session } of room.members) this.membership.delete(session.identity.playerId);
  }

  private close(room: HostedRoom, code: number): void {
    this.remove(room);
    for (const { session } of room.members) session.close(code);
  }

  private revise(room: HostedRoom): boolean {
    if (room.revision === Number.MAX_SAFE_INTEGER) {
      this.close(room, 1011);
      return false;
    }
    room.revision++;
    return true;
  }

  private describe(room: HostedRoom): Room {
    return {
      roomId: room.id, roomRevision: room.revision, hostPlayerId: room.members[0]!.session.identity.playerId,
      status: room.status, matchId: room.match?.id ?? null,
      players: room.members.map(({ session: { identity: { playerId, displayName } }, ready }) =>
        ({ playerId, displayName, ready, connected: true })),
    };
  }

  private broadcastRoom(room: HostedRoom): void {
    this.broadcast(room, { protocolVersion, type: 'room.state', room: this.describe(room) });
  }

  private broadcast(room: HostedRoom, message: ServerMessage): void {
    for (const member of room.members) member.session.send(message);
  }
}
