export type GitHubIntegrationMode = 'cli' | 'oauth' | 'app';

export interface GitHubConfig {
  enabled: boolean;
  mode: GitHubIntegrationMode;
  defaultOwner?: string;
  defaultRepo?: string;
  /** OAuth app Client ID for native GitHub browser sign-in. */
  clientId?: string;
  /** OAuth app Client Secret for native GitHub browser sign-in. */
  clientSecret?: string;
  /** Local callback port for native OAuth. */
  oauthCallbackPort?: number;
  /** OAuth scopes to request. Defaults to repo and read:user. */
  scopes?: string[];
  cliPath?: string;
  allowIssueCreation?: boolean;
  allowPullRequestCreation?: boolean;
  timeoutMs?: number;
}

export interface GitHubCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitHubStatusResult {
  enabled: boolean;
  mode: GitHubIntegrationMode;
  cliPath: string;
  installed: boolean;
  authenticated: boolean;
  repositoryConfigured?: boolean;
  defaultRepository?: string;
  repositoryAccessible?: boolean;
  repositoryUrl?: string;
  version?: string;
  authPending?: boolean;
  tokenExpiry?: number;
  clientId?: string;
  message: string;
}

export interface GitHubAuthStartResult {
  success: boolean;
  authUrl: string;
  state: string;
  message: string;
}

export interface GitHubIssueCreateInput {
  owner?: string;
  repo?: string;
  title: string;
  body: string;
  labels?: string[];
}

export interface GitHubIssueCreateResult {
  owner: string;
  repo: string;
  url: string;
  number?: number;
  title: string;
  labels: string[];
}

export interface GitHubServiceLike {
  status(owner?: string, repo?: string): Promise<GitHubStatusResult>;
  createIssue(input: GitHubIssueCreateInput): Promise<GitHubIssueCreateResult>;
}
