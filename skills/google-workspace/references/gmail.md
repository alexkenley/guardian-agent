# Gmail

Use these tools:
- `gmail_draft` for simple plain-text drafts
- `gmail_send` for simple plain-text sends
- `gws` for reads, advanced drafts/sends, labels, threads, attachments, and searches
- `gws_schema` if a Gmail method is unclear

Defaults:
- Use `params: { userId: "me" }`

Typical flows:

## Draft a simple email

Prefer:
```json
{
  "tool": "gmail_draft",
  "args": {
    "to": "recipient@example.com",
    "subject": "Subject",
    "body": "Body text"
  }
}
```

## Send a simple email

Prefer:
```json
{
  "tool": "gmail_send",
  "args": {
    "to": "recipient@example.com",
    "subject": "Subject",
    "body": "Body text"
  }
}
```

## List recent messages

Use:
```json
{
  "tool": "gws",
  "args": {
    "service": "gmail",
    "resource": "users messages",
    "method": "list",
    "params": {
      "userId": "me",
      "maxResults": 10
    }
  }
}
```

## Read one message

Use:
```json
{
  "tool": "gws",
  "args": {
    "service": "gmail",
    "resource": "users messages",
    "method": "get",
    "params": {
      "userId": "me",
      "id": "MESSAGE_ID",
      "format": "full"
    }
  }
}
```

## Advanced draft or send with raw RFC822

Use `gws` only when you need direct Gmail API control.

Draft:
```json
{
  "tool": "gws",
  "args": {
    "service": "gmail",
    "resource": "users drafts",
    "method": "create",
    "params": {
      "userId": "me"
    },
    "json": {
      "message": {
        "raw": "BASE64URL_RFC822"
      }
    }
  }
}
```

Send:
```json
{
  "tool": "gws",
  "args": {
    "service": "gmail",
    "resource": "users messages",
    "method": "send",
    "params": {
      "userId": "me"
    },
    "json": {
      "raw": "BASE64URL_RFC822"
    }
  }
}
```

Raw-message rules:
- Include `To` and `Subject` headers
- Use base64url, not plain base64
- Put the raw payload in `json`, never `params`

Approval rules:
- Draft creation is a mutating action and may require approval
- Sending is always high-risk and requires approval

Error recovery:
- If a method or field is unclear, call `gws_schema`
- If auth fails, tell the user to connect Google Workspace in Settings
