export function startPage(mount: (root: HTMLElement) => () => void): void {
  const root = document.getElementById('app')!;
  function start(): (() => void) | undefined {
    try {
      return mount(root);
    } catch (error) {
      const message = document.createElement('p');
      message.setAttribute('role', 'alert');
      message.textContent = 'Не удалось запустить клиент: ' + String(error);
      root.replaceChildren(message);
      console.error(error);
    }
  }

  let stop = start();
  const lifetime = new AbortController();
  window.addEventListener('pagehide', event => {
    if (!event.persisted) lifetime.abort();
    stop?.();
    stop = undefined;
  }, { signal: lifetime.signal });
  window.addEventListener('pageshow', event => {
    if (event.persisted) stop = start();
  }, { signal: lifetime.signal });
}
