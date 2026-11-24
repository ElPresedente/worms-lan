# Сетевой контракт v2

Контракт M3 включает восстановление места, сохранённые результаты команд и нумерацию обновлений.
Примеры основных обменов собраны в [examples/exchanges.json](examples/exchanges.json).

## Транспорт и версии

WebSocket, endpoint `/ws`. Одна текстовая message = один UTF-8 JSON-объект.
Массивы сообщений, binary, сжатие и дельты не используются. Фрагменты собирает
транспорт с проверкой общего размера. `ws://` для доверенной LAN, `wss://` для HTTPS-хоста.
S0 проверяет Origin по явному списку разрешённых browser/webview origins.
По умолчанию сервер слушает localhost; LAN включается настройкой запуска.
SSE dev-сервера остаётся только для live reload.

Каждое сообщение имеет `protocolVersion: 2` и `type`. Версия проверяется до payload.
При несовместимости сервер отвечает `unsupported-version` с protocolVersion=2 и закрывает сокет с кодом 1008.
Неизвестные поля и типы отклоняются. Несовместимые изменения требуют новой версии.
`GameState.version` — независимая версия снимка ядра. Сейчас она тоже равна 1.
Неизвестная версия снимка останавливает применение обновлений на клиенте.

## ID и порядок

| Поле | Назначение |
| --- | --- |
| connectionId | Сервер назначает каждому новому соединению, в том числе при восстановлении |
| playerId | Сервер назначает игроку и сохраняет при восстановлении места |
| roomId / matchId | Разные серверные ID комнаты и партии, уникальны до рестарта |
| requestId | Клиентский ID запроса, уникален в пределах соединения |
| commandId | ID game.command, уникален для игрока в рамках матча |
| roomRevision | 1 при создании, +1 при изменении состояния комнаты, включая подключение игроков |
| revision | 0 при создании матча, +1 на принятый dispatch или изменивший состояние step |
| updateSequence | 0 для первой рассылки, +1 для каждой следующей рассылки game.update |

ID — непрозрачные строки `[A-Za-z0-9_-]{1,64}`, с учётом регистра.
Счётчики — неотрицательные safe integers. Переполнение завершает матч/соединение,
не обнуляет счётчик. tick — время симуляции, не revision: dispatch не вызывает step.
Одна очередь комнаты последовательно обрабатывает запросы, тики и отключения.
Порядок сообщений сохраняется внутри соединения; глобального порядка комнат нет.

requestId хранится до закрытия соединения. Повтор даёт `duplicate-id` без обработки.
Максимум 100000 запросов на соединение, затем `resource-limit` и close 1008.
Повтор с новым requestId и тем же commandId возвращает сохранённый `command.result` с исходной revision,
если адрес матча и параметры действия совпадают. Другие параметры для того же commandId дают `command-id-conflict`.
Сервер хранит принятые команды и отказы ядра до удаления матча, до 4096 записей на игрока.
После исчерпания лимита новые команды возвращают `resource-limit`, сохранённые результаты доступны.

## Handshake и комната

Первое сообщение в течение 5 секунд — `hello` с requestId и одним из полей `displayName` или `resumeToken`.
Имя после trim: 1..32 Unicode code points, без U+0000..001F/U+007F; показывается как текст.
Ответ welcome содержит requestId, connectionId, playerId, нормализованное displayName,
serverTimeMs и limits (все значения таблицы лимитов ниже). serverTimeMs — Unix milliseconds.
До welcome другие запросы → handshake-required; второй hello → already-initialized.
Таймаут hello → close 1008. Имя можно исправить в пределах исходных 5 секунд.

