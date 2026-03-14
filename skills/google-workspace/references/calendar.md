# Calendar

Use `gws` for Calendar work. Use `gws_schema` if a method is unclear.

Defaults:
- Use `params: { calendarId: "primary" }` unless the user specifies a different calendar

## List events

```json
{
  "tool": "gws",
  "args": {
    "service": "calendar",
    "resource": "events",
    "method": "list",
    "params": {
      "calendarId": "primary"
    }
  }
}
```

## Create an event

```json
{
  "tool": "gws",
  "args": {
    "service": "calendar",
    "resource": "events",
    "method": "create",
    "params": {
      "calendarId": "primary"
    },
    "json": {
      "summary": "Meeting",
      "start": { "dateTime": "2026-03-14T10:00:00Z" },
      "end": { "dateTime": "2026-03-14T10:30:00Z" }
    }
  }
}
```

## Update an event

Put the `eventId` in `params`, not `json`.

Before writes:
- Confirm title, date, timezone, and duration if they are missing
- Read first if the user refers to an existing event vaguely

Approval rules:
- Creates and updates are mutating and may require approval
