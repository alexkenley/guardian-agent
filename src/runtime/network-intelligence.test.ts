import { describe, it, expect } from 'vitest';
import {
  lookupOuiVendor,
  mapPortsToServices,
  classifyDevice,
} from './network-intelligence.js';

describe('network-intelligence', () => {
  describe('lookupOuiVendor', () => {
    it('looks up vendor by MAC prefix', () => {
      expect(lookupOuiVendor('FC:FB:FB:12:34:56')).toBe('Apple, Inc.');
      expect(lookupOuiVendor('fc-fb-fb-aa-bb-cc')).toBe('Apple, Inc.');
    });

    it('returns undefined for unknown prefixes', () => {
      expect(lookupOuiVendor('00:00:00:12:34:56')).toBeUndefined();
    });
  });

  describe('mapPortsToServices', () => {
    it('maps known ports and preserves unknown as Unknown', () => {
      const services = mapPortsToServices([443, 22, 65535]);
      expect(services.map((s) => s.service)).toEqual(['SSH', 'HTTPS', 'Unknown']);
      expect(services.map((s) => s.port)).toEqual([22, 443, 65535]);
    });
  });

  describe('classifyDevice', () => {
    it('classifies likely printers', () => {
      const result = classifyDevice({
        vendor: 'HP Inc.',
        hostname: 'office-printer',
        openPorts: [631, 9100],
      });
      expect(result.deviceType).toBe('printer');
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('classifies likely routers', () => {
      const result = classifyDevice({
        vendor: 'TP-Link Technologies',
        hostname: 'home-router',
        openPorts: [53, 80, 443],
      });
      expect(result.deviceType).toBe('router');
      expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    });

    it('falls back to unknown when signal strength is weak', () => {
      const result = classifyDevice({
        vendor: '',
        hostname: 'mystery-box',
        openPorts: [12345],
      });
      expect(result.deviceType).toBe('unknown');
      expect(result.confidence).toBe(0.2);
    });
  });
});

