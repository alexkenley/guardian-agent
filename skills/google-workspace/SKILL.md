# Google Workspace

Use Guardian Agent's native Google Workspace tools for Gmail, Calendar, Drive, Docs, and Sheets.

Core rules:
- Authentication is handled by the connected Google Workspace integration. Never ask the user for OAuth access tokens.
- For simple plain-text Gmail drafts, prefer `gmail_draft`.
- For simple plain-text Gmail sends, prefer `gmail_send`.
- For everything else, use `gws`.
- If you are unsure about a Google method or payload shape, use `gws_schema` before guessing.

Workflow:
1. Read first when the task is ambiguous or mutating.
2. Prefer narrow reads over broad listings.
3. For writes, confirm missing critical details only. Do not add unnecessary confirmation.
4. Expect approvals for drafts, sends, and most write operations.
5. If a Google action fails for auth, tell the user to connect Google Workspace in Settings. Do not ask for raw tokens.

How to use this skill:
- Gmail task: read `references/gmail.md`
- Calendar task: read `references/calendar.md`
- Drive, Docs, or Sheets task: read `references/drive-docs-sheets.md`

General `gws` rules:
- Resource paths use spaces, not dots. Example: `users messages`, `users drafts`, `spreadsheets values`.
- Resource IDs and path/query fields go in `params`.
- Request bodies go in `json`.
- Gmail defaults to `userId: "me"` when needed, but include it explicitly in examples and deliberate calls.
- Calendar defaults to `calendarId: "primary"` when needed, but include it explicitly when clarity matters.

Read only the domain reference you need for the current request. Do not load all references up front.
