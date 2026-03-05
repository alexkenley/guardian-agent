/**
 * Network intelligence helpers for device enrichment.
 *
 * Provides:
 * - MAC OUI vendor lookup (bundled starter map)
 * - Port-to-service mapping
 * - Heuristic device type classification with confidence scoring
 */

export type DeviceType =
  | 'router'
  | 'printer'
  | 'camera'
  | 'iot'
  | 'nas'
  | 'media'
  | 'phone'
  | 'tablet'
  | 'pc'
  | 'server'
  | 'unknown';

export interface ServiceInfo {
  port: number;
  protocol: 'tcp' | 'udp';
  service: string;
  version?: string;
}

export interface DeviceClassification {
  deviceType: DeviceType;
  confidence: number;
  matchedSignals: string[];
}

const PORT_SERVICE_MAP: Record<number, string> = {
  22: 'SSH',
  23: 'Telnet',
  53: 'DNS',
  80: 'HTTP',
  123: 'NTP',
  137: 'NetBIOS-NS',
  138: 'NetBIOS-DGM',
  139: 'NetBIOS-SSN',
  443: 'HTTPS',
  445: 'SMB',
  515: 'LPD',
  554: 'RTSP',
  631: 'IPP',
  2049: 'NFS',
  3306: 'MySQL',
  3389: 'RDP',
  5000: 'NAS-Web',
  5001: 'NAS-Web-SSL',
  5432: 'PostgreSQL',
  8080: 'HTTP-Alt',
  8200: 'DLNA',
  8443: 'HTTPS-Alt',
  9100: 'JetDirect',
  32400: 'Plex',
};

// Starter OUI vendor table (expand in later phase with bundled IEEE dataset).
const OUI_VENDOR_MAP: Record<string, string> = {
  'FCFBFB': 'Apple, Inc.',
  'DCA632': 'Raspberry Pi Trading Ltd',
  'B827EB': 'Raspberry Pi Foundation',
  'E4956E': 'Ubiquiti Inc.',
  'F4F26D': 'TP-Link Technologies',
  '24A43C': 'Ubiquiti Inc.',
  '3C5A37': 'Google, Inc.',
  '0017D5': 'Samsung Electronics',
  '3C2EF9': 'Hikvision Digital Technology',
  'C43DC7': 'Reolink Innovation',
  'A44B15': 'Dahua Technology',
  '00155D': 'QNAP Systems, Inc.',
  '001132': 'Synology Incorporated',
  '000CE7': 'HP Inc.',
  '0018F3': 'Brother Industries',
  '0009B0': 'Canon Inc.',
  '84F3EB': 'Espressif Inc.',
  '40F520': 'Tuya Smart Inc.',
  'C45BBE': 'Netgear',
  'C05627': 'ASUSTek COMPUTER INC.',
};

function normalizeHexMac(mac: string): string {
  return mac.toUpperCase().replace(/[^A-F0-9]/g, '');
}

/** Look up vendor by MAC OUI (first 24 bits). */
export function lookupOuiVendor(mac: string): string | undefined {
  const normalized = normalizeHexMac(mac);
  if (normalized.length < 6) return undefined;
  return OUI_VENDOR_MAP[normalized.slice(0, 6)];
}

