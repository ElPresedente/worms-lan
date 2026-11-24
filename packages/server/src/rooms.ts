import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Match } from './match.js';
import { LIMITS, MAX_MATCH_COMMANDS_PER_PLAYER, PROTOCOL_VERSION } from './protocol.js';
import type { AddressRejection, NetworkAction, RequestFailure, Room, ServerMessage } from './protocol.js';
import type { AuthenticatedRequest, Identity, ResumeSeat, Session } from './server.js';

interface Member {
  player: Pick<Identity, 'playerId' | 'displayName'>;
  session: Session | undefined;
  resumeToken: string;
  ready: boolean;
  expiration?: { at: number; timer: NodeJS.Timeout };
  commands: Map<string, { action: NetworkAction; outcome: NonNullable<ReturnType<Match['command']>> }>;
}
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
type Reply = WithoutEnvelope<Extract<ServerMessage, { requestId: string } | { type: 'error' }>>;

function sameAction(a: NetworkAction, b: NetworkAction): boolean {
  switch (a.type) {
    case 'move': return b.type === 'move' && a.direction === b.direction;
    case 'fire': return b.type === 'fire' && a.angleDegrees === b.angleDegrees && a.power === b.power;
    default: return a.type === b.type;
  }
}

export class Rooms {
  private readonly rooms = new Map<string, HostedRoom>();
  private readonly membership = new Map<string, HostedRoom>();
  private readonly seats = new Map<string, { room: HostedRoom; member: Member }>();

