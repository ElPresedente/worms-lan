/** Relative import deliberately supports npm ci --workspaces=false on Windows.
 * The server and protocol packages remain siblings in this workspace deployment.
 */
export { LIMITS, PROTOCOL_VERSION, parseClientMessage, validateServerMessage } from '../../protocol/dist/index.js';
export type { ClientMessage, ServerMessage, ProtocolErrorCode } from '../../protocol/dist/index.js';
