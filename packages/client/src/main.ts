import { mountLocal } from './local.js';
import { mountOnline } from './online.js';
import { startPage } from './page.js';

startPage(root => new URLSearchParams(location.search).get('mode') === 'online' ? mountOnline(root) : mountLocal(root));