Игровой сервер выдаёт `resumeToken` в приватном успешном ответе на `room.create` или `room.join`.
Токен состоит из 32 случайных байт в base64url без padding. Его привязка срабатывает для начатых
и завершённых матчей. Успешный `hello` с токеном восстанавливает прежний playerId и получает новый connectionId.
В `welcome.resumed` сервер возвращает `room` и полный `snapshot` без исторических событий.
Публичные сообщения комнаты и матча, журналы и URL не содержат токена.
Если старое соединение ещё активно, сервер отвечает `resume-in-use`. Неизвестное, истёкшее или закрытое место даёт `resume-unavailable`.

Один игрок состоит в одной комнате. Два места, без наблюдателей; доступ по roomId,
без пароля/discovery. Создатель — хост. Идентичность соединения не является учётной записью.
Room: `{roomId, roomRevision, hostPlayerId, status, players, matchId}`.
status: lobby | playing | finished; matchId: ID или null.
players: упорядоченный массив 1..2 объектов `{playerId, displayName, ready, connected}`.
Порядок мест соответствует GameState.players, первый ход получает хост.

## Запросы и ответы

Все запросы содержат protocolVersion/type/requestId. Кроме hello — только после welcome.
Поля в таблице указаны дополнительно. Ответ получает инициатор, broadcast — участники.

| type | Поля | Успех | Отказы предметной области |
| --- | --- | --- | --- |
| room.create | нет | result с room и resumeToken | already-in-room, resource-limit |
| room.join | roomId | result с room и resumeToken | room-not-found, room-full, room-not-joinable, already-in-room |
| room.leave | roomId | result | not-in-room |
| room.ready | roomId, ready: boolean | result с room | not-in-room, room-not-in-lobby |
| room.start | roomId | result с matchId, revision: 0 | not-in-room, not-host, room-not-in-lobby, players-not-ready |
| game.command | roomId, matchId, commandId, action | command.result | not-in-room, match-not-found, match-mismatch; отказы ядра |
| game.snapshot | roomId, matchId | game.snapshot | not-in-room, match-not-found, match-mismatch |

Успешный result содержит `{requestId, requestType, ok: true, room?, matchId?, revision?, resumeToken?}`.
Поля успеха зависят от строки таблицы. Отказ лобби или game.snapshot:
`result {requestId, requestType, ok: false, code}` без изменения состояния.
После изменения лобби: result инициатору → room.state `{room}` всем оставшимся,
включая только что вошедшего. Вышедший получает только result, затем обновлений нет.
Повтор того же ready успешен без roomRevision/broadcast. При смене состава готовность
сбрасывается. Ушедший хост лобби передаёт роль оставшемуся; пустая комната удаляется.
Start разрешён хосту при двух подключённых готовых игроках. Одновременные join/start
обрабатываются последовательно с повторной проверкой условий.

Start использует серверную карту 320×180, земля с y=112, 100 HP, ветер 0, ход 60 секунд.
Клиент не присылает GameOptions/terrain/spawn. Ошибка createGame → error/internal-error,
без частично созданного матча. Успех: result → room.state playing (ready обоих false) →
game.update revision 0 с waiting и events: []. Первый turn-ready не обязателен.
При завершении сервер публикует `game.update` с finished, затем `room.state` с итоговым статусом.

После разрыва в playing или finished сервер публикует `room.state` с `connected: false` и сохраняет место 10 минут.
Сервер сбрасывает удерживаемое направление отключившегося игрока. Активный ход и resolving продолжаются,
а waiting ждёт начала хода. При восстановлении сервер публикует `connected: true`.
Явный выход через `room.leave` и истечение срока удаляют комнату, матч и оба токена.
Оставшемуся приходит `room.closed {roomId, matchId, reason}` с `player-left` при выходе и `player-disconnected` при истечении срока.
В лобби разрыв сразу освобождает место. Рестарт сервера удаляет состояние из памяти.

## Игровые команды и асинхронный клиент

В action разрешены только поля таблицы. playerId запрещён и в action, и в envelope.
Сервер проверяет членство и matchId, затем создаёт Action ядра:
`{...action, playerId: session.playerId}`. Клиент не может управлять соперником.

