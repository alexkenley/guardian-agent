import { readFile } from 'node:fs/promises';
import type { GoogleService } from '../../google/google-service.js';
import { buildGmailRawMessage } from '../../runtime/gmail-compose.js';
import type { MarketingStore } from '../marketing-store.js';
import { ToolRegistry } from '../registry.js';
import type { ToolExecutionRequest } from '../types.js';

interface ContactsEmailToolRegistrarContext {
  registry: ToolRegistry;
  marketingStore: MarketingStore;
  requireString: (value: unknown, field: string) => string;
  asNumber: (value: unknown, fallback: number) => number;
  asString: (value: unknown, fallback?: string) => string;
  asStringArray: (value: unknown) => string[];
  isHostAllowed: (host: string) => boolean;
  guardAction: (request: ToolExecutionRequest, action: string, details: Record<string, unknown>) => void;
  resolveAllowedPath: (inputPath: string, request?: Partial<ToolExecutionRequest>) => Promise<string>;
  getGoogleService: () => GoogleService | undefined;
  assertGmailHostAllowed: () => void;
  maxFetchBytes: number;
  maxCampaignRecipients: number;
}

export function registerBuiltinContactsEmailTools(context: ContactsEmailToolRegistrarContext): void {
  context.registry.register(
    {
      name: 'contacts_discover_browser',
      description: 'Discover candidate contacts (emails) from a public web page and add/update contact store. Extracts email addresses via regex, max 200 per run. Security: hostname validated against allowedDomains. Requires network_access capability.',
      shortDescription: 'Discover contact emails from a public web page.',
      risk: 'network',
      category: 'contacts',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Public page URL to inspect for contact data.' },
          maxContacts: { type: 'number', description: 'Maximum contacts to keep from this discovery run (max 200).' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags to attach to discovered contacts.' },
        },
        required: ['url'],
      },
    },
    async (args, request) => {
      const urlText = context.requireString(args.url, 'url').trim();
      const parsed = new URL(urlText);
      const host = parsed.hostname.toLowerCase();
      if (!context.isHostAllowed(host)) {
        return {
          success: false,
          error: `Host '${host}' is not in allowedDomains.`,
        };
      }

      context.guardAction(request, 'http_request', { url: parsed.toString(), method: 'GET' });
      const timeoutMs = Math.max(500, Math.min(30_000, context.asNumber(args.timeoutMs, 10_000)));
      const maxContacts = Math.max(1, Math.min(200, context.asNumber(args.maxContacts, 25)));
      const tags = context.asStringArray(args.tags);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(parsed.toString(), {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            'User-Agent': 'GuardianAgent-Tools/1.0',
            'Accept': 'text/html,application/xhtml+xml,text/plain',
          },
        });

        const bytes = await response.arrayBuffer();
        const capped = bytes.byteLength > context.maxFetchBytes
          ? bytes.slice(0, context.maxFetchBytes)
          : bytes;
        const raw = Buffer.from(capped).toString('utf-8');
        const emails = extractEmails(raw).slice(0, maxContacts);
        if (emails.length === 0) {
          return {
            success: true,
            output: {
              url: parsed.toString(),
              host,
              discovered: 0,
              added: 0,
              updated: 0,
              contacts: [],
            },
          };
        }

        const upsert = await context.marketingStore.upsertContacts(
          emails.map((email) => ({
            email,
            name: inferNameFromEmail(email),
            tags,
            source: parsed.toString(),
          })),
        );

        return {
          success: true,
          output: {
            url: parsed.toString(),
            host,
            discovered: emails.length,
            added: upsert.added,
            updated: upsert.updated,
            contacts: upsert.contacts.slice(0, maxContacts),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Discovery failed: ${message}`,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  );

  context.registry.register(
    {
      name: 'contacts_import_csv',
      description: 'Import marketing contacts from CSV file (columns: email,name,company,tags). Max 1000 rows per import. Security: path validated against allowedPaths roots. Mutating — requires approval. Requires read_files capability.',
      shortDescription: 'Import marketing contacts from a CSV file.',
      risk: 'mutating',
      category: 'contacts',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'CSV path within allowed paths.' },
          source: { type: 'string', description: 'Optional source label for imported contacts.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags applied to every imported contact.' },
          maxRows: { type: 'number', description: 'Maximum rows to import from CSV (max 1000).' },
        },
        required: ['path'],
      },
    },
    async (args, request) => {
      const rawPath = context.requireString(args.path, 'path');
      const safePath = await context.resolveAllowedPath(rawPath, request);
      context.guardAction(request, 'read_file', { path: rawPath });
      const maxRows = Math.max(1, Math.min(1000, context.asNumber(args.maxRows, 500)));
      const source = context.asString(args.source);
      const sharedTags = context.asStringArray(args.tags);
      const raw = await readFile(safePath, 'utf-8');
      const contacts = parseContactCsv(raw, {
        maxRows,
        source,
        sharedTags,
      });
      const upsert = await context.marketingStore.upsertContacts(contacts);
      return {
        success: true,
        output: {
          path: safePath,
          parsed: contacts.length,
          added: upsert.added,
          updated: upsert.updated,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'contacts_list',
      description: 'List marketing contacts from local campaign store. Supports query and tag filtering. Max 500 results. Read-only local data — no network calls.',
      shortDescription: 'List marketing contacts from local campaign store.',
      risk: 'read_only',
      category: 'contacts',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          query: { type: 'string' },
          tag: { type: 'string' },
        },
      },
    },
    async (args) => {
      const limit = Math.max(1, Math.min(500, context.asNumber(args.limit, 100)));
      const query = context.asString(args.query);
      const tag = context.asString(args.tag);
      const contacts = await context.marketingStore.listContacts(limit, query || undefined, tag || undefined);
      return {
        success: true,
        output: {
          count: contacts.length,
          contacts,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'campaign_create',
      description: 'Create a marketing campaign from subject and body templates. Templates support placeholder variables. Mutating — requires approval. No network calls — local store only.',
      shortDescription: 'Create a marketing campaign with subject and body template.',
      risk: 'mutating',
      category: 'contacts',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          subjectTemplate: { type: 'string' },
          bodyTemplate: { type: 'string' },
          contactIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'subjectTemplate', 'bodyTemplate'],
      },
    },
    async (args) => {
      const name = context.requireString(args.name, 'name');
      const subjectTemplate = context.requireString(args.subjectTemplate, 'subjectTemplate');
      const bodyTemplate = context.requireString(args.bodyTemplate, 'bodyTemplate');
      const contactIds = context.asStringArray(args.contactIds);
      const campaign = await context.marketingStore.createCampaign({
        name,
        subjectTemplate,
        bodyTemplate,
        contactIds,
      });
      return { success: true, output: campaign };
    },
  );

  context.registry.register(
    {
      name: 'campaign_list',
      description: 'List marketing campaigns from local store. Read-only — no network calls.',
      shortDescription: 'List marketing campaigns from local store.',
      risk: 'read_only',
      category: 'contacts',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
        },
      },
    },
    async (args) => {
      const limit = Math.max(1, Math.min(200, context.asNumber(args.limit, 50)));
      const campaigns = await context.marketingStore.listCampaigns(limit);
      return {
        success: true,
        output: {
          count: campaigns.length,
          campaigns,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'campaign_add_contacts',
      description: 'Attach contacts to an existing campaign by contact IDs. Mutating — requires approval. No network calls — local store only.',
      shortDescription: 'Attach contacts to an existing campaign.',
      risk: 'mutating',
      category: 'contacts',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          campaignId: { type: 'string' },
          contactIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['campaignId', 'contactIds'],
      },
    },
    async (args) => {
      const campaignId = context.requireString(args.campaignId, 'campaignId');
      const contactIds = context.asStringArray(args.contactIds);
      if (contactIds.length === 0) {
        return { success: false, error: '\'contactIds\' must contain at least one contact id.' };
      }
      const campaign = await context.marketingStore.addContactsToCampaign(campaignId, contactIds);
      return { success: true, output: campaign };
    },
  );

  context.registry.register(
    {
      name: 'campaign_dry_run',
      description: 'Render campaign subjects/bodies for review without sending. Previews template substitution for each recipient. Read-only — no emails sent.',
      shortDescription: 'Preview campaign subjects/bodies without sending.',
      risk: 'read_only',
      category: 'contacts',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          campaignId: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['campaignId'],
      },
    },
    async (args) => {
      const campaignId = context.requireString(args.campaignId, 'campaignId');
      const limit = Math.max(1, Math.min(200, context.asNumber(args.limit, 20)));
      const drafts = await context.marketingStore.buildCampaignDrafts(campaignId, limit);
      return {
        success: true,
        output: {
          campaignId,
          count: drafts.length,
          drafts,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'gmail_draft',
      description: 'Create one plain-text Gmail draft using the configured Google Workspace connection. Authentication is automatic. Mutating — requires approval outside autonomous mode. Requires draft_email capability.',
      shortDescription: 'Create one Gmail draft with automatic Google auth.',
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
      const googleSvc = context.getGoogleService();
      if (!googleSvc) {
        return { success: false, error: 'Google Workspace is not enabled.' };
      }

      context.guardAction(request, 'draft_email', { to, subject, provider: 'gmail' });

      const raw = buildGmailRawMessage({ to, subject, body });
      const drafted = await googleSvc.execute({
        service: 'gmail',
        resource: 'users drafts',
        method: 'create',
        params: { userId: 'me' },
        json: { message: { raw } },
      });

      return {
        success: drafted.success,
        output: drafted.data,
        error: drafted.error,
      };
    },
  );

  context.registry.register(
    {
      name: 'gmail_send',
      description: 'Send one email via the configured Google Workspace Gmail connection. Authentication is automatic. Security: gmail.googleapis.com must be in allowedDomains. external_post risk — always requires manual approval. Requires send_email capability.',
      shortDescription: 'Send one email through Gmail with automatic Google auth.',
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
      const googleSvc = context.getGoogleService();
      if (!googleSvc) {
        return { success: false, error: 'Google Workspace is not enabled.' };
      }
      context.assertGmailHostAllowed();
      context.guardAction(request, 'send_email', { to, subject, provider: 'gmail' });

      const sent = await googleSvc.sendGmailMessage({ to, subject, body });
      return {
        success: sent.success,
        output: sent.data,
        error: sent.error,
      };
    },
  );

  context.registry.register(
    {
      name: 'campaign_run',
      description: 'Send a campaign via Gmail to all attached contacts. Max 500 recipients per run. Security: gmail.googleapis.com must be in allowedDomains. external_post risk — always requires manual approval. Requires send_email capability.',
      shortDescription: 'Send a campaign via Gmail to all attached contacts.',
      risk: 'external_post',
      category: 'email',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          campaignId: { type: 'string' },
          maxRecipients: { type: 'number' },
        },
        required: ['campaignId'],
      },
    },
    async (args, request) => {
      const campaignId = context.requireString(args.campaignId, 'campaignId');
      const googleSvc = context.getGoogleService();
      if (!googleSvc) {
        return { success: false, error: 'Google Workspace is not enabled.' };
      }
      context.assertGmailHostAllowed();

      const maxRecipients = Math.max(1, Math.min(context.maxCampaignRecipients, context.asNumber(args.maxRecipients, 100)));
      const drafts = await context.marketingStore.buildCampaignDrafts(campaignId, maxRecipients);
      if (drafts.length === 0) {
        return {
          success: false,
          error: `Campaign '${campaignId}' has no contacts to send.`,
        };
      }

      context.guardAction(request, 'send_email', {
        campaignId,
        recipientCount: drafts.length,
        provider: 'gmail',
      });

      const results: Array<{
        contactId: string;
        email: string;
        status: 'sent' | 'failed';
        messageId?: string;
        error?: string;
      }> = [];
      for (const draft of drafts) {
        const sent = await googleSvc.sendGmailMessage({
          to: draft.email,
          subject: draft.subject,
          body: draft.body,
        });
        results.push({
          contactId: draft.contactId,
          email: draft.email,
          status: sent.success ? 'sent' : 'failed',
          messageId: sent.data?.messageId,
          error: sent.error,
        });
      }

      const campaign = await context.marketingStore.recordCampaignRun(campaignId, results);
      const sentCount = results.filter((item) => item.status === 'sent').length;
      const failedCount = results.length - sentCount;
      return {
        success: sentCount > 0,
        output: {
          campaignId,
          attempted: results.length,
          sent: sentCount,
          failed: failedCount,
          campaign,
          failures: results.filter((item) => item.status === 'failed').slice(0, 20),
        },
        error: sentCount === 0 ? 'All campaign sends failed.' : undefined,
      };
    },
  );
}

function extractEmails(text: string): string[] {
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  const unique = new Set<string>();
  for (const candidate of matches) {
    const normalized = candidate.trim().toLowerCase().replace(/[),.;:]+$/g, '');
    if (!normalized) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) continue;
    unique.add(normalized);
  }
  return [...unique];
}

function inferNameFromEmail(email: string): string | undefined {
  const local = email.split('@')[0]?.trim();
  if (!local) return undefined;
  const cleaned = local.replace(/[._-]+/g, ' ').replace(/\d+/g, '').trim();
  if (!cleaned) return undefined;
  return cleaned
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseContactCsv(
  raw: string,
  input: {
    maxRows: number;
    source?: string;
    sharedTags: string[];
  },
): Array<{
  email: string;
  name?: string;
  company?: string;
  tags?: string[];
  source?: string;
}> {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const rows = lines.slice(0, input.maxRows + 1);
  const parsed = rows.map(splitCsvLine);
  let startIndex = 0;
  let map: { email: number; name: number; company: number; tags: number } | null = null;

  const firstRow = parsed[0].map((value) => value.trim().toLowerCase());
  if (firstRow.includes('email')) {
    map = {
      email: firstRow.indexOf('email'),
      name: firstRow.indexOf('name'),
      company: firstRow.indexOf('company'),
      tags: firstRow.indexOf('tags'),
    };
    startIndex = 1;
  }

  const contacts: Array<{
    email: string;
    name?: string;
    company?: string;
    tags?: string[];
    source?: string;
  }> = [];

  for (let i = startIndex; i < parsed.length; i += 1) {
    const row = parsed[i];
    const email = takeColumn(row, map?.email ?? 0);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.toLowerCase())) continue;
    const name = takeColumn(row, map?.name ?? 1);
    const company = takeColumn(row, map?.company ?? 2);
    const rowTags = takeColumn(row, map?.tags ?? 3);
    const tags = uniqueNonEmpty([
      ...input.sharedTags,
      ...rowTags.split(/[|,]/).map((tag) => tag.trim().toLowerCase()),
    ]);

    contacts.push({
      email: email.toLowerCase(),
      name: name || undefined,
      company: company || undefined,
      tags,
      source: input.source,
    });
  }

  return contacts;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function takeColumn(row: string[], index: number): string {
  if (index < 0 || index >= row.length) return '';
  return row[index]?.trim() ?? '';
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
