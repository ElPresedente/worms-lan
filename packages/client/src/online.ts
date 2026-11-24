import { LIMITS, PROTOCOL_VERSION, validateClientMessage } from '#protocol';
import { mountGame } from './app.js';
import { RoomConnection, websocketAddress, type Reply } from './connection.js';
import { rejectionMessage } from './messages.js';
import type { RemoteSession } from './remote-session.js';

const seatKey = 'office-worms.match.v2';

function readSeat(): { url: string; name: string; token: string } | undefined {
  try {
    const { url, name, token } = JSON.parse(sessionStorage.getItem(seatKey) ?? 'null') ?? {};
    if (typeof url !== 'string' || typeof name !== 'string' || typeof token !== 'string') return;
    if (validateClientMessage({ protocolVersion: PROTOCOL_VERSION, type: 'hello', requestId: 'restore', resumeToken: token }).ok) {
      return { url: websocketAddress(url), name, token };
    }
  } catch { /* The game can reconnect in memory when storage is unavailable. */ }
}

function failure(reply: Reply): string {
  if (reply.type === 'error' || (reply.type === 'result' && !reply.ok)) return rejectionMessage(reply.code);
  if (reply.type === 'unknown') return 'Сервер не подтвердил действие.';
  if (reply.type === 'unavailable') return 'Соединение с сервером недоступно.';
  return '';
}

export function mountOnline(root: HTMLElement): () => void {
  root.innerHTML = `
    <div id="online-lobby">
      <header class="topbar">
        <a class="wordmark" href="./" aria-label="Office Worms — главная"><span class="brand-mark" aria-hidden="true"><i></i><i></i></span>office<span>worms</span></a>
        <a class="tool-button nav-action" href="./">Локальная игра</a>
      </header>
      <main class="lobby-content">
        <div class="lobby-heading"><h1>Сетевая игра<span>.</span></h1><p class="lobby-status" id="connection-status" role="status"></p></div>
        <section class="lobby-card" aria-label="Подключение к серверу">
          <form id="connect-form" class="lobby-form">
            <label for="server-address">Адрес сервера</label>
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
  const serverScheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  address.value = serverScheme + '://' + (window.location.hostname || '127.0.0.1') + ':4180/ws';
  joinCode.maxLength = LIMITS.maxIdLength;

  let connection: RoomConnection | undefined;
  let unsubscribe: (() => void) | undefined;
  let session: RemoteSession | undefined;
  let app: ReturnType<typeof mountGame> | undefined;
  let busy = false;
  const seat = readSeat();
  let savedToken = seat?.token;

  function error(text: string): void {
    const node = el('lobby-error');
    node.textContent = text; node.hidden = !text;
  }

  async function run(request: Parameters<RoomConnection['lobby']>[0]): Promise<string> {
    const active = connection;
    if (active?.status !== 'ready' || busy) return '';
    error('');
    busy = true;
    render();
    const reply = await active.lobby(request);
    if (abort.signal.aborted || active !== connection) return '';
    busy = false;
    render();
    return failure(reply);
  }

  async function submit(request: Parameters<RoomConnection['lobby']>[0]): Promise<void> {
    const message = await run(request);
    if (!abort.signal.aborted) error(message);
  }

  function render(): void {
    const match = connection?.match;
    const room = connection?.room;
    const status = connection?.status ?? 'disconnected';
    const connected = status === 'ready';
    const reconnecting = status === 'reconnecting';
    const pending = status === 'connecting' || reconnecting;
    const token = connection?.resumeToken;
    if (savedToken !== token) {
      savedToken = token;
      try {
        if (token) sessionStorage.setItem(seatKey, JSON.stringify({ url: address.value, name: displayName.value, token }));
        else sessionStorage.removeItem(seatKey);
      } catch { /* Saving the seat across reloads is best effort. */ }
    }
    if (session !== match) {
      app?.destroy();
      session = match;
      app = match && room ? mountGame(game, match, undefined, {
        playerId: match.playerId,
        names: new Map(room.players.map(player => [player.playerId, player.displayName])),
        leave: async () => {
          if (connection?.status === 'reconnecting') {
            connection.disconnect('Вы отменили восстановление соединения.');
            return '';
          }
          return run({ type: 'room.leave', roomId: room.roomId });
        },
        refresh: () => match.refresh(),
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
    notice.textContent = connection?.notice ?? '';
    notice.hidden = !notice.textContent;
    address.disabled = displayName.disabled = connectButton.disabled = pending || connected;
    connectButton.hidden = connected;
    connectButton.textContent = pending ? 'Подключаемся…' : 'Подключиться';
    const disconnect = el('disconnect');
    disconnect.hidden = !connected && !pending;
    disconnect.textContent = reconnecting ? 'Отменить восстановление' : 'Отключиться от сервера';
    el('room-actions').hidden = !connected || Boolean(room);
    el('room-details').hidden = !connected || !room;
    for (const id of ['create-room', 'join-room', 'room-leave']) el<HTMLButtonElement>(id).disabled = busy;
    if (!room) return;

    roomCode.value = room.roomId;
    const host = room.hostPlayerId === connection?.playerId;
    const me = room.players.find(player => player.playerId === connection?.playerId);
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

  function connect(url: string, name: string, token?: string): void {
    try {
      const next = new RoomConnection(() => new WebSocket(url), name, token ? { resumeToken: token } : {});
      unsubscribe?.();
      connection = next;
      busy = false;
      address.value = url;
      displayName.value = name;
      unsubscribe = next.subscribe(render);
    } catch {
      error('Не удалось открыть соединение. Проверьте адрес и настройки страницы.');
    }
  }

  on(el('connect-form'), 'submit', event => {
    event.preventDefault();
    if (connection && connection.status !== 'disconnected') return;
    error('');
    const name = displayName.value.trim();
    if (!name || [...name].length > LIMITS.maxDisplayNameLength || /[\u0000-\u001f\u007f]/u.test(name)) {
      error('Введите имя длиной от 1 до ' + LIMITS.maxDisplayNameLength + ' символов.');
      return;
    }
    let url: string;
    try { url = websocketAddress(address.value); }
    catch { error('Укажите WebSocket-адрес вида ws://адрес:4180/ws.'); return; }
    connect(url, name);
  });
  on(el('disconnect'), 'click', () => { error(''); connection?.disconnect('Вы отключились от сервера.'); });
  on(el('create-room'), 'click', () => { void submit({ type: 'room.create' }); });
  on(el('join-form'), 'submit', event => {
    event.preventDefault();
    const roomId = joinCode.value.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(roomId)) { error('Проверьте код комнаты.'); return; }
    void submit({ type: 'room.join', roomId });
  });
  on(readyButton, 'click', () => {
    const room = connection?.room;
    const player = room?.players.find(item => item.playerId === connection?.playerId);
    if (room && player) void submit({ type: 'room.ready', roomId: room.roomId, ready: !player.ready });
  });
  on(startButton, 'click', () => {
    if (connection?.room) void submit({ type: 'room.start', roomId: connection.room.roomId });
  });
  on(el('room-leave'), 'click', () => {
    if (connection?.room) void submit({ type: 'room.leave', roomId: connection.room.roomId });
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

  on(document, 'visibilitychange', () => { if (!document.hidden) connection?.resync(); });
  on(window, 'online', () => connection?.resync());

  if (seat) connect(seat.url, seat.name, seat.token);
  else render();
  return () => {
    abort.abort();
    unsubscribe?.();
    app?.destroy();
    connection?.disconnect();
    root.replaceChildren();
  };
}
