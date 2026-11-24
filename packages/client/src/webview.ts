import { mountLocal } from './local.js';
import { mountOnline } from './online.js';
import { startPage } from './page.js';
import { WebviewClient } from './webview-client.js';
import type { ViewMessage } from './webview-bridge.js';

declare function acquireVsCodeApi(): { postMessage(message: ViewMessage): void };

const vscode = document.body.dataset.mode === 'online' ? acquireVsCodeApi() : undefined;
startPage(root => {
  if (!vscode) return mountLocal(root, false);
  const client = new WebviewClient(message => vscode.postMessage(message));
  const stop = mountOnline(root, client, false);
  return () => { stop(); client.dispose(); };
});
