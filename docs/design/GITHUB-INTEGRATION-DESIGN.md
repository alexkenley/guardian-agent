# GitHub Integration Design

## Status

Native GitHub OAuth is the primary connection model. The GitHub CLI adapter is retained only as a fallback/internal compatibility path.

This design covers two related use cases:

- user-approved creation of GuardianAgent diagnostic issues,
- developer workspace GitHub context for issues, pull requests, checks, and repository metadata.

The current runtime can draft diagnostic issue reports locally and create GitHub issues through the GitHub REST API after normal external-post approval.

## Decision Summary

GuardianAgent should treat GitHub like Google Workspace and Microsoft 365:

- the web UI owns the Connect GitHub action,
- OAuth opens in a browser window,
- a localhost callback completes the flow,
- access tokens are stored encrypted in Guardian's local secret file,
- account authentication does not require a repository target,
- issue creation remains a separate approval-gated external post.

No broad GitHub SDK is required for this surface. The built-in tools use narrow REST calls with explicit risk mapping, parameter validation, audit detail, and approval copy.

## Authentication Model

GitHub posting requires user authentication through a GitHub OAuth app.

The operator provides:

- OAuth Client ID,
- OAuth Client Secret.

The operator may also provide a repository target for repo-specific actions:

- owner or organization,
- repository.

Guardian requests `repo` and `read:user` by default so it can verify account access, optionally verify repository access, and create approved issues. The callback URL is:

```text
http://127.0.0.1:18434/callback
```

The GitHub OAuth app must allow that callback URL.

Operator setup flow:

1. Open GitHub > Settings > Developer settings > OAuth Apps.
2. Click "New OAuth App" or "Register a new application".
3. Use a recognizable application name such as "Guardian Agent".
4. Set Homepage URL to the local Guardian dashboard URL, for example `http://localhost:3000`.
5. Set Authorization callback URL exactly to `http://127.0.0.1:18434/callback`.
6. Register the app, copy the Client ID, then generate and copy a new Client Secret.
7. Paste the Client ID and Client Secret into Cloud > Connections > GitHub.
8. Optionally paste owner/organization and repository if the operator wants Guardian to create approved issues or use repo workflow context.

GitHub OAuth Apps only support one callback URL. Operators who need separate dev/prod callback URLs should create separate OAuth Apps instead of reusing one registration.

## Configuration

```yaml
assistant:
  tools:
    github:
      enabled: true
      mode: oauth
      clientId: ...
      clientSecret: ...
      # Optional until repo-specific actions are needed:
      defaultOwner: YOUR_ORG_OR_USERNAME
      defaultRepo: YOUR_REPOSITORY
      oauthCallbackPort: 18434
      scopes:
        - repo
        - read:user
      allowIssueCreation: true
      allowPullRequestCreation: false
```

## Runtime Placement

- `src/github/github-oauth-service.ts`: native OAuth, encrypted token storage, account checks, optional repository access checks, issue creation.
- `src/github/github-cli-service.ts`: fallback adapter.
- `src/tools/builtin/github-tools.ts`: assistant-visible tool registration and approval contract.
- `src/runtime/control-plane/provider-integration-callbacks.ts`: web connection callbacks.
- `src/channels/web-provider-admin-routes.ts`: `/api/github/*` control-plane routes.

## Tool Surface

| Tool | Risk | Purpose |
| --- | --- | --- |
| `github_status` | `read_only` | Report whether GitHub is connected and the configured repo is accessible. |
| `github_issue_create` | `external_post` | Create a GitHub issue from structured, redacted input after approval. |

Planned read-only developer context tools:

| Tool | Risk | Purpose |
| --- | --- | --- |
| `github_issue_list` | `read_only` | List issues for repo triage and context grounding. |
| `github_issue_view` | `read_only` | Read one issue with comments if requested. |
| `github_pr_list` | `read_only` | List open PRs for coding workspace orientation. |
| `github_pr_view` | `read_only` | Read PR metadata and review status. |
| `github_pr_diff` | `read_only` | Fetch PR diff/patch for code review context. |
| `github_workflow_runs` | `read_only` | Read recent GitHub Actions runs and statuses. |

Mutating tools such as issue comments, PR creation, PR comments, and PR reviews must stay separate `external_post` tools. Merge, close, delete, transfer, rerun, and cancel actions should remain separate explicit tools or out of scope until the workflow proves the need.

## Diagnostics Issue Flow

`guardian_issue_draft` remains read-only and never posts externally.

```text
user reports failure
  -> Intent Gateway routes diagnostics_task
  -> guardian_issue_draft creates redacted structured draft
  -> assistant shows the draft and asks whether to submit it
  -> user approves submission
  -> github_status confirms auth and target repo
  -> github_issue_create requests external-post approval
  -> ToolExecutor/Guardian policy gates the post
  -> issue is created and URL is returned
```

The issue creation tool accepts structured draft fields, not raw trace logs:

- repository owner,
- repository name,
- title,
- body,
- labels,
- source request id,
- diagnostic draft id or correlation id.

## Security And Policy

GitHub tools must use explicit risk mapping:

- read issue/PR/check operations: `read_only`,
- issue/PR comments and issue/PR creation: `external_post`,
- merge, close, delete, transfer, rerun, cancel: separate approval-gated tools if ever added.

Required controls:

- no token values in logs, traces, audit events, or tool output,
- no raw diagnostic traces posted to GitHub,
- redaction pass before issue body submission,
- audit target owner/repo, title, labels, issue URL, actor, request id, channel, and approval id,
- fail closed when GitHub is not connected or target repo access is denied.

The Guardian layer still decides whether a tool call may execute. GitHub integration must not bypass ToolExecutor, policy, approval continuity, or taint tracking.

## Operator Experience

Cloud > Connections shows:

- OAuth Client ID and Client Secret inputs,
- optional owner and repository inputs,
- inline GitHub OAuth setup instructions,
- field-level tooltips matching the Google Workspace and Microsoft 365 setup panels,
- Connect GitHub,
- Refresh Status,
- Disconnect,
- connection, auth, and optional repository-access status.

User-facing copy should be product-level and direct:

- "Please connect your GitHub account."
- "GitHub is connected. Add an owner and repository only when you want issue reporting or repo workflow actions."
- "GitHub is connected and can access `OWNER/REPO`."
- "Drafted the issue. No GitHub issue has been created yet."
- "Creating an issue will post to `OWNER/REPO`. Approve to continue."

## Testing Strategy

Required coverage:

- unit tests for unauthenticated, authenticated, and repo-denied status,
- unit tests for OAuth URL generation and callback token exchange,
- unit tests for issue creation REST payloads,
- ToolExecutor policy tests proving `github_issue_create` is `external_post`,
- diagnostics flow test proving drafting does not post,
- approval-continuity test proving issue creation only happens after approval,
- auth-missing test proving Guardian reports the prerequisite without attempting a post,
- API smoke test against the real app with connected and disconnected GitHub lanes.

## Current Repository Note

Guardian must not ship with a pre-filled organization or repository. The UI may show neutral placeholder hints only. The operator can connect a GitHub account without selecting any repository, then add the target owner and repository later before repo-specific actions such as issue creation.
