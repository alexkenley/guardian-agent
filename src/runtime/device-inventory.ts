/**
 * Device inventory service for tracking discovered network devices.
 *
 * Maintains a Map of devices keyed by MAC address.
 * Updated from playbook run results (net_arp_scan, net_port_check outputs).
 * Persisted to ~/.guardianagent/device-inventory.json.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  classifyDevice,
  lookupOuiVendor,
  mapPortsToServices,
  type DeviceType,
  type ServiceInfo,
} from './network-intelligence.js';
import { mergeFingerprintsIntoServices, type BannerFingerprint } from './network-fingerprinting.js';

export interface DiscoveredDevice {
  ip: string;
  mac: string;
  hostname: string | null;
  openPorts: number[];
  vendor?: string;
  deviceType?: DeviceType;
  deviceTypeConfidence?: number;
  services?: ServiceInfo[];
  userLabel?: string;
  trusted?: boolean;
  firstSeen: number;
  lastSeen: number;
  status: 'online' | 'offline';
}

export interface DeviceEvent {
  type: 'network_new_device' | 'network_device_offline';
  device: DiscoveredDevice;
  timestamp: number;
}

const INVENTORY_FILE = resolve(homedir(), '.guardianagent', 'device-inventory.json');
const OFFLINE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export class DeviceInventoryService {
  private readonly devices = new Map<string, DiscoveredDevice>();
  private readonly eventListeners: Array<(event: DeviceEvent) => void> = [];
  private readonly now: () => number;
  private persistPath: string;

  constructor(options?: { now?: () => number; persistPath?: string }) {
    this.now = options?.now ?? Date.now;
    this.persistPath = options?.persistPath ?? INVENTORY_FILE;
  }

  /** Register event listener for new device / offline events. */
  onEvent(listener: (event: DeviceEvent) => void): void {
    this.eventListeners.push(listener);
  }

  /** Get all known devices. */
  listDevices(): DiscoveredDevice[] {
    this.refreshStatuses();
    return Array.from(this.devices.values()).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** Get device count. */
  get size(): number {
    return this.devices.size;
  }

  /**
   * Ingest results from a playbook run.
   * Looks for net_arp_scan and net_port_check outputs in step results.
   */
  ingestPlaybookResults(steps: Array<{ toolName: string; output?: unknown }>): void {
    const now = this.now();

    for (const step of steps) {
      if (step.toolName === 'net_arp_scan' && step.output && typeof step.output === 'object') {
        const arpOutput = step.output as { devices?: Array<{ ip: string; mac: string; state?: string }> };
        if (Array.isArray(arpOutput.devices)) {
          for (const device of arpOutput.devices) {
            if (!device.mac || device.mac === 'unknown' || !device.ip) continue;
            const key = device.mac.toLowerCase();
            const existing = this.devices.get(key);
            if (existing) {
              existing.ip = device.ip;
              existing.lastSeen = now;
              existing.status = 'online';
              this.refreshIntelligence(existing);
            } else {
              const newDevice: DiscoveredDevice = {
                ip: device.ip,
                mac: key,
                hostname: null,
                openPorts: [],
                firstSeen: now,
                lastSeen: now,
                status: 'online',
              };
              this.refreshIntelligence(newDevice);
              this.devices.set(key, newDevice);
              this.emit({ type: 'network_new_device', device: newDevice, timestamp: now });
            }
          }
        }
      }

      if (step.toolName === 'net_port_check' && step.output && typeof step.output === 'object') {
        const portOutput = step.output as { host: string; results?: Array<{ port: number; open: boolean }> };
        if (Array.isArray(portOutput.results) && portOutput.host) {
          // Find device by IP to attach ports
          for (const device of this.devices.values()) {
            if (device.ip === portOutput.host) {
              device.openPorts = portOutput.results
                .filter((r) => r.open)
                .map((r) => r.port);
              this.refreshIntelligence(device);
              break;
            }
          }
        }
      }

      if (step.toolName === 'net_dns_lookup' && step.output && typeof step.output === 'object') {
        const dnsOutput = step.output as { target: string; type: string; records?: string[] };
        if (dnsOutput.type === 'PTR' && Array.isArray(dnsOutput.records) && dnsOutput.records.length > 0) {
          for (const device of this.devices.values()) {
            if (device.ip === dnsOutput.target) {
              device.hostname = dnsOutput.records[0];
              this.refreshIntelligence(device);
              break;
            }
          }
        }
      }
    }

    this.persist().catch(() => {});
  }

  /**
   * Enrich a device record by IP with additional metadata/fingerprinting data.
   * Returns true when a device was found and updated.
   */
  updateDeviceByIp(ip: string, patch: {
    hostname?: string | null;
    openPorts?: number[];
    vendor?: string;
    fingerprints?: BannerFingerprint[];
  }): boolean {
    for (const device of this.devices.values()) {
      if (device.ip !== ip) continue;
      if (patch.hostname !== undefined) device.hostname = patch.hostname;
      if (Array.isArray(patch.openPorts)) device.openPorts = patch.openPorts;
      if (patch.vendor) device.vendor = patch.vendor;
      this.refreshIntelligence(device);
      if (Array.isArray(patch.fingerprints) && patch.fingerprints.length > 0 && device.services) {
        device.services = mergeFingerprintsIntoServices(device.services, patch.fingerprints);
      }
      this.persist().catch(() => {});
      return true;
    }
    return false;
  }

  /** Mark devices not seen recently as offline and emit events. */
  private refreshStatuses(): void {
    const now = this.now();
    for (const device of this.devices.values()) {
      if (device.status === 'online' && (now - device.lastSeen) > OFFLINE_THRESHOLD_MS) {
        device.status = 'offline';
        this.emit({ type: 'network_device_offline', device, timestamp: now });
      }
    }
  }

  private emit(event: DeviceEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch { /* best effort */ }
    }
  }

  /** Load device inventory from disk. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as DiscoveredDevice[];
      if (Array.isArray(data)) {
        for (const device of data) {
          if (device.mac) {
            const normalized: DiscoveredDevice = {
              ip: device.ip,
              mac: device.mac.toLowerCase(),
              hostname: device.hostname ?? null,
              openPorts: Array.isArray(device.openPorts) ? device.openPorts : [],
              firstSeen: device.firstSeen ?? this.now(),
              lastSeen: device.lastSeen ?? this.now(),
              status: device.status === 'offline' ? 'offline' : 'online',
              vendor: device.vendor,
              deviceType: device.deviceType,
              deviceTypeConfidence: device.deviceTypeConfidence,
              services: device.services,
              userLabel: device.userLabel,
              trusted: device.trusted,
            };
            this.refreshIntelligence(normalized);
            this.devices.set(normalized.mac, normalized);
          }
        }
      }
    } catch {
      // No existing inventory file — that's fine
    }
  }

  /** Persist device inventory to disk. */
  async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      const data = Array.from(this.devices.values());
      await writeFile(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Best effort — don't crash
    }
  }

  /** Refresh derived device intelligence fields from current observed data. */
  private refreshIntelligence(device: DiscoveredDevice): void {
    device.vendor = device.vendor ?? lookupOuiVendor(device.mac);
    device.services = mapPortsToServices(device.openPorts);
    const classification = classifyDevice({
      vendor: device.vendor,
      hostname: device.hostname,
      openPorts: device.openPorts,
    });
    device.deviceType = classification.deviceType;
    device.deviceTypeConfidence = classification.confidence;
  }
}
