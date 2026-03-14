/**
 * Native Google Workspace integration module.
 *
 * Provides direct API access to Gmail, Calendar, Drive, Docs, Sheets, and
 * Contacts using OAuth2 PKCE — no external CLI dependency required.
 *
 * The `gws` tool handler in ToolExecutor routes to GoogleService (native).
 *
 * Spec: docs/specs/NATIVE-GOOGLE-AND-INSTRUCTION-STEPS-SPEC.md
 */

export { GoogleAuth } from './google-auth.js';
export type { GoogleAuthConfig } from './google-auth.js';
export { GoogleService } from './google-service.js';
export type { GoogleServiceConfig } from './google-service.js';
export type {
  GoogleTokens,
  GoogleAuthState,
  GoogleExecuteParams,
  GoogleResult,
} from './types.js';
export type { GoogleConfig } from '../config/types.js';
export {
  GOOGLE_SERVICE_SCOPES,
  GOOGLE_SUPPORTED_SERVICES,
  GOOGLE_DEFAULT_SERVICES,
  GOOGLE_DEFAULT_CALLBACK_PORT,
} from './types.js';
