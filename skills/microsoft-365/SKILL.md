# Microsoft 365

Use the native Microsoft 365 tools for Outlook Mail, Calendar, OneDrive, and Contacts via the Microsoft Graph API.

Core rules:
- Authentication is handled by the connected Microsoft 365 integration. Never ask the user for OAuth access tokens.
- If the user asks for a generic email or inbox task and both Microsoft 365 and Google Workspace are available, ask which mailbox they mean before acting. Do not silently choose Outlook.
- For simple plain-text Outlook drafts, prefer `outlook_draft`.
- For simple plain-text Outlook sends, prefer `outlook_send`.
- For everything else, use `m365`.
- If you are unsure about a Graph endpoint or payload shape, use `m365_schema` before guessing.

Behavioral rules — CRITICAL:
- **Act, don't offer.** When the user asks to read email, list files, check calendar, etc., call the tool immediately. Do not describe what you *could* do or ask if the user wants you to proceed. Read operations are safe — just execute them.
- **Use the user profile endpoint.** For questions about the user's identity, email address, display name, or account, call `m365` with `service: "user", resource: "me", method: "get"`. This returns `displayName`, `mail`, `userPrincipalName`, and more.
- **Always select rich fields.** When listing emails, always include `toRecipients` and `bodyPreview` alongside `subject`, `from`, `receivedDateTime`. The user may ask follow-up questions about recipients or content. When listing events, include `attendees`. When listing contacts, include `emailAddresses`.
- **Present results clearly.** Format email listings as numbered lists with subject, sender, date, and a brief preview. For calendar events include time, subject, and location. For OneDrive files include name, size, and last modified date.
- **Handle follow-ups from context.** If the user asks about details from a previous response (e.g. "who was that email to?"), check if the data is already in the conversation. If not, fetch the specific item by ID with full details rather than saying "I don't have access."

Workflow:
1. For reads, just execute the call. No confirmation needed.
2. Prefer narrow reads over broad listings. Use `$select` to pick useful fields (but err on the side of too many fields, not too few).
3. Use `$filter` for server-side filtering instead of fetching everything.
4. For writes, confirm missing critical details only. Do not add unnecessary confirmation.
5. Expect approvals for drafts, sends, and most write operations.
6. If a Microsoft action fails for auth, tell the user to connect Microsoft 365 in Settings. Do not ask for raw tokens.

How to use this skill:
- Outlook Mail task: read `references/outlook.md`
- Calendar task: read `references/calendar.md`
- OneDrive task: read `references/onedrive.md`

User profile (no reference file needed):
- Get current user's email/name: `service: "user", resource: "me", method: "get", params: { "$select": "displayName,mail,userPrincipalName,jobTitle" }`

General `m365` rules:
- Resource paths use forward slashes: `me/messages`, `me/events`, `me/drive/root/children`.
- Resource IDs go in the `id` parameter, not in the resource path.
- OData query parameters (`$filter`, `$select`, `$top`, `$orderby`) go in `params`.
- Request bodies go in `json`.
- The `service` field determines scope validation: `mail`, `calendar`, `onedrive`, `contacts`, `user`.

Read only the domain reference you need for the current request. Do not load all references up front.

## Gotchas

- Do not ask the user for raw OAuth tokens or API credentials.
- Do not silently pick Outlook when the mailbox provider is ambiguous.
- Do not under-select fields on list calls and then answer follow-up questions from incomplete data.
