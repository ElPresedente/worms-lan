/** Relative import deliberately supports npm ci --workspaces=false on Windows.
 * The server and protocol packages remain siblings in this workspace deployment.
 */
export { LIMITS, PROTOCOL_VERSION, RESUME_RETENTION_MS, MAX_MATCH_COMMANDS_PER_PLAYER,
  parseClientMessage, validateServerMessage } from '../../protocol/dist/index.js';
export type {
  AddressRejection, ClientMessage, CommandResult, NetworkAction, ProtocolErrorCode, RequestFailure, Room,
  ServerMessage, SnapshotFields,
} from '../../protocol/dist/index.js';