/** Map open ports to well-known service names. */
export function mapPortsToServices(openPorts: number[]): ServiceInfo[] {
  const uniquePorts = [...new Set(openPorts.filter((p) => Number.isFinite(p) && p > 0))].sort((a, b) => a - b);
  return uniquePorts.map((port) => ({
    port,
    protocol: 'tcp',
    service: PORT_SERVICE_MAP[port] ?? 'Unknown',
  }));
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

/** Classify device type using vendor/hostname/open-port heuristics. */
export function classifyDevice(input: {
  vendor?: string;
  hostname?: string | null;
  openPorts: number[];
}): DeviceClassification {
  const vendor = (input.vendor ?? '').toLowerCase();
  const hostname = (input.hostname ?? '').toLowerCase();
  const ports = new Set(input.openPorts);

  const scores: Record<DeviceType, number> = {
    router: 0,
    printer: 0,
    camera: 0,
    iot: 0,
    nas: 0,
    media: 0,
    phone: 0,
    tablet: 0,
    pc: 0,
    server: 0,
    unknown: 0,
  };
  const signals: Record<DeviceType, string[]> = {
    router: [],
    printer: [],
    camera: [],
    iot: [],
    nas: [],
    media: [],
    phone: [],
    tablet: [],
    pc: [],
    server: [],
    unknown: [],
  };

  const add = (type: DeviceType, score: number, signal: string): void => {
    scores[type] += score;
    signals[type].push(signal);
  };

  if (containsAny(vendor, ['netgear', 'tp-link', 'ubiquiti', 'mikrotik', 'asus', 'cisco'])) {
    add('router', 2, 'router_vendor');
  }
  if ((ports.has(80) || ports.has(443)) && ports.has(53)) {
    add('router', 2, 'router_service_mix');
  }
  if (containsAny(hostname, ['router', 'gateway'])) {
    add('router', 2, 'router_hostname');
  }

  if (containsAny(vendor, ['hp', 'brother', 'canon', 'epson', 'lexmark'])) {
    add('printer', 2, 'printer_vendor');
  }
  for (const printerPort of [631, 515, 9100]) {
    if (ports.has(printerPort)) add('printer', 1, `printer_port_${printerPort}`);
  }
  if (containsAny(hostname, ['printer', 'print'])) {
    add('printer', 1, 'printer_hostname');
  }

  if (containsAny(vendor, ['hikvision', 'reolink', 'dahua', 'axis'])) {
    add('camera', 2, 'camera_vendor');
  }
  if (ports.has(554)) add('camera', 2, 'camera_rtsp');
  if (containsAny(hostname, ['camera', 'cam', 'cctv'])) add('camera', 1, 'camera_hostname');

  if (containsAny(vendor, ['espressif', 'tuya', 'shelly', 'sonoff'])) {
    add('iot', 2, 'iot_vendor');
  }
  if (ports.size > 0 && ports.size <= 3) add('iot', 1, 'iot_low_port_count');

  if (containsAny(vendor, ['synology', 'qnap', 'asustor'])) {
    add('nas', 2, 'nas_vendor');
  }
  for (const nasPort of [445, 2049, 5000, 5001]) {
    if (ports.has(nasPort)) add('nas', 1, `nas_port_${nasPort}`);
  }

  if (containsAny(vendor, ['roku', 'sonos', 'samsung', 'lg'])) {
    add('media', 1, 'media_vendor');
  }
  if (ports.has(8200) || ports.has(32400)) add('media', 1, 'media_port');

  if (containsAny(vendor, ['apple', 'samsung', 'google'])) {
    add('phone', 1, 'mobile_vendor');
  }
  if (ports.size <= 2) add('phone', 1, 'mobile_low_port_count');
  if (containsAny(hostname, ['ipad', 'tablet'])) add('tablet', 2, 'tablet_hostname');

  if (ports.has(22) && ports.has(445)) add('pc', 2, 'pc_ssh_smb');
  if (ports.size >= 4) add('pc', 1, 'pc_port_count');

  if ((ports.has(80) || ports.has(443)) && ports.has(22) && (ports.has(3306) || ports.has(5432))) {
    add('server', 3, 'server_web_db_mix');
  }
  if (ports.size >= 6) add('server', 1, 'server_port_count');

  const ranked = (Object.entries(scores) as Array<[DeviceType, number]>)
    .filter(([type]) => type !== 'unknown')
    .sort((a, b) => b[1] - a[1]);

  const [topType, topScore] = ranked[0] ?? ['unknown', 0];
  if (topScore < 2) {
    return { deviceType: 'unknown', confidence: 0.2, matchedSignals: [] };
  }

  const confidence = Math.min(0.95, Number((0.3 + topScore / 6).toFixed(2)));
  return {
    deviceType: topType,
    confidence,
    matchedSignals: signals[topType],
  };
}
