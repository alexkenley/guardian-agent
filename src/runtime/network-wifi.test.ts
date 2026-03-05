import { describe, expect, it } from 'vitest';
import { parseAirportWifi, parseNetshWifi, parseNmcliWifi } from './network-wifi.js';

describe('network-wifi parsers', () => {
  it('parses nmcli compact output', () => {
    const output = 'HomeWiFi:AA:BB:CC:DD:EE:FF:78:11:WPA2\nGuest:11:22:33:44:55:66:42:6:OPEN';
    const networks = parseNmcliWifi(output);
    expect(networks.length).toBe(2);
    expect(networks[0].ssid).toBe('HomeWiFi');
    expect(networks[0].bssid).toBe('AA:BB:CC:DD:EE:FF');
    expect(networks[0].signalPercent).toBe(78);
  });

  it('parses macOS airport output', () => {
    const output = `SSID BSSID             RSSI CHANNEL HT CC SECURITY (auth/unicast/group)\nHomeWiFi AA:BB:CC:DD:EE:FF -55  1       Y  US WPA2(PSK/AES/AES)`;
    const networks = parseAirportWifi(output);
    expect(networks.length).toBe(1);
    expect(networks[0].ssid).toBe('HomeWiFi');
    expect(networks[0].bssid).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('parses windows netsh output', () => {
    const output = `
SSID 1 : HomeWiFi
    Authentication         : WPA2-Personal
    Signal                 : 82%
    BSSID 1                : aa:bb:cc:dd:ee:ff
`;
    const networks = parseNetshWifi(output);
    expect(networks.length).toBe(1);
    expect(networks[0].ssid).toBe('HomeWiFi');
    expect(networks[0].security).toContain('WPA2');
    expect(networks[0].signalPercent).toBe(82);
  });
});
