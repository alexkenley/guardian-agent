# Drive, Docs, and Sheets

Use `gws` for Drive, Docs, and Sheets. Use `gws_schema` if a method is unclear.

Core rules:
- Search or identify the target file before mutating it
- Put IDs like `fileId`, `documentId`, and `spreadsheetId` in `params`
- Put request bodies in `json`

## Search Drive files

```json
{
  "tool": "gws",
  "args": {
    "service": "drive",
    "resource": "files",
    "method": "list",
    "params": {
      "q": "name contains 'Project' and trashed = false",
      "pageSize": 10
    }
  }
}
```

## Create a Google Doc

```json
{
  "tool": "gws",
  "args": {
    "service": "drive",
    "resource": "files",
    "method": "create",
    "json": {
      "name": "Meeting Notes",
      "mimeType": "application/vnd.google-apps.document"
    }
  }
}
```

## Get a Drive file

```json
{
  "tool": "gws",
  "args": {
    "service": "drive",
    "resource": "files",
    "method": "get",
    "params": {
      "fileId": "FILE_ID"
    }
  }
}
```

## Update a Drive file

```json
{
  "tool": "gws",
  "args": {
    "service": "drive",
    "resource": "files",
    "method": "update",
    "params": {
      "fileId": "FILE_ID"
    },
    "json": {
      "name": "New Name"
    }
  }
}
```

## Write Sheet values

```json
{
  "tool": "gws",
  "args": {
    "service": "sheets",
    "resource": "spreadsheets values",
    "method": "update",
    "params": {
      "spreadsheetId": "SHEET_ID",
      "range": "Sheet1!A1:B2",
      "valueInputOption": "USER_ENTERED"
    },
    "json": {
      "values": [["Header1", "Header2"], ["Value1", "Value2"]]
    }
  }
}
```

Before writes:
- Identify the exact file, document, spreadsheet, tab, and range first
- Avoid broad destructive edits unless the user asked for them

Approval rules:
- Creates, updates, deletes, and sheet writes may require approval
