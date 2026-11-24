const errors: Record<string, string> = {
  'already-in-room': 'Вы уже состоите в комнате.',
  'resource-limit': 'Достигнут лимит сервера.',
  'room-not-found': 'Комната с таким кодом не найдена.',
  'room-full': 'Оба места в комнате заняты.',
  'room-not-joinable': 'Матч в этой комнате уже начался.',
  'room-not-in-lobby': 'Матч в этой комнате уже запущен.',
  'not-in-room': 'Вы больше не в этой комнате.',
  'not-host': 'Только создатель комнаты может запустить матч.',
  'players-not-ready': 'Для запуска нужны два готовых игрока.',
  'match-not-found': 'Матч ещё не начался или уже закрыт.',
  'match-mismatch': 'Эта команда относится к другой партии.',
  'wrong-player': 'Сейчас ход соперника.',
  'wrong-phase': 'Сейчас это действие недоступно.',
  'invalid-action': 'Действие нельзя выполнить в текущем положении.',
  'game-finished': 'Партия уже завершилась.',
  'rate-limited': 'Слишком много запросов. Попробуйте чуть позже.',
  'invalid-message': 'Проверьте введённые данные.',
  'not-implemented': 'На этом сервере недоступны сетевые комнаты.',
  'internal-error': 'Сервер не смог обработать запрос.',
  'command-id-conflict': 'Номер команды уже использован для другого действия.',
};

export function rejectionMessage(code: string): string {
  return Object.hasOwn(errors, code) ? errors[code]! : 'Сервер отклонил запрос (' + code + ').';
}
