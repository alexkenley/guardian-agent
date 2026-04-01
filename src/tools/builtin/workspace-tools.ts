import type { GoogleService } from '../../google/google-service.js';
import type { MicrosoftService } from '../../microsoft/microsoft-service.js';
import { ToolRegistry } from '../registry.js';
import type { ToolExecutionRequest } from '../types.js';

interface WorkspaceToolRegistrarContext {
  registry: ToolRegistry;
  requireString: (value: unknown, field: string) => string;
  asString: (value: unknown, fallback?: string) => string;
  asNumber: (value: unknown, fallback: number) => number;
  guardAction: (request: ToolExecutionRequest, action: string, details: Record<string, unknown>) => void;
  getGoogleService: () => GoogleService | undefined;
  getMicrosoftService: () => MicrosoftService | undefined;
}

export function registerBuiltinWorkspaceTools(context: WorkspaceToolRegistrarContext): void {
  context.registry.register(
    {
      name: 'gws',
      description:
        'Execute a Google Workspace API call (Gmail, Calendar, Drive, Docs, Sheets). ' +
        'Supports direct API calls with OAuth 2.0 PKCE. ' +
        'AUTHENTICATION IS AUTOMATIC. Do NOT ask the user for an access token or credentials. ' +
        'IMPORTANT: resource uses spaces (not dots) for nested paths. ' +
        'Common calls:\n' +
        '  List emails:    service="gmail", resource="users messages", method="list", params={"userId":"me","maxResults":10}\n' +
        '  Read email:     service="gmail", resource="users messages", method="get", params={"userId":"me","id":"MESSAGE_ID","format":"full"}\n' +
        '  Send email:     service="gmail", resource="users messages", method="send", params={"userId":"me"}, json={"raw":"BASE64_RFC822"}\n' +
        '  List events:    service="calendar", resource="events", method="list", params={"calendarId":"primary"}\n' +
        '  Create event:   service="calendar", resource="events", method="create", params={"calendarId":"primary"}, json={"summary":"Meeting","start":{"dateTime":"..."},"end":{"dateTime":"..."}}\n' +
        '  List files:     service="drive", resource="files", method="list", params={"pageSize":10}\n' +
        '  Search files:   service="drive", resource="files", method="list", params={"q":"name contains \'report\'"}\n' +
        '  Create file:    service="drive", resource="files", method="create", json={"name":"My Doc","mimeType":"application/vnd.google-apps.document"}\n' +
        '  Get file:       service="drive", resource="files", method="get", params={"fileId":"FILE_ID"}\n' +
        '  Update file:    service="drive", resource="files", method="update", params={"fileId":"FILE_ID"}, json={"name":"New Name"}\n' +
        '  Delete file:    service="drive", resource="files", method="delete", params={"fileId":"FILE_ID"}\n' +
        '  Update sheet:   service="sheets", resource="spreadsheets values", method="update", params={"spreadsheetId":"SHEET_ID","range":"Sheet1!A1:B2","valueInputOption":"USER_ENTERED"}, json={"values":[["Header1","Header2"],["val1","val2"]]}\n' +
        'CRITICAL: Resource IDs (fileId, spreadsheetId, documentId, messageId, etc.) MUST go in params, never in json. ' +
        'The json field is only for the request body (data to create or update). ' +
        'Use gws_schema to discover all available methods and parameters.',
      shortDescription: 'Execute a Google Workspace API call (Gmail, Calendar, Drive, etc.).',
      risk: 'network',
      category: 'workspace',
      deferLoading: true,
      examples: [
        { input: { service: 'gmail', method: 'list', resource: 'users messages', params: { userId: 'me', q: 'from:boss@company.com newer_than:7d' } }, description: 'List recent emails from a specific sender' },
        { input: { service: 'calendar', method: 'list', resource: 'events', params: { calendarId: 'primary', timeMin: '2026-03-01T00:00:00Z' } }, description: 'List calendar events from a date' },
        { input: { service: 'drive', method: 'create', resource: 'files', json: { name: 'Meeting Notes', mimeType: 'application/vnd.google-apps.document' } }, description: 'Create a Google Doc in Drive' },
        { input: { service: 'drive', method: 'update', resource: 'files', params: { fileId: 'abc123' }, json: { name: 'Renamed Document' } }, description: 'Rename a Drive file (fileId in params, new name in json)' },
        { input: { service: 'sheets', method: 'update', resource: 'spreadsheets values', params: { spreadsheetId: 'abc123', range: 'Sheet1!A1:B2', valueInputOption: 'USER_ENTERED' }, json: { values: [['Name', 'Score'], ['Alice', '95']] } }, description: 'Write data to a Google Sheet' },
      ],
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Google Workspace service: gmail, calendar, drive, docs, sheets, tasks, people, etc.' },
          resource: { type: 'string', description: 'API resource path with spaces for nesting. Gmail: "users messages", "users labels", "users drafts". Calendar: "events", "calendarList". Drive: "files". Docs: "documents". Sheets: "spreadsheets".' },
          subResource: { type: 'string', description: 'Optional sub-resource (e.g. "attachments").' },
          method: { type: 'string', description: 'API method: list, get, create, update, delete, send, etc.' },
          params: { type: 'object', description: 'URL/path/query parameters — includes resource IDs (fileId, spreadsheetId, documentId, calendarId, userId) and query filters. Gmail requires {"userId":"me"}. Drive get/update/delete requires {"fileId":"..."}. Sheets requires {"spreadsheetId":"..."}.' },
          json: { type: 'object', description: 'Request body as JSON (for create/update/send methods). Contains the data to create or modify — NOT resource IDs. IDs go in params.' },
          format: { type: 'string', enum: ['json', 'table', 'yaml', 'csv'], description: 'Output format. Default: json.' },
          pageAll: { type: 'boolean', description: 'Auto-paginate all results.' },
          pageLimit: { type: 'number', description: 'Max pages when using pageAll.' },
        },
        required: ['service', 'resource', 'method'],
      },
    },
    async (args, request) => {
      const service = context.requireString(args.service, 'service').toLowerCase();
      const resource = context.requireString(args.resource, 'resource');
      const method = context.requireString(args.method, 'method');

      const isWrite = /\b(create|insert|update|patch|delete|send|remove|modify)\b/i.test(method);
      const actionType = service === 'gmail' && /send/i.test(method)
        ? 'send_email'
        : service === 'gmail'
          ? (isWrite ? 'draft_email' : 'read_email')
          : service === 'calendar'
            ? (isWrite ? 'write_calendar' : 'read_calendar')
            : service === 'drive'
              ? (isWrite ? 'write_drive' : 'read_drive')
              : service === 'docs'
                ? (isWrite ? 'write_docs' : 'read_docs')
                : service === 'sheets'
                  ? (isWrite ? 'write_sheets' : 'read_sheets')
                  : 'mcp_tool';

      const googleSvc = context.getGoogleService();

      context.guardAction(request, actionType, {
        service,
        resource,
        method,
        provider: 'google-native',
      });

      if (!googleSvc?.isServiceEnabled(service)) {
        return {
          success: false,
          error: 'Google Workspace is not enabled or not connected. Enable it in Settings > Google Workspace.',
        };
      }

      let params = args.params as Record<string, unknown> | undefined;
      let json = (args.json ?? args.body) as Record<string, unknown> | undefined;

      const PATH_PARAM_KEYS = new Set([
        'fileId', 'spreadsheetId', 'documentId', 'userId', 'calendarId',
        'messageId', 'id', 'eventId', 'labelId', 'threadId', 'draftId',
        'resourceName', 'pageSize', 'maxResults', 'pageToken', 'q', 'orderBy',
        'fields', 'timeMin', 'timeMax', 'format', 'range', 'valueInputOption',
        'includeSpamTrash', 'showDeleted', 'singleEvents',
      ]);
      const BODY_FIELD_KEYS = new Set([
        'name', 'mimeType', 'summary', 'description', 'location',
        'start', 'end', 'attendees', 'recurrence', 'reminders',
        'raw', 'message', 'labelIds', 'addLabelIds', 'removeLabelIds',
        'values', 'requests', 'title', 'body', 'content', 'parents',
        'resource',
      ]);

      if (params && /\b(create|update|patch|send|insert|copy|move|import)\b/i.test(method)) {
        const misplaced: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(params)) {
          if (BODY_FIELD_KEYS.has(key) && !PATH_PARAM_KEYS.has(key)) {
            misplaced[key] = val;
          }
        }
        if (Object.keys(misplaced).length > 0) {
          if (misplaced.resource && typeof misplaced.resource === 'object' && !Array.isArray(misplaced.resource)) {
            json = { ...(json ?? {}), ...(misplaced.resource as Record<string, unknown>) };
            delete misplaced.resource;
          }
          if (Object.keys(misplaced).length > 0) {
            json = { ...(json ?? {}), ...misplaced };
          }
          params = { ...params };
          for (const key of Object.keys(misplaced)) delete params[key];
          if ('resource' in params) delete params.resource;
          if (Object.keys(params).length === 0) params = undefined;
        }
      }

      if (json) {
        const idMoves: Record<string, unknown> = {};
        for (const key of PATH_PARAM_KEYS) {
          if (key in json) {
            idMoves[key] = json[key];
          }
        }
        if (Object.keys(idMoves).length > 0) {
          params = { ...(params ?? {}), ...idMoves };
          json = { ...json };
          for (const key of Object.keys(idMoves)) delete json[key];
          if (Object.keys(json).length === 0) json = undefined;
        }
      }

      const execParams = {
        service,
        resource,
        subResource: args.subResource ? context.asString(args.subResource) : undefined,
        method,
        params,
        json,
        format: args.format as 'json' | 'table' | 'yaml' | 'csv' | undefined,
        pageAll: args.pageAll === true,
        pageLimit: args.pageLimit ? context.asNumber(args.pageLimit, 10) : undefined,
      };

      const result = await googleSvc.execute(execParams);

      return {
        success: result.success,
        output: result.data,
        error: result.error,
      };
    },
  );

  context.registry.register(
    {
      name: 'gws_schema',
      description:
        'Look up the API schema for a Google Workspace service method. ' +
        'Returns available parameters, request body fields, and descriptions. ' +
        'Use this to discover how to call a specific API. ' +
        'Schema path format: service.resource.method (e.g. "gmail.users.messages.list", "drive.files.get").',
      shortDescription: 'Look up API schema for a Google Workspace service/method.',
      risk: 'read_only',
      category: 'workspace',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          schemaPath: {
            type: 'string',
            description: 'Dotted schema path: service.resource.method (e.g. "gmail.users.messages.list").',
          },
        },
        required: ['schemaPath'],
      },
    },
    async (args, request) => {
      const schemaPath = context.requireString(args.schemaPath, 'schemaPath');
      context.guardAction(request, 'read_docs', { path: `gws:schema:${schemaPath}` });

      const googleSvc = context.getGoogleService();
      if (!googleSvc) {
        return {
          success: false,
          error: 'Google Workspace is not enabled. Enable it in Settings > Google Workspace.',
        };
      }

      const result = await googleSvc.schema(schemaPath);
      return {
        success: result.success,
        output: result.data,
        error: result.error,
      };
    },
  );

  context.registry.register(
    {
      name: 'outlook_draft',
      description: 'Create one plain-text Outlook draft using the configured Microsoft 365 connection. Authentication is automatic. Mutating — requires approval outside autonomous mode. Requires draft_email capability.',
      shortDescription: 'Create one Outlook draft with automatic Microsoft auth.',
      risk: 'mutating',
      category: 'email',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
    async (args, request) => {
      const to = context.requireString(args.to, 'to');
      const subject = context.requireString(args.subject, 'subject');
      const body = context.requireString(args.body, 'body');
      const msService = context.getMicrosoftService();
      if (!msService) {
        return { success: false, error: 'Microsoft 365 is not enabled. Enable it in Settings > Microsoft 365.' };
      }

      context.guardAction(request, 'draft_email', { to, subject, provider: 'outlook' });

      const drafted = await msService.createOutlookDraft({ to, subject, body });
      return {
        success: drafted.success,
        output: drafted.data,
        error: drafted.error,
      };
    },
  );

  context.registry.register(
    {
      name: 'outlook_send',
      description: 'Send one email via the configured Microsoft 365 Outlook connection. Authentication is automatic. Security: graph.microsoft.com must be in allowedDomains. external_post risk — always requires manual approval. Requires send_email capability.',
      shortDescription: 'Send one email through Outlook with automatic Microsoft auth.',
      risk: 'external_post',
      category: 'email',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
    async (args, request) => {
      const to = context.requireString(args.to, 'to');
      const subject = context.requireString(args.subject, 'subject');
      const body = context.requireString(args.body, 'body');
      const msService = context.getMicrosoftService();
      if (!msService) {
        return { success: false, error: 'Microsoft 365 is not enabled. Enable it in Settings > Microsoft 365.' };
      }

      context.guardAction(request, 'send_email', { to, subject, provider: 'outlook' });

      const sent = await msService.sendOutlookMessage({ to, subject, body });
      return {
        success: sent.success,
        output: sent.data,
        error: sent.error,
      };
    },
  );

  context.registry.register(
    {
      name: 'm365',
      description:
        'Execute a Microsoft Graph API call (Outlook Mail, Calendar, OneDrive, Contacts). ' +
        'Uses direct REST calls with OAuth 2.0 PKCE. ' +
        'AUTHENTICATION IS AUTOMATIC. Do NOT ask the user for an access token or credentials. ' +
        'IMPORTANT: resource paths use forward slashes (e.g. me/messages, me/events). ' +
        'Common calls:\n' +
        '  List emails:    service="mail", resource="me/messages", method="list", params={"$top":10,"$select":"subject,from,receivedDateTime"}\n' +
        '  Read email:     service="mail", resource="me/messages", method="get", id="MESSAGE_ID"\n' +
        '  Send email:     service="mail", resource="me/sendMail", method="create", json={"message":{"subject":"Hi","body":{"contentType":"Text","content":"Hello"},"toRecipients":[{"emailAddress":{"address":"user@example.com"}}]}}\n' +
        '  List events:    service="calendar", resource="me/events", method="list", params={"$top":10}\n' +
        '  Create event:   service="calendar", resource="me/events", method="create", json={"subject":"Meeting","start":{"dateTime":"...","timeZone":"UTC"},"end":{"dateTime":"...","timeZone":"UTC"}}\n' +
        '  List files:     service="onedrive", resource="me/drive/root/children", method="list"\n' +
        '  Search files:   service="onedrive", resource="me/drive/root/search(q=\'report\')", method="list"\n' +
        '  List contacts:  service="contacts", resource="me/contacts", method="list", params={"$top":10}\n' +
        'CRITICAL: Resource IDs go in the id parameter, NOT in the resource path. ' +
        'OData query params ($filter, $select, $top, $orderby) go in params. ' +
        'Request bodies go in json. ' +
        'Use m365_schema to discover available endpoints and parameters.',
      shortDescription: 'Execute a Microsoft Graph API call (Outlook, Calendar, OneDrive, etc.).',
      risk: 'network',
      category: 'workspace',
      deferLoading: true,
      examples: [
        { input: { service: 'mail', method: 'list', resource: 'me/messages', params: { $top: 10, $orderby: 'receivedDateTime desc' } }, description: 'List recent emails' },
        { input: { service: 'calendar', method: 'list', resource: 'me/events', params: { $top: 10, $select: 'subject,start,end' } }, description: 'List upcoming calendar events' },
        { input: { service: 'onedrive', method: 'list', resource: 'me/drive/root/children' }, description: 'List files in OneDrive root' },
        { input: { service: 'calendar', method: 'create', resource: 'me/events', json: { subject: 'Meeting', start: { dateTime: '2026-03-20T10:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-03-20T10:30:00', timeZone: 'UTC' } } }, description: 'Create a calendar event' },
        { input: { service: 'contacts', method: 'list', resource: 'me/contacts', params: { $top: 10, $select: 'displayName,emailAddresses' } }, description: 'List contacts' },
      ],
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Microsoft 365 service: mail, calendar, onedrive, contacts.' },
          resource: { type: 'string', description: 'Graph resource path with slashes. Mail: "me/messages", "me/sendMail", "me/mailFolders". Calendar: "me/events", "me/calendarView". OneDrive: "me/drive/root/children", "me/drive/items". Contacts: "me/contacts".' },
          method: { type: 'string', description: 'API method: list, get, create, update, delete, send.' },
          id: { type: 'string', description: 'Resource ID (inserted into path after resource). Use for get/update/delete/send of a specific item.' },
          params: { type: 'object', description: 'OData query parameters: $filter, $select, $top, $skip, $orderby, $search, $count, etc.' },
          json: { type: 'object', description: 'Request body as JSON (for create/update/send methods). Contains the data to create or modify.' },
          format: { type: 'string', enum: ['json', 'table', 'yaml', 'csv'], description: 'Output format. Default: json.' },
          pageAll: { type: 'boolean', description: 'Auto-paginate all results.' },
          pageLimit: { type: 'number', description: 'Max pages when using pageAll.' },
        },
        required: ['service', 'resource', 'method'],
      },
    },
    async (args, request) => {
      const service = context.requireString(args.service, 'service').toLowerCase();
      const resource = context.requireString(args.resource, 'resource');
      const method = context.requireString(args.method, 'method');

      const isWrite = /\b(create|insert|update|patch|delete|send|remove|modify|forward|reply)\b/i.test(method);
      const actionType = service === 'mail' && /send/i.test(method)
        ? 'send_email'
        : service === 'mail'
          ? (isWrite ? 'draft_email' : 'read_email')
          : service === 'calendar'
            ? (isWrite ? 'write_calendar' : 'read_calendar')
            : service === 'onedrive'
              ? (isWrite ? 'write_drive' : 'read_drive')
              : service === 'contacts'
                ? (isWrite ? 'write_contacts' : 'read_contacts')
                : 'mcp_tool';

      const msService = context.getMicrosoftService();

      context.guardAction(request, actionType, {
        service,
        resource,
        method,
        provider: 'microsoft-native',
      });

      if (!msService?.isServiceEnabled(service) && service !== 'user') {
        return {
          success: false,
          error: 'Microsoft 365 is not enabled or not connected. Enable it in Settings > Microsoft 365.',
        };
      }

      let params = args.params as Record<string, unknown> | undefined;
      let json = (args.json ?? args.body) as Record<string, unknown> | undefined;
      let id = args.id ? context.asString(args.id) : undefined;

      const ODATA_PARAM_KEYS = new Set([
        '$filter', '$select', '$top', '$skip', '$orderby', '$count', '$search', '$expand',
        'startDateTime', 'endDateTime',
      ]);
      const BODY_FIELD_KEYS = new Set([
        'subject', 'body', 'toRecipients', 'ccRecipients', 'bccRecipients',
        'message', 'saveToSentItems', 'importance', 'categories', 'isRead',
        'start', 'end', 'location', 'attendees', 'recurrence', 'isAllDay',
        'isOnlineMeeting', 'givenName', 'surname', 'emailAddresses',
        'businessPhones', 'companyName', 'jobTitle', 'contentType', 'content',
        'name', 'description', 'displayName',
      ]);

      if (params && /\b(create|update|patch|send|forward|reply)\b/i.test(method)) {
        const misplaced: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(params)) {
          if (BODY_FIELD_KEYS.has(key) && !ODATA_PARAM_KEYS.has(key)) {
            misplaced[key] = val;
          }
        }
        if (Object.keys(misplaced).length > 0) {
          json = { ...(json ?? {}), ...misplaced };
          params = { ...params };
          for (const key of Object.keys(misplaced)) delete params[key];
          if (Object.keys(params).length === 0) params = undefined;
        }
      }

      if (json && !id) {
        for (const key of ['id', 'messageId', 'eventId', 'itemId']) {
          if (typeof json[key] === 'string') {
            id = json[key] as string;
            json = { ...json };
            delete json[key];
            if (Object.keys(json).length === 0) json = undefined;
            break;
          }
        }
      }

      const execParams = {
        service,
        resource,
        method,
        id,
        params,
        json,
        format: args.format as 'json' | 'table' | 'yaml' | 'csv' | undefined,
        pageAll: args.pageAll === true,
        pageLimit: args.pageLimit ? context.asNumber(args.pageLimit, 10) : undefined,
      };

      const result = await msService!.execute(execParams);

      return {
        success: result.success,
        output: result.data,
        error: result.error,
      };
    },
  );

  context.registry.register(
    {
      name: 'm365_schema',
      description:
        'Look up the API schema for a Microsoft Graph endpoint. ' +
        'Returns available parameters, request body fields, and descriptions. ' +
        'Use this to discover how to call a specific API. ' +
        'Schema path format: service.resource.method (e.g. "mail.messages.list", "calendar.events.create", "onedrive.root.children").',
      shortDescription: 'Look up API schema for a Microsoft Graph endpoint.',
      risk: 'read_only',
      category: 'workspace',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          schemaPath: {
            type: 'string',
            description: 'Dotted schema path: service.resource.method (e.g. "mail.messages.list", "calendar.events.create").',
          },
        },
        required: ['schemaPath'],
      },
    },
    async (args, request) => {
      const schemaPath = context.requireString(args.schemaPath, 'schemaPath');
      context.guardAction(request, 'read_docs', { path: `m365:schema:${schemaPath}` });

      const msService = context.getMicrosoftService();
      if (!msService) {
        return {
          success: false,
          error: 'Microsoft 365 is not enabled. Enable it in Settings > Microsoft 365.',
        };
      }

      const result = msService.schema(schemaPath);
      return {
        success: result.success,
        output: result.data,
        error: result.error,
      };
    },
  );
}
