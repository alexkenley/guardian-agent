# Eventbus Spec

## Goal

Capture the architecture improvements currently implemented from the OpenClaw pattern proposal, and define the remaining work required to complete the rollout.

## Scope

- Admission pipeline workflow/operation extraction
- Web auth server-side session custody
- EventBus classify/policy pipeline
- Streaming chat SSE contract and dispatch path

## Implemented Improvements

## 1) Workflow/Operation Extraction (Guardian + staged runtime/tool modules)

### Implemented

- Added pure Guardian workflow functions in `src/guardian/workflows.ts`:
  - `sortControllersByPhase()`
  - `runAdmissionPipeline()`
- Added side-effect operation wrapper in `src/guardian/operations.ts`:
  - `handleAdmissionResult()`
- Updated `src/guardian/guardian.ts`:
  - `use()` now delegates controller sorting to `sortControllersByPhase()`
  - `check()` now delegates to `runAdmissionPipeline()` and `handleAdmissionResult()`
- Added new pure/operations modules for staged adoption:
  - `src/tools/workflows.ts`
  - `src/tools/operations.ts`
  - `src/runtime/workflows.ts`
  - `src/runtime/operations.ts`
- Added tests:
  - `src/guardian/workflows.test.ts`
  - `src/tools/workflows.test.ts`
  - `src/runtime/workflows.test.ts`

### Not Yet Wired

- `src/tools/executor.ts` is not yet using `src/tools/workflows.ts` / `src/tools/operations.ts`.
- `src/runtime/orchestrator.ts` is not yet using `src/runtime/workflows.ts` / `src/runtime/operations.ts`.

## 2) Server-side Token Custody (Session Cookie)

### Implemented

- `src/channels/web.ts` now supports cookie sessions:
  - in-memory `sessions` store
  - periodic expiry pruning
  - `POST /api/auth/session`
  - `DELETE /api/auth/session`
  - cookie parsing/validation helpers
  - auth checks accept bearer token and valid session cookie
- SSE auth now accepts either:
  - `?token=<bearer>`
  - valid session cookie
- `web/public/js/api.js`:
  - adds `createSession()`, `destroySession()`, `hasCookieSession()`
  - sends `credentials: 'same-origin'` with requests
- `web/public/js/app.js`:
  - login flow exchanges the bearer token for a session cookie through `api.createSession()` after successful authentication
  - SSE prefers `/sse` when cookie session is active, otherwise falls back to `/sse?token=...`

## 3) Event Classification Pipeline

### Implemented

- Added `src/queue/event-pipeline.ts` with:
  - `EventCategory`
  - `ClassifiedEvent`
  - `EventPolicyDecision`
  - `defaultEventClassifier()`
  - `defaultEventPolicy()`
- Extended `src/queue/event-bus.ts`:
  - `usePipeline(classifier, policy, handler)`
  - classify -> policy -> execute stage in `emit()`
  - `removeAllHandlers()` clears pipeline registrations
- Added `src/queue/event-pipeline.test.ts` for classifier, policy, and EventBus integration behavior.

### Compatibility

- Existing `subscribe`, `subscribeByType`, and broadcast handlers remain intact.
- Pipeline hooks are opt-in and do not change behavior unless registered.

## 4) Streaming Chat SSE Contract

### Implemented

- `src/channels/web-types.ts`:
  - `SSEEvent.type` includes `chat.thinking`, `chat.tool_call`, `chat.token`, `chat.done`, `chat.error`
  - `DashboardCallbacks` includes optional `onStreamDispatch()`
- `src/channels/web.ts`:
  - `POST /api/message/stream` endpoint added
  - uses SSE broadcast to push `chat.*` events
  - returns 404 when `onStreamDispatch` is not configured
- Frontend:
  - `web/public/js/api.js` adds `sendMessageStream(...)`
  - `web/public/js/app.js` supports listener registration for `chat.*` SSE events
  - `web/public/js/chat-panel.js` adds stream-first flow with fallback to standard `/api/message`

### Not Yet Wired

- No `onStreamDispatch` implementation exists in runtime wiring (`src/index.ts` callback registration), so streaming endpoint is currently a scaffold path.

## API Contract Additions

- `POST /api/auth/session`
  - Auth: existing bearer or valid session
  - Effect: sets `guardianagent_sid` HttpOnly cookie
  - Response: `{ success: true, expiresAt }`
- `DELETE /api/auth/session`
  - Auth: existing bearer or valid session
  - Effect: removes server session + clears cookie
  - Response: `{ success: true }`
- `POST /api/message/stream`
  - Auth: existing web auth checks
  - Body: `{ content, agentId, userId?, channel? }`
  - Behavior: delegates to `dashboard.onStreamDispatch` if configured

## Completion Plan

1. Wire tool decision/execution path to extracted workflow/operations modules.
2. Wire orchestrator dispatch path to extracted runtime workflow/operations modules.
3. Finish cookie-auth adoption in UI login flow (`createSession` on successful bearer login).
4. Implement `onStreamDispatch` callback in runtime/dashboard wiring.
5. Add backend tests for:
  - session issuance/expiry and SSE cookie auth
  - streaming endpoint event sequencing