  constructor(private readonly retentionMs: number) {
    if (!Number.isInteger(retentionMs) || retentionMs < 1 || retentionMs > 2_147_483_647) {
      throw new RangeError('Invalid seat retention interval');
    }
  }

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
      const created: HostedRoom = { id: randomUUID(), revision: 1, status: 'lobby', members: [] };
      this.rooms.set(created.id, created);
      const resumeToken = this.addMember(created, session);
      reply({ type: 'result', requestType, ok: true, room: this.describe(created), resumeToken });
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
      const resumeToken = this.addMember(target, session);
      reply({ type: 'result', requestType, ok: true, room: this.describe(target), resumeToken });
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
      const { action, commandId } = request;
      const member = selected!.members.find(item => item.player.playerId === playerId)!;
      const previous = member.commands.get(commandId);
      const rejectCommand = (code: 'command-id-conflict' | 'resource-limit') =>
        reply({ type: 'error', code, message: code });
      if (previous && !sameAction(previous.action, action)) { rejectCommand('command-id-conflict'); return; }
      if (!previous && member.commands.size >= MAX_MATCH_COMMANDS_PER_PLAYER) { rejectCommand('resource-limit'); return; }
      const outcome = previous?.outcome ?? match.command({ ...action, playerId });
      if (outcome) {
        if (!previous) member.commands.set(commandId, { action, outcome });
        reply({ type: 'command.result', commandId, matchId: match.id, ...outcome });
      }
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
      const member = selected.members.find(item => item.player.playerId === playerId)!;
      const changed = member.ready !== request.ready;
      if (changed && !this.revise(selected)) return;
      member.ready = request.ready;
      reply({ type: 'result', requestType, ok: true, room: this.describe(selected) });
      if (changed) this.broadcastRoom(selected);
      return;
    }

    const [host, guest] = selected.members;
    if (host!.player.playerId !== playerId) { reject({ requestType, code: 'not-host' }); return; }
    if (selected.status !== 'lobby') { reject({ requestType, code: 'room-not-in-lobby' }); return; }
    if (!host!.ready || !guest?.ready) { reject({ requestType, code: 'players-not-ready' }); return; }
    const match = this.createMatch(selected, [playerId, guest.player.playerId]);
    if (!this.revise(selected)) return;
    selected.match = match;
    selected.status = 'playing';
    for (const member of selected.members) member.ready = false;
    reply({ type: 'result', requestType, ok: true, matchId: match.id, revision: 0 });
    this.broadcastRoom(selected);
    match.begin();
  }

  disconnect({ playerId, connectionId }: Identity): void {
    const room = this.membership.get(playerId);
    const member = room?.members.find(item => item.player.playerId === playerId);
    if (!room || member?.session?.identity.connectionId !== connectionId) return;
    if (!room.match) { this.leave(room, playerId, 'player-disconnected'); return; }
    if (!this.revise(room)) return;
    member.session = undefined;
    member.expiration = {
      at: performance.now() + this.retentionMs,
      timer: setTimeout(() => this.leave(room, playerId, 'player-disconnected'), this.retentionMs).unref(),
    };
    room.match.releaseMovement(playerId);
    if (this.rooms.has(room.id)) this.broadcastRoom(room);
  }

  resume(token: string): ResumeSeat {
    const seat = this.seats.get(token);
    const match = seat?.room.match;
    if (!seat || !match) return { code: 'resume-unavailable' };
    const { room, member } = seat;
    if (member.session) return { code: 'resume-in-use' };
    if (!member.expiration || performance.now() >= member.expiration.at) {
      this.leave(room, member.player.playerId, 'player-disconnected');
      return { code: 'resume-unavailable' };
    }
    if (!this.revise(room)) return { code: 'resume-unavailable' };
    return {
      player: member.player,
      restore: session => {
        clearTimeout(member.expiration?.timer);
        delete member.expiration;
        member.session = session;
        const publicRoom = this.describe(room);
        this.broadcast(room, { protocolVersion, type: 'room.state', room: publicRoom }, session);
        return { room: publicRoom, snapshot: match.snapshot() };
      },
    };
  }

  stop(): void {
    for (const room of this.rooms.values()) this.remove(room);
  }

  private addMember(room: HostedRoom, session: Session): string {
    const { playerId, displayName } = session.identity;
    const resumeToken = randomBytes(32).toString('base64url');
    const member: Member = { player: { playerId, displayName }, session, resumeToken, ready: false, commands: new Map() };
    room.members.push(member);
    this.membership.set(playerId, room);
    this.seats.set(resumeToken, { room, member });
    return resumeToken;
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
    const member = room.members.find(item => item.player.playerId === playerId);
    if (!member) return;
    if (room.match) {
      this.remove(room);
      this.broadcast(room, { protocolVersion, type: 'room.closed', roomId: room.id, matchId: room.match.id, reason }, member.session);
      return;
    }
    this.removeMember(member);
    room.members = room.members.filter(item => item !== member);
    if (room.members.length === 0) {
      this.remove(room);
    } else if (this.revise(room)) {
      for (const member of room.members) member.ready = false;
      this.broadcastRoom(room);
    }
  }

  private remove(room: HostedRoom): void {
    room.match?.stop();
    this.rooms.delete(room.id);
    for (const member of room.members) this.removeMember(member);
  }

  private removeMember(member: Member): void {
    clearTimeout(member.expiration?.timer);
    this.membership.delete(member.player.playerId);
    this.seats.delete(member.resumeToken);
  }

  private close(room: HostedRoom, code: number): void {
    this.remove(room);
    for (const { session } of room.members) session?.close(code);
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
      roomId: room.id, roomRevision: room.revision, hostPlayerId: room.members[0]!.player.playerId,
      status: room.status, matchId: room.match?.id ?? null,
      players: room.members.map(({ player, ready, session }) => ({ ...player, ready, connected: Boolean(session) })),
    };
  }

  private broadcastRoom(room: HostedRoom): void {
    this.broadcast(room, { protocolVersion, type: 'room.state', room: this.describe(room) });
  }

  private broadcast(room: HostedRoom, message: ServerMessage, except?: Session): void {
    for (const member of room.members) {
      if (member.session !== except) member.session?.send(message);
    }
  }
}
