import type { SecurityOperatingMode } from './security-controls.js';

export interface BrowserSessionDecisionInput {
  toolName: string;
  currentMode: SecurityOperatingMode;
  scheduled?: boolean;
}

export interface BrowserSessionDecision {
  allowed: boolean;
  reason?: string;
  policy?: 'browser_high_risk' | 'browser_scheduled_mutation';
}

const HIGH_RISK_BROWSER_TOOLS = new Set([
  'browser_evaluate',
  'mcp-playwright-browser_run_code',
  'mcp-playwright-browser_evaluate',
  'mcp-playwright-browser_file_upload',
  'mcp-playwright-browser_storage_state',
  'mcp-playwright-browser_set_storage_state',
  'mcp-playwright-browser_install',
  'mcp-playwright-browser_route',
  'mcp-playwright-browser_unroute',
]);

const MUTATING_BROWSER_TOOLS = new Set([
  'browser_interact',
  'mcp-playwright-browser_click',
  'mcp-playwright-browser_type',
  'mcp-playwright-browser_select_option',
  'mcp-playwright-browser_press_key',
  'mcp-playwright-browser_drag',
  'mcp-playwright-browser_fill_form',
  'mcp-playwright-browser_handle_dialog',
  'mcp-playwright-browser_tabs',
  'mcp-playwright-browser_cookie_set',
  'mcp-playwright-browser_cookie_delete',
  'mcp-playwright-browser_cookie_clear',
  'mcp-playwright-browser_localstorage_set',
  'mcp-playwright-browser_localstorage_delete',
  'mcp-playwright-browser_localstorage_clear',
  'mcp-playwright-browser_sessionstorage_set',
  'mcp-playwright-browser_sessionstorage_delete',
  'mcp-playwright-browser_sessionstorage_clear',
]);

export class BrowserSessionBroker {
  isBrowserTool(toolName: string): boolean {
    return toolName.startsWith('browser_')
      || toolName.startsWith('mcp-playwright-browser_')
      || toolName.startsWith('mcp-lightpanda-');
  }

  isHighRiskBrowserTool(toolName: string): boolean {
    if (HIGH_RISK_BROWSER_TOOLS.has(toolName)) return true;
    return toolName.startsWith('mcp-playwright-browser_cookie_')
      || toolName.startsWith('mcp-playwright-browser_localstorage_')
      || toolName.startsWith('mcp-playwright-browser_sessionstorage_');
  }

  isMutatingBrowserTool(toolName: string): boolean {
    return this.isHighRiskBrowserTool(toolName)
      || MUTATING_BROWSER_TOOLS.has(toolName);
  }

  decide(input: BrowserSessionDecisionInput): BrowserSessionDecision {
    if (!this.isBrowserTool(input.toolName)) return { allowed: true };

    if (input.currentMode !== 'monitor' && this.isHighRiskBrowserTool(input.toolName)) {
      return {
        allowed: false,
        policy: 'browser_high_risk',
        reason: `Blocked by browser containment: '${input.toolName}' is disabled outside monitor mode because it can mutate authenticated session state or execute page code.`,
      };
    }

    if (input.scheduled && input.currentMode !== 'monitor' && this.isMutatingBrowserTool(input.toolName)) {
      return {
        allowed: false,
        policy: 'browser_scheduled_mutation',
        reason: `Blocked by browser containment: scheduled browser mutations are disabled in '${input.currentMode}' mode.`,
      };
    }

    return { allowed: true };
  }
}