| action.type | Остальные поля |
| --- | --- |
| start-turn | нет |
| move | direction: -1, 0 или 1 |
| jump | нет |
| fire | angleDegrees: конечное число 0..180, power: конечное число 0..1 |
| end-turn | нет |

Углы: 0 вправо, 90 вверх, 180 влево. Семантика действий полностью принадлежит ядру.
command.result: `{requestId, commandId, matchId, accepted, revision, rejection?}`.
Успех: accepted=true, revision принятого перехода, без rejection.
Отказ ядра: accepted=false, текущая revision, rejection:
game-finished | wrong-player | wrong-phase | invalid-action; без update.
Отказ адресации: accepted=false, revision=null, matchId из запроса, rejection:
not-in-room | match-not-found | match-mismatch.
Сначала command.result инициатору, затем update всем. Подтверждение означает применение,
а не конец полёта/хода; update может объединять несколько принятых переходов.

`GameSession.command` возвращает `Promise<CommandOutcome>`. Таймаут в 5 секунд даёт
unknown, а сервер продолжает обработку уже полученной команды. Клиент уточняет состояние снимком.
Ответ привязан к requestId, а подтверждение команды дополнительно проверяется по commandId.
fire/jump/start-turn/end-turn заблокированы до отказа, снимка с принятой revision или уточнения неизвестного исхода.
Для move допускаются два pending, чтобы остановка не ждала первого подтверждения;
неотправленные промежуточные направления объединяются в последнее.
На blur/visibilitychange отправляется move=0 своего активного игрока.
Направление действует до команды остановки, конца хода или разрыва соединения.
RemoteSession использует снимки и серверный playerId. LocalSession реализует тот же интерфейс поверх ядра.

## Снимки, события, часы

`game.update` содержит `{roomId, matchId, revision, updateSequence, serverTimeMs, state, events}`.
Ответ `game.snapshot` содержит те же поля и requestId. В `game.snapshot` и `welcome.resumed.snapshot`
events пуст, а updateSequence указывает последнюю рассылку для этого матча.
state — полный JSON GameState версии 1: все поля обязательны, terrain.cells —
row-major 0/1, x вправо, y вниз. Без токенов/секретов. state.players совпадает
с местами комнаты; worm.playerId входит в players, ID червей уникальны.
P1 проверяет все вложенные поля и инварианты, а не только type/version.
Координаты/скорости конечны, модуль ≤1000000; health 0..1000, wind -30..30,
turnDurationTicks 60..18000, turnTicksRemaining 0..turnDurationTicks,
activePlayerIndex 0..1. Остальные счётчики — safe integers ≥0.
Nullable и enum (phase, pendingTurnEnd, causes) точно соответствуют типам ядра.
Клиент никогда не присылает state как команду.

Сервер шагает 60 Гц; waiting/finished не продвигают время симуляции.
Полные updates не чаще 10 Гц на матч, включая команды/смену фаз, кроме первого снимка.
Состояние и все накопленные события доставляются в следующем слоте (≤100 мс),
даже при остановке тиков в waiting/finished. Максимум 128 событий за слот.
При переполнении буфера событий сервер завершает матч с close 1013. При переполнении очереди сокета
закрывается соединение медленного клиента с close 1013. Он может восстановить матч полным снимком.

events — GameEvent ядра в порядке dispatch/step с предыдущего update матча;
снимок по запросу не очищает broadcast-буфер. События дают эффекты/журнал,
снимок определяет карту, HP, очередь, таймер и результат.
Эффект идентифицируется по `(matchId, updateSequence, index)`. Клиент отбрасывает устаревшие
и повторные обновления. Пропуск revision нормален из-за пакетирования тиков. Пропуск updateSequence
означает потерю рассылки. Клиент применяет свежий полный снимок и запрашивает `game.snapshot`
для уточнения состояния. При восстановлении сравнение начинается с последовательности из `welcome.resumed.snapshot`.
Таймер = turnTicksRemaining / 60, визуально можно учитывать elapsed от serverTimeMs;
клиент не завершает ход и не меняет phase самостоятельно. В waiting таймера нет.

