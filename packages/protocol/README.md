# protocol

`@office-worms/protocol` — общий TypeScript-контракт и runtime-проверки сетевой партии.
P0/P1 готовы. [Спецификация v1](SPEC.md) задаёт формат; [ROADMAP](ROADMAP.md) — следующие этапы.

Пакет не использует Node.js, DOM, WebSocket API или сторонние runtime-библиотеки.
Типы Action/GameState/GameEvent импортируются из game-core через `import type`;
сборка работает и без workspace-ссылок. Ядро не загружается при импорте JS-пакета.

## API

```ts
import {
  parseClientMessage, parseServerMessage,
  validateClientMessage, validateServerMessage, LIMITS,
} from '@office-worms/protocol';

const result = parseClientMessage(rawText); // unknown → ValidationResult<ClientMessage>
if (!result.ok) {
  // error: {code, path, message, requestId}. Без исключения и содержимого кадра.
  // S0 выбирает ответ/close по SPEC.md. Невалидное сообщение не передаётся ядру.
} else if (result.value.type === 'game.command') {
  const command = result.value;
  // S0/S1 проверяет handshake/членство/ID, затем подставляет session.playerId.
  // dispatch(state, {...command.action, playerId: session.playerId});
}

// Граница клиента, дополнительно сверяем снимок с уже известной комнатой:
const incoming = parseServerMessage(serverText, { room: currentRoom });
if (incoming.ok) {
  // C2 применяет актуальные revision текущего matchId и завершает pending-запросы.
}

// Уже разобранный JSON или исходящий DTO проверяются теми же схемами:
const checked = validateServerMessage(candidate);
// validateClientMessage(candidate) — симметричная проверка.
```

Все четыре функции возвращают `{ok: true, value}` или `{ok: false, error}`.
Принимают unknown; парсеры допускают только строку, проверяют её UTF-8-размер до JSON.parse.
Валидаторы проверяют JSON-совместимость, размер сериализации, глубину, точные поля/типы,
числа/enum/строки/массивы, всю карту/червей/снаряд/события, фазы, таймер и ссылки на игроков.
На успешном результате возвращается тот же объект, без клонирования/нормализации;
потребитель не должен менять уже проверенные сообщения до обработки.
Присланное имя валидируется после trim, сервер сохраняет `displayName.trim()`;
welcome/Room требуют уже нормализованное имя.

Экспорты типов: ClientMessage, ServerMessage, NetworkAction, Room, RoomPlayer,
CommandResult, SnapshotFields, RequestSuccess/RequestFailure, ValidationResult,
ValidationError, ValidationContext, Limits и коды отказов.
Константы: PROTOCOL_VERSION, STATE_VERSION, LIMITS, PROTOCOL_ERROR_CODES,
CORE_REJECTIONS, ADDRESS_REJECTIONS, REQUEST_REJECTIONS.

Ошибки формата возвращаются как ValidationError; игровые отказы — валидные
command.result accepted=false. Отказы лобби — result ok=false, а не ошибки парсинга.
При невозможности извлечь корректный requestId error.requestId равен null.

Проверки статичны: handshake, очередь команд, повтор ID, token bucket, timeout,
текущая revision, серверное время и очередь исходящих байтов исполняются в S0/S1/C2/P2.
Context.room проверяет roomId/matchId/порядок игроков только для снимков; это не авторизация.
Пакет не отправляет сообщения, не закрывает сокеты и не запускает симуляцию.

## Проверка

Из корня проекта:

```sh
npm run build
npm test
npm test --workspace=@office-worms/protocol
```

Если Windows запрещает workspace-ссылки (EPERM), используйте `npm ci --workspaces=false`.
Общие build/test и тест пакета через --workspace работают без ссылок. В таком режиме
ручной Node.js-импорт выполняется по пути `./packages/protocol/dist/index.js` из корня;
импорт по имени @office-worms/protocol требует установленной workspace-ссылки.

Сборка выпускает ESM и .d.ts в dist. Тесты проверяют все JSON-обмены P0,
негативные примеры, обе границы, UTF-8-лимиты, повреждённые снимки,
подмену playerId, варианты отказов, реальные переходы ядра до finished и timeout.
TypeScript-проверка тестирует запрет playerId в NetworkAction и сужение union-результатов.
Сеть и визуальная приёмка — S0/S1/C2.
