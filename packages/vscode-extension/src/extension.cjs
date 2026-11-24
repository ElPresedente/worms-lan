const { randomBytes } = require('node:crypto');
const vscode = require('vscode');

function gameHtml(webview, clientRoot) {
  const uri = name => webview.asWebviewUri(vscode.Uri.joinPath(clientRoot, name)).toString();
  const nonce = randomBytes(16).toString('base64');
  const imports = JSON.stringify({ imports: { '@office-worms/game-core': uri('core/index.js') } });
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
<body><div id="app"></div><noscript>Для игры нужен JavaScript.</noscript></body>
</html>`;
}

function activate(context) {
  const clientRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'client');
  let currentPanel;

  function openGame() {
    if (currentPanel) {
      currentPanel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'officeWorms.game', 'Office Worms', vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [clientRoot] },
    );
    currentPanel = panel;
    panel.onDidDispose(() => { currentPanel = undefined; });
    panel.webview.html = gameHtml(panel.webview, clientRoot);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('officeWorms.open', openGame),
    vscode.commands.registerCommand('officeWorms.focus', openGame),
    { dispose: () => currentPanel?.dispose() },
  );
}

module.exports = { activate };
