import { websocketAddress } from '#client/connection';
import { NetworkClient, readSeat } from '#client/network-client';
import type { OnlineMatch } from '#client/network-client';
import type { Update } from '#client/session';
import { ACTION_TYPES, isViewMessage } from '#client/webview-bridge';
import type { HostMessage, ViewReply } from '#client/webview-bridge';

interface View {
  send(message: HostMessage): void;
  id?: string;
  visible: boolean;
  lastRequest: number;
}

function configuredAddress(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try { return websocketAddress(value); } catch { return ''; }
}

export class WebviewHost {
  private readonly network: NetworkClient;
  private readonly unsubscribe: () => void;
  private match: OnlineMatch | undefined;
  private unsubscribeMatch: (() => void) | undefined;
  private view: View | undefined;
  private moving: { match: OnlineMatch; turn: number } | undefined;
  private saved: Promise<void> = Promise.resolve();

  constructor(address: unknown, stored: string | undefined, save: (value: string | undefined) => PromiseLike<void>) {
    const url = configuredAddress(address);
    this.network = new NetworkClient(url, seat => {
      this.saved = this.saved.then(() => save(seat ? JSON.stringify(seat) : undefined)).catch(() => {
        // The connection can recover in memory if SecretStorage is unavailable.
      });
    });
    const seat = readSeat(stored);
    if (seat?.url === url) this.network.restore(seat);
    this.unsubscribe = this.network.subscribe(() => {
      const match = this.network.match;
      if (match !== this.match) {
        this.unsubscribeMatch?.();
        this.moving = undefined;
        this.match = match;
        this.unsubscribeMatch = match?.subscribe(update => this.publish(update));
        if (match) return;
      }
      this.publish();
    });
  }

  setAddress(address: unknown): void { this.network.setDefaultAddress(configuredAddress(address)); }

  setView(send?: View['send'], visible = false): void {
    this.releaseMovement();
    this.view = send ? { send, visible, lastRequest: 0 } : undefined;
  }

  setVisible(visible: boolean): void {
    if (!this.view || this.view.visible === visible) return;
    this.view.visible = visible;
    if (visible) this.publish(undefined, true);
    else this.releaseMovement();
  }

  async receive(value: unknown): Promise<void> {
    const view = this.view;
    if (!view || !isViewMessage(value)) return;
    const { viewId, request } = value;
    if (request.type === 'attach') {
      if (view.id !== viewId) {
        this.releaseMovement();
        view.id = viewId;
        view.lastRequest = 0;
      }
      this.publish(undefined, true);
      return;
    }
    if (view.id !== viewId || !view.visible) return;
    const respond = (reply: ViewReply) => {
      if (this.view === view && view.id === viewId && view.visible) view.send({ viewId, type: 'reply', reply });
    };
    if ('id' in request) {
      if (request.id <= view.lastRequest) return;
      view.lastRequest = request.id;
    }
    switch (request.type) {
      case 'connect':
        respond({ type: 'text', id: request.id, text: this.network.connect(request.name) });
        break;
      case 'disconnect':
        this.network.disconnect('Вы отключились от сервера.');
        break;
      case 'resync':
        this.network.resync();
        break;
      case 'lobby':
        respond({ type: 'text', id: request.id, text: await this.network.lobby(request.request) });
        break;
      case 'refresh': {
        const ok = this.network.room?.matchId === request.matchId && (await this.match?.refresh() ?? false);
        respond({ type: 'refresh', id: request.id, ok });
        break;
      }
      case 'command': {
        const match = this.match;
        if (!match || this.network.room?.matchId !== request.matchId || match.state.turnNumber !== request.turn ||
            !match.canCommand(request.action.type)) {
          respond({ type: 'command', id: request.id, outcome: { kind: 'skipped' } });
          break;
        }
        if (request.action.type === 'move') {
          this.moving = request.action.direction === 0 ? undefined : { match, turn: request.turn };
        }
        respond({ type: 'command', id: request.id, outcome: await match.command(request.action) });
        break;
      }
    }
  }

  dispose(): Promise<void> {
    this.setView();
    this.unsubscribeMatch?.();
    this.unsubscribe();
    this.network.dispose();
    return this.saved;
  }

  private releaseMovement(): void {
    const moving = this.moving;
    this.moving = undefined;
    if (moving && moving.match.state.turnNumber === moving.turn) {
      void moving.match.command({ type: 'move', direction: 0 });
    }
  }

  private publish(update?: Update, resynced = false): void {
    if (!this.view?.id || !this.view.visible) return;
    const { address, displayName, notice, status, room, playerId } = this.network;
    const match = this.match;
    this.view.send({
      viewId: this.view.id,
      type: 'state',
      state: {
        address, name: displayName, notice, status, room: room ?? null, playerId: playerId ?? null,
        match: match ? {
          state: match.state, events: update?.events ?? [], reset: update?.reset ?? false,
          resynced: resynced || Boolean(update?.resynced), terrainChanged: resynced || Boolean(update?.terrainChanged),
          canControl: match.canControl, actions: ACTION_TYPES.filter(type => match.canCommand(type)),
        } : null,
      },
    });
  }
}
