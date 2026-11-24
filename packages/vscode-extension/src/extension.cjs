const { randomBytes, randomUUID } = require('node:crypto');
const vscode = require('vscode');

function gameHtml(webview, clientRoot, mode) {
  const uri = name => webview.asWebviewUri(vscode.Uri.joinPath(clientRoot, name)).toString();
  const nonce = randomBytes(16).toString('base64');
  const imports = JSON.stringify({ imports: {
    '@office-worms/game-core': uri('core/index.js'),
    '#protocol': uri('protocol/index.js'),
  } });
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Office Worms</title>
  <link rel="stylesheet" href="${uri('styles.css')}">
  <script type="importmap" nonce="${nonce}">${imports}</script>
  <script type="module" nonce="${nonce}" src="${uri('webview.js')}"></script>
</head>
<body data-mode="${mode}"><div id="app"></div><noscript>Для игры нужен JavaScript.</noscript></body>
</html>`;
}

function serverAddress() {
  return vscode.workspace.getConfiguration('officeWorms').get('serverAddress');
}

async function seatStorage(context) {
  // SecretStorage is per profile. Use the workspace's own key to keep parallel games independent.
  const stateKey = 'officeWorms.seatKey';
  let key = context.workspaceState.get(stateKey);
  if (!key) {
    key = 'officeWorms.seat.' + randomUUID();
    await context.workspaceState.update(stateKey, key).then(undefined, () => undefined);
  }
  const stored = await context.secrets.get(key).then(value => value, () => undefined);
  return {
    stored,
    save: value => value === undefined ? context.secrets.delete(key) : context.secrets.store(key, value),
  };
}

let host;

async function activate(context) {
  const { WebviewHost } = await import('../dist/host.js');
  const seat = await seatStorage(context);
  host = new WebviewHost(serverAddress(), seat.stored, seat.save);
  const clientRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'client');
  let currentPanel;
  let currentMode = 'local';

  function openGame(mode) {
    let panel = currentPanel;
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        'officeWorms.game', 'Office Worms', vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [clientRoot] },
      );
      currentPanel = panel;
      panel.onDidDispose(() => {
        host.setView();
        currentPanel = undefined;
      });
      panel.onDidChangeViewState(({ webviewPanel }) => host.setVisible(webviewPanel.visible));
      panel.webview.onDidReceiveMessage(message => { void host.receive(message); });
    } else {
      panel.reveal();
      if (mode === currentMode) return;
    }
    currentMode = mode;
    if (mode === 'online') {
      const webview = panel.webview;
      host.setView(message => { void webview.postMessage(message); }, panel.visible);
    } else {
      host.setView();
    }
    panel.webview.html = gameHtml(panel.webview, clientRoot, mode);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('officeWorms.open', () => openGame(currentMode)),
    vscode.commands.registerCommand('officeWorms.focus', () => openGame(currentMode)),
    vscode.commands.registerCommand('officeWorms.openNetwork', () => openGame('online')),
    vscode.commands.registerCommand('officeWorms.openLocal', () => openGame('local')),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('officeWorms.serverAddress')) host.setAddress(serverAddress());
    }),
    { dispose: () => currentPanel?.dispose() },
  );
}

function deactivate() {
  return host?.dispose();
}

module.exports = { activate, deactivate };
