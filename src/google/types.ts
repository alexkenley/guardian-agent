/**
 * Types for native Google Workspace integration.
 *
 * The native integration uses direct API calls with OAuth 2.0 PKCE.
 *
 * Spec: docs/specs/NATIVE-GOOGLE-AND-INSTRUCTION-STEPS-SPEC.md
 */

/** OAuth token pair stored encrypted at rest. */
export interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number;
  scope: string;
}

/** Persistent auth state written to secrets.enc.json. */
export interface GoogleAuthState {
  tokens?: GoogleTokens;
  clientId?: string;
  /** When the user last completed the OAuth flow. */
  authenticatedAt?: number;
}

/** Parameters for a Google API call (mirrors GWSExecuteParams shape). */
export interface GoogleExecuteParams {
  /** Google Workspace service (e.g. 'gmail', 'drive', 'calendar'). */
  service: string;
  /** API resource (e.g. 'users messages', 'files', 'events'). */
  resource: string;
  /** Optional sub-resource. */
  subResource?: string;
  /** API method (e.g. 'list', 'get', 'send', 'create'). */
  method: string;
  /** URL/query parameters as a JSON-serializable object. */
  params?: Record<string, unknown>;
  /** Request body as a JSON-serializable object (for POST/PATCH/PUT). */
  json?: Record<string, unknown>;
  /** Output format: json (default), table, yaml, csv. */
  format?: 'json' | 'table' | 'yaml' | 'csv';
  /** Auto-paginate results. */
  pageAll?: boolean;
  /** Max pages when paginating. */
  pageLimit?: number;
}

/** Result from a Google API call (mirrors GWSResult shape). */
export interface GoogleResult {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Maps Google service names to their minimal OAuth scopes.
 * Each service uses the narrowest scope that covers the required operations.
 */
export const GOOGLE_SERVICE_SCOPES: Record<string, string> = {
  gmail: 'https://www.googleapis.com/auth/gmail.modify',
  calendar: 'https://www.googleapis.com/auth/calendar.events',
  drive: 'https://www.googleapis.com/auth/drive.file',
  docs: 'https://www.googleapis.com/auth/documents',
  sheets: 'https://www.googleapis.com/auth/spreadsheets',
  contacts: 'https://www.googleapis.com/auth/contacts.readonly',
};

/** All service names that the native integration supports. */
export const GOOGLE_SUPPORTED_SERVICES = Object.keys(GOOGLE_SERVICE_SCOPES);

/** Default services enabled when not configured. */
export const GOOGLE_DEFAULT_SERVICES = ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'contacts'];

/** Default OAuth callback port. */
export const GOOGLE_DEFAULT_CALLBACK_PORT = 18432;

/** Default max tokens for LLM instruction steps. */
export const DEFAULT_INSTRUCTION_MAX_TOKENS = 2048;
