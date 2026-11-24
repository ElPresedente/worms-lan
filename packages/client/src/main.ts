import { mountLocal } from './local.js';
import { mountBrowserOnline } from './browser-online.js';
import { startPage } from './page.js';

startPage(root => new URLSearchParams(location.search).get('mode') === 'online' ? mountBrowserOnline(root) : mountLocal(root));
