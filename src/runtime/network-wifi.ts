/**
 * WiFi scan parsing helpers for Linux/macOS/Windows command outputs.
 */

import type { DiscoveredDevice } from './device-inventory.js';

export interface WifiNetwork {
  ssid: string;
  bssid: string;
  signalPercent: number;
  channel: string;
  security: string;
}

export interface WifiClient {
  ip?: string;
  mac: string;
  hostname?: string | null;
  vendor?: string;
  deviceType?: string;
  trusted?: boolean;
}

export function parseNmcliWifi(output: string): WifiNetwork[] {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const networks: WifiNetwork[] = [];
  for (const line of lines) {
    // Expected format: SSID:BSSID:SIGNAL:CHAN:SECURITY (BSSID may include escaped colons)
    const raw = line.split(':');
    if (raw.length < 5) continue;
    const security = raw.pop() ?? '';
    const channel = raw.pop() ?? '';
    const signalRaw = raw.pop() ?? '0';
    const bssidParts = raw.splice(raw.length - 6, 6);
    const bssid = bssidParts.join(':');
    const ssid = raw.join(':').replace(/\\:/g, ':');
    networks.push({
      ssid,
      bssid,
      signalPercent: clampSignal(Number(signalRaw)),
      channel,
      security: security || 'OPEN',
    });
  }
  return networks;
}

export function parseAirportWifi(output: string): WifiNetwork[] {
  const lines = output.split('\n').slice(1).map((line) => line.trim()).filter(Boolean);
  const networks: WifiNetwork[] = [];
  for (const line of lines) {
    const match = line.match(/^(.*?)\s+([0-9A-Fa-f:]{17})\s+(-?\d+)\s+([0-9,]+)\s+(.+)$/);
    if (!match) continue;
    const [, ssid, bssid, rssiRaw, channel, security] = match;
    const rssi = Number(rssiRaw);
    // Convert RSSI (-30 to -90 range) to rough percentage.
    const signalPercent = clampSignal(Math.round(((rssi + 100) / 70) * 100));
    networks.push({
      ssid: ssid.trim(),
      bssid,
      signalPercent,
      channel,
      security: security.trim() || 'OPEN',
    });
  }
  return networks;
}

export function parseNetshWifi(output: string): WifiNetwork[] {
  const lines = output.split('\n');
  const networks: WifiNetwork[] = [];
  let currentSsid = '';
  let currentSignal = 0;
  let currentAuth = '';

  for (const line of lines) {
    const ssidMatch = line.match(/^\s*SSID\s+\d+\s*:\s*(.*)$/i);
    if (ssidMatch) {
      currentSsid = ssidMatch[1].trim();
      currentSignal = 0;
      currentAuth = '';
      continue;
    }

    const authMatch = line.match(/^\s*Authentication\s*:\s*(.*)$/i);
    if (authMatch) {
      currentAuth = authMatch[1].trim();
      continue;
    }

    const signalMatch = line.match(/^\s*Signal\s*:\s*(\d+)%/i);
    if (signalMatch) {
      currentSignal = clampSignal(Number(signalMatch[1]));
      continue;
    }

    const bssidMatch = line.match(/^\s*BSSID\s+\d+\s*:\s*([0-9A-Fa-f:]{17})$/i);
    if (bssidMatch && currentSsid) {
      networks.push({
        ssid: currentSsid,
        bssid: bssidMatch[1],
        signalPercent: currentSignal,
        channel: '',
        security: currentAuth || 'UNKNOWN',
      });
    }
  }

  return networks;
}

export function correlateWifiClients(devices: DiscoveredDevice[]): WifiClient[] {
  return devices.map((device) => ({
    ip: device.ip,
    mac: device.mac,
    hostname: device.hostname,
    vendor: device.vendor,
    deviceType: device.deviceType,
    trusted: device.trusted,
  }));
}

function clampSignal(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
