import { mountLocal } from './local.js';
import { startPage } from './page.js';

startPage(root => mountLocal(root, false));