## Ошибки и лимиты

error: `{requestId: string | null, code, message}` — ошибка формата/протокола или сбой.
Если корректный requestId извлечь нельзя, он null. При duplicate-id клиент не завершает
исходный pending по этому error. message ≤256 code points, без stack trace/кадра/секретов;
решения принимаются по code. Неизвестный/невалидный ввод не передаётся ядру/UI.

| error.code | Поведение |
| --- | --- |
| invalid-json, invalid-message, unknown-type, unsupported-state-version | Отбросить сообщение |
| unsupported-version | error версии 2, close 1008 |
| handshake-required, already-initialized, duplicate-id | Без изменения состояния |
| resume-in-use | Место ещё связано с активным соединением, повтор можно отложить |
| resume-unavailable | Состояние для данного токена недоступно |
| command-id-conflict | ID уже привязан к действию с другими параметрами |
| message-too-large | close 1009; error только если транспорт позволяет |
| rate-limited | Без изменения; непрерывное превышение 5 с → close 1008 |
| resource-limit | Отказ; исчерпание ID соединения → close 1008 |
| not-implemented | Экземпляр транспорта S0 без обработчика комнат/матча отклоняет запрос |
| internal-error | Без деталей; неизвестная целостность состояния → close 1011 |

После проверки формы резервируется requestId. Ошибка JSON, версии, размера или формы
не резервирует ID. ID первого hello тоже учитывается. Игровой сервер ведёт commandId отдельно по месту и матчу.

| Поле welcome.limits | Значение v2 |
| --- | --- |
| maxClientMessageBytes | 4096 UTF-8 до JSON.parse |
| maxServerMessageBytes | 262144 UTF-8 после сериализации |
| maxOutgoingQueueBytes | 1048576 на соединение |
| maxIdLength / maxDisplayNameLength | 64 / 32 |
| maxPlayersPerRoom / maxRooms / maxConnections | 2 / 32 / 64 |
| maxRequestsPerConnection | 100000 |
| maxMapWidth / maxMapHeight / maxMapCells | 320 / 180 / 57600; минимум сторон 32 |
| maxEventsPerUpdate / maxMessageDepth | 128 / 16 (корень на глубине 1) |
| clientMessagesPerSecond / clientMessageBurst | token bucket 30/с, ёмкость 60, начально полный |
| snapshotRequestsPerSecond / snapshotRequestBurst | дополнительный bucket 1/с, ёмкость 2 |
| snapshotHz / tickHz | 10 / 60 |
| handshakeTimeoutMs / requestTimeoutMs | 5000 / 5000 |

Непрерывная перегрузка определяется как хотя бы один отказ в каждую секунду в течение пяти секунд.
S0 ограничивает очередь асинхронного обработчика 60 запросами (включая выполняемый) / 245760 байт;
при переполнении — resource-limit и close 1013.
Общий bucket включает hello, неверные и неизвестные сообщения; snapshot bucket дополнительно
для корректных game.snapshot. Значения v2 фиксированы, welcome не расширяет лимиты клиента.
Сетевые карты меньше лимита ядра 2048×1024 из-за стоимости полных снимков.
Неверные enum/NaN/Infinity, дробные счётчики, лишние поля, неверный cells.length,
ссылки на отсутствующих игроков отклоняются P1 на соответствующей границе.

## Проверка контракта

P1 использует JSON-примеры как fixtures обеих границ и добавляет негативные проверки.
S0/S1+C2: hello → create/join → ready → start → command/result/update → finished;
чужой ход, отказ ядра, повтор ID, лимиты, одновременные join/start, разрыв/скрытие вкладки.
P2/S2/C3 проверяют возврат во время полёта и после победы, повтор с сохранённым результатом,
истечение резерва места и восстановление после пропуска обновлений.
