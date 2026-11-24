import { LIMITS } from '#protocol';
import { mountGame } from './app.js';
import type { LobbyRequest } from './connection.js';
import type { OnlineClient, OnlineMatch } from './network-client.js';

export function mountOnline(root: HTMLElement, connection: OnlineClient, browserNavigation = true): () => void {
  const wordmark = '<span class="brand-mark" aria-hidden="true"><i></i><i></i></span>office<span>worms</span>';
  const brand = browserNavigation
    ? `<a class="wordmark" href="./" aria-label="Office Worms — главная">${wordmark}</a>`
    : `<div class="wordmark">${wordmark}</div>`;
  const localLink = browserNavigation ? '<a class="tool-button nav-action" href="./">Локальная игра</a>' : '';
  root.innerHTML = `
    <div id="online-lobby">
      <header class="topbar">
        ${brand}
        ${localLink}
      </header>
      <main class="lobby-content">
        <div class="lobby-heading"><h1>Сетевая игра<span>.</span></h1><p class="lobby-status" id="connection-status" role="status"></p></div>
        <section class="lobby-card" aria-label="Подключение к серверу">
          <form id="connect-form" class="lobby-form">
            <label for="server-address" id="address-label">Адрес сервера</label>
            <input id="server-address" placeholder="ws://127.0.0.1:4180/ws" type="url" required spellcheck="false">
            <label for="display-name">Имя игрока</label>
            <input id="display-name" required autocomplete="nickname">
            <button type="submit" id="connect" class="button button-dark">Подключиться</button>
          </form>
          <button type="button" id="disconnect" class="button button-quiet" hidden>Отключиться от сервера</button>
          <p class="error" id="lobby-error" role="alert" hidden></p>
          <p class="lobby-note" id="lobby-notice" aria-live="polite" hidden></p>
        </section>
        <section class="lobby-card" id="room-actions" aria-label="Создание комнаты и вход" hidden>
          <h2>Найти соперника</h2>
          <button type="button" id="create-room" class="button button-dark">Создать комнату</button>
          <form id="join-form" class="lobby-form lobby-join">
            <label for="join-code">Код комнаты</label>
            <input id="join-code" required spellcheck="false" autocomplete="off">
            <button type="submit" id="join-room" class="button">Войти в комнату</button>
          </form>
        </section>
        <section class="lobby-card" id="room-details" aria-label="Текущая комната" hidden>
          <h2>Комната</h2>
          <div class="room-code"><label for="room-code">Код для второго игрока</label><div>
            <input id="room-code" readonly><button type="button" id="copy-code" class="tool-button">Копировать</button>
          </div></div>
          <ol id="room-players" class="room-players" aria-label="Игроки в комнате"></ol>
          <p class="lobby-note" id="room-status" role="status"></p>
          <button type="button" id="room-ready" class="button"></button>
          <button type="button" id="room-start" class="button button-dark">Запустить матч</button>
          <button type="button" id="room-leave" class="button button-quiet">Покинуть комнату</button>
        </section>
      </main>
    </div>
    <div id="online-game" hidden></div>`;
  function el<T extends HTMLElement>(id: string): T { return root.querySelector<T>('#' + id)!; }
  const abort = new AbortController();
  const on = (target: EventTarget, type: string, handler: EventListener) =>
    target.addEventListener(type, handler, { signal: abort.signal });
  const address = el<HTMLInputElement>('server-address');
  const displayName = el<HTMLInputElement>('display-name');
  const joinCode = el<HTMLInputElement>('join-code');
  const roomCode = el<HTMLInputElement>('room-code');
  const connectButton = el<HTMLButtonElement>('connect');
  const readyButton = el<HTMLButtonElement>('room-ready');
  const startButton = el<HTMLButtonElement>('room-start');
  const lobby = el('online-lobby'), game = el('online-game');
  if (!browserNavigation) {
    el('address-label').textContent = 'Адрес сервера (настройка officeWorms.serverAddress)';
    address.readOnly = true;
  }
  joinCode.maxLength = LIMITS.maxIdLength;

  let session: OnlineMatch | undefined;
  let app: ReturnType<typeof mountGame> | undefined;
  let busy = false;
  let submittingConnection = false;
  let lastAddress: string | undefined;
  let lastName: string | undefined;

  function error(text: string): void {
    const node = el('lobby-error');
    node.textContent = text; node.hidden = !text;
  }

  async function run(request: LobbyRequest): Promise<string> {
    if (connection.status !== 'ready' || busy) return '';
    error('');
    busy = true;
    render();
    const message = await connection.lobby(request);
    if (abort.signal.aborted) return '';
    busy = false;
    render();
    return message;
  }

  async function submit(request: LobbyRequest): Promise<void> {
    const message = await run(request);
    if (!abort.signal.aborted) error(message);
  }

  function render(): void {
    const { match, room, status } = connection;
    const connected = status === 'ready';
    const reconnecting = status === 'reconnecting';
    const pending = submittingConnection || status === 'connecting' || reconnecting;
    if (lastAddress !== connection.address) address.value = lastAddress = connection.address;
    if (lastName !== connection.displayName) displayName.value = lastName = connection.displayName;
    if (session !== match) {
      app?.destroy();
      session = match;
      app = match && room ? mountGame(game, match, {
        browserNavigation,
        online: {
          playerId: match.playerId,
          names: new Map(room.players.map(player => [player.playerId, player.displayName])),
          leave: async () => {
            if (connection.status === 'reconnecting') {
              connection.disconnect('Вы отменили восстановление соединения.');
              return '';
            }
            return run({ type: 'room.leave', roomId: room.roomId });
          },
          refresh: () => match.refresh(),
        },
      }) : undefined;
    }
    lobby.hidden = Boolean(match);
    game.hidden = !match;
    if (match) {
      const opponentAway = room?.players.some(player => player.playerId !== match.playerId && !player.connected);
      app?.setConnectionStatus(reconnecting ? 'Переподключаемся…' : opponentAway ? 'Соперник отключился' : 'Сетевая партия', reconnecting);
      return;
    }

    el('connection-status').textContent = ({ connecting: 'Подключаемся…', reconnecting: 'Восстанавливаем матч…',
      ready: 'Подключено', disconnected: 'Нет подключения' })[status];
    const notice = el('lobby-notice');
    notice.textContent = connection.notice;
    notice.hidden = !notice.textContent;
    address.disabled = displayName.disabled = connectButton.disabled = pending || connected;
    connectButton.hidden = connected;
    connectButton.textContent = pending ? 'Подключаемся…' : 'Подключиться';
    const disconnect = el('disconnect');
    disconnect.hidden = status === 'disconnected';
    disconnect.textContent = reconnecting ? 'Отменить восстановление' : 'Отключиться от сервера';
    el('room-actions').hidden = !connected || Boolean(room);
    el('room-details').hidden = !connected || !room;
    for (const id of ['create-room', 'join-room', 'room-leave']) el<HTMLButtonElement>(id).disabled = busy;
    if (!room) return;

    roomCode.value = room.roomId;
    const host = room.hostPlayerId === connection.playerId;
    const me = room.players.find(player => player.playerId === connection.playerId);
    const waitingForPlayer = room.players.length < LIMITS.maxPlayersPerRoom;
    const bothReady = !waitingForPlayer && room.players.every(player => player.ready);
    const rows = room.players.map(player => {
      const row = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = player.displayName + (player.playerId === me?.playerId ? ' (вы)' : '');
      const state = document.createElement('span');
      state.textContent = player.ready ? 'Готов к матчу' : 'Не готов';
      row.append(name, state);
      return row;
    });
    if (waitingForPlayer) {
      const empty = document.createElement('li');
      empty.textContent = 'Свободное место';
      rows.push(empty);
    }
    el('room-players').replaceChildren(...rows);
    readyButton.textContent = me?.ready ? 'Отменить готовность' : 'Я готов';
    readyButton.disabled = busy || room.status !== 'lobby';
    startButton.hidden = !host;
    startButton.disabled = busy || !bothReady || room.status !== 'lobby';
    el('room-status').textContent = room.status !== 'lobby' ? 'Загружаем матч…' : waitingForPlayer ?
      'Передайте код комнаты второму игроку.' : bothReady ? (host ? 'Можно запускать матч.' : 'Ждём запуска от создателя комнаты.') :
      'Для запуска оба игрока должны отметить готовность.';
  }

  on(el('connect-form'), 'submit', async event => {
    event.preventDefault();
    if (submittingConnection || connection.status !== 'disconnected') return;
    error('');
    const name = displayName.value.trim();
    if (!name || [...name].length > LIMITS.maxDisplayNameLength || /[\u0000-\u001f\u007f]/u.test(name)) {
      error('Введите имя длиной от 1 до ' + LIMITS.maxDisplayNameLength + ' символов.');
      return;
    }
    submittingConnection = true;
    busy = false;
    render();
    const message = await connection.connect(name, browserNavigation ? address.value : undefined);
    if (abort.signal.aborted) return;
    submittingConnection = false;
    error(message);
    render();
  });
  on(el('disconnect'), 'click', () => { error(''); connection.disconnect('Вы отключились от сервера.'); });
  on(el('create-room'), 'click', () => { void submit({ type: 'room.create' }); });
  on(el('join-form'), 'submit', event => {
    event.preventDefault();
    const roomId = joinCode.value.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(roomId)) { error('Проверьте код комнаты.'); return; }
    void submit({ type: 'room.join', roomId });
  });
  on(readyButton, 'click', () => {
    const room = connection.room;
    const player = room?.players.find(item => item.playerId === connection.playerId);
    if (room && player) void submit({ type: 'room.ready', roomId: room.roomId, ready: !player.ready });
  });
  on(startButton, 'click', () => {
    if (connection.room) void submit({ type: 'room.start', roomId: connection.room.roomId });
  });
  on(el('room-leave'), 'click', () => {
    if (connection.room) void submit({ type: 'room.leave', roomId: connection.room.roomId });
  });
  on(el('copy-code'), 'click', async () => {
    const notice = el('lobby-notice');
    try {
      await navigator.clipboard.writeText(roomCode.value);
      notice.textContent = 'Код комнаты скопирован.';
    } catch {
      roomCode.focus(); roomCode.select();
      notice.textContent = 'Код выделен. Нажмите Ctrl+C, чтобы скопировать.';
    }
    notice.hidden = false;
  });

  on(document, 'visibilitychange', () => { if (!document.hidden) connection.resync(); });
  on(window, 'online', () => connection.resync());

  const unsubscribe = connection.subscribe(render);
  return () => {
    abort.abort();
    unsubscribe();
    app?.destroy();
    root.replaceChildren();
  };
}
