import type { GitHubConfig } from '../../github/types.js';
import { GitHubCliService } from '../../github/github-cli-service.js';
import { GitHubOAuthService } from '../../github/github-oauth-service.js';
import type { GitHubServiceLike } from '../../github/types.js';
import { ToolRegistry } from '../registry.js';
import type { ToolExecutionRequest } from '../types.js';

interface GitHubToolRegistrarContext {
  registry: ToolRegistry;
  githubConfig?: GitHubConfig;
  githubService?: GitHubServiceLike;
  asString: (value: unknown, fallback?: string) => string;
  asStringArray: (value: unknown) => string[];
  guardAction: (request: ToolExecutionRequest, action: string, details: Record<string, unknown>) => void;
}

function getGitHubService(context: GitHubToolRegistrarContext): GitHubServiceLike {
  if (context.githubService) return context.githubService;
  return context.githubConfig?.mode === 'cli'
    ? new GitHubCliService(context.githubConfig)
    : new GitHubOAuthService(context.githubConfig);
}

export function registerBuiltinGitHubTools(context: GitHubToolRegistrarContext): void {
  context.registry.register(
    {
      name: 'github_status',
      description: 'Check the configured GitHub integration. Reports whether GitHub is connected and able to access the selected repository. Read-only; does not create issues or mutate GitHub.',
      shortDescription: 'Check GitHub auth and repository access. Read-only.',
      risk: 'read_only',
      category: 'github',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Optional GitHub owner/org. Defaults to assistant.tools.github.defaultOwner.' },
          repo: { type: 'string', description: 'Optional GitHub repository. Defaults to assistant.tools.github.defaultRepo.' },
        },
      },
    },
    async (args) => {
      try {
        const service = getGitHubService(context);
        const output = await service.status(
          context.asString(args.owner).trim() || undefined,
          context.asString(args.repo).trim() || undefined,
        );
        return {
          success: true,
          message: output.message,
          output,
          verificationStatus: 'verified',
          verificationEvidence: 'Read-only GitHub status check.',
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  context.registry.register(
    {
      name: 'github_issue_create',
      description: 'Create a GitHub issue from an already-reviewed, redacted issue draft. Use only after the user explicitly asks to submit/create/post the issue. This is an external_post tool and requires approval before posting to GitHub.',
      shortDescription: 'Create a GitHub issue from a reviewed draft. External post; approval required.',
      risk: 'external_post',
      category: 'github',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'GitHub owner/org. Required unless assistant.tools.github.defaultOwner is configured.' },
          repo: { type: 'string', description: 'GitHub repository. Required unless assistant.tools.github.defaultRepo is configured.' },
          title: { type: 'string', description: 'Issue title.' },
          body: { type: 'string', description: 'Issue body. Must already be redacted and reviewed.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Optional issue labels.' },
        },
        required: ['title', 'body'],
      },
      examples: [
        {
          input: {
            title: '[Diagnostics] Assistant lost context',
            body: '## Problem Report\n...',
            labels: ['diagnostics', 'user-reported'],
          },
          description: 'Submit a reviewed diagnostics issue draft to the configured default repository',
        },
      ],
    },
    async (args, request) => {
      const title = context.asString(args.title).trim();
      const body = context.asString(args.body).trim();
      const owner = context.asString(args.owner).trim() || undefined;
      const repo = context.asString(args.repo).trim() || undefined;
      const targetOwner = owner ?? context.githubConfig?.defaultOwner?.trim();
      const targetRepo = repo ?? context.githubConfig?.defaultRepo?.trim();
      const labels = context.asStringArray(args.labels);
      if (!title) return { success: false, error: 'title is required.' };
      if (!body) return { success: false, error: 'body is required.' };
      if (!targetOwner || !targetRepo) {
        return {
          success: false,
          error: 'GitHub owner and repository are required. Configure them in Cloud > Connections > GitHub, or pass owner and repo explicitly.',
        };
      }

      context.guardAction(request, 'external_post', {
        tool: 'github_issue_create',
        provider: 'github',
        owner: targetOwner,
        repo: targetRepo,
        title,
        labels,
      });

      try {
        const service = getGitHubService(context);
        const output = await service.createIssue({ owner: targetOwner, repo: targetRepo, title, body, labels });
        return {
          success: true,
          message: `Created GitHub issue: ${output.url}`,
          output,
          verificationStatus: 'verified',
          verificationEvidence: `Created GitHub issue in ${output.owner}/${output.repo}.`,
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
