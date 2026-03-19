import { describe, expect, it } from 'vitest';
import { assessSecurityPosture } from './security-posture.js';

describe('assessSecurityPosture', () => {
  it('stays in monitor when there are no active alerts', () => {
    const result = assessSecurityPosture({
      profile: 'personal',
      currentMode: 'monitor',
      alerts: [],
      availableSources: ['host', 'network'],
    });

    expect(result.recommendedMode).toBe('monitor');
    expect(result.shouldEscalate).toBe(false);
    expect(result.counts.total).toBe(0);
  });

  it('recommends guarded for a single high alert', () => {
    const result = assessSecurityPosture({
      profile: 'home',
      currentMode: 'monitor',
      alerts: [{
        id: 'host-1',
        source: 'host',
        type: 'suspicious_process',
        severity: 'high',
        description: 'Suspicious process: wscript.exe',
      }],
      availableSources: ['host'],
    });

    expect(result.recommendedMode).toBe('guarded');
    expect(result.shouldEscalate).toBe(true);
    expect(result.reasons.join(' ')).toContain('high-severity');
  });

  it('recommends ir_assist for a single critical investigation signal', () => {
    const result = assessSecurityPosture({
      profile: 'organization',
      currentMode: 'guarded',
      alerts: [{
        id: 'net-1',
        source: 'network',
        type: 'beaconing',
        severity: 'critical',
        description: 'Beaconing detected to external host',
      }],
      availableSources: ['network'],
    });

    expect(result.recommendedMode).toBe('ir_assist');
    expect(result.shouldEscalate).toBe(true);
  });

  it('recommends lockdown for critical protection-boundary failures', () => {
    const result = assessSecurityPosture({
      profile: 'personal',
      currentMode: 'monitor',
      alerts: [{
        id: 'gw-1',
        source: 'gateway',
        type: 'gateway_firewall_disabled',
        severity: 'critical',
        description: 'Gateway firewall disabled',
      }],
      availableSources: ['gateway'],
    });

    expect(result.recommendedMode).toBe('lockdown');
    expect(result.shouldEscalate).toBe(true);
    expect(result.summary).toContain("Escalate from 'monitor' to 'lockdown'");
  });

  it('keeps noisy medium host alerts in monitor mode', () => {
    const result = assessSecurityPosture({
      profile: 'personal',
      currentMode: 'monitor',
      alerts: [
        {
          id: 'host-1',
          source: 'host',
          type: 'new_external_destination',
          severity: 'medium',
          description: 'New external destination observed: 203.0.113.10',
        },
        {
          id: 'host-2',
          source: 'host',
          type: 'sensitive_path_change',
          severity: 'medium',
          description: 'Sensitive path changed: C:\\Users\\alex\\.guardianagent',
        },
        {
          id: 'native-1',
          source: 'native',
          type: 'defender_controlled_folder_access_disabled',
          severity: 'medium',
          description: 'Controlled Folder Access is disabled.',
        },
      ],
      availableSources: ['host', 'native'],
    });

    expect(result.recommendedMode).toBe('monitor');
    expect(result.shouldEscalate).toBe(false);
  });

  it('does not jump to lockdown for multiple same-source critical alerts outside protection-boundary failures', () => {
    const result = assessSecurityPosture({
      profile: 'personal',
      currentMode: 'monitor',
      alerts: [
        {
          id: 'host-1',
          source: 'host',
          type: 'persistence_change',
          severity: 'critical',
          description: 'New persistence entry detected: schtasks:unexpected',
        },
        {
          id: 'host-2',
          source: 'host',
          type: 'persistence_change',
          severity: 'critical',
          description: 'New persistence entry detected: HKCU\\...\\Run:Bad=evil.exe',
        },
      ],
      availableSources: ['host'],
    });

    expect(result.recommendedMode).toBe('ir_assist');
    expect(result.shouldEscalate).toBe(true);
  });
});
