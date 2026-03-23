import { describe, expect, it } from 'vitest';
import { BrowserSessionBroker } from './browser-session-broker.js';

describe('BrowserSessionBroker', () => {
  it('treats Guardian-native browser wrapper tools as browser tools', () => {
    const broker = new BrowserSessionBroker();

    expect(broker.isBrowserTool('browser_capabilities')).toBe(true);
    expect(broker.isBrowserTool('browser_navigate')).toBe(true);
    expect(broker.isBrowserTool('browser_interact')).toBe(true);
  });

  it('blocks scheduled browser_interact mutations outside monitor mode', () => {
    const broker = new BrowserSessionBroker();

    const decision = broker.decide({
      toolName: 'browser_interact',
      currentMode: 'guarded',
      scheduled: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.policy).toBe('browser_scheduled_mutation');
  });
});
