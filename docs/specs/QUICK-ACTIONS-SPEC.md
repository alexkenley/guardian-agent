# Quick Actions Spec

## Goal
Move from generic prompting to repeatable high-value workflows:
- Drafting emails
- Planning tasks
- Preparing calendar/meeting plans

## Data Model
- `assistant.quickActions.enabled`
- `assistant.quickActions.templates` keyed by action ID
- Template placeholders:
  - `{details}` required

## Built-in Actions
- `email`
- `task`
- `calendar`

## Execution Model
1. Channel captures selected action + freeform details
2. Backend builds a structured prompt from template
3. Prompt is dispatched to selected chat agent
4. Response returned through normal channel message flow

## API Surface
- `GET /api/quick-actions`
- `POST /api/quick-actions/run`

## Channel Surface
- Web: quick action bar in chat page
- CLI: `/quick <email|task|calendar> <details>`
- Telegram: `/quick <email|task|calendar> <details>`

