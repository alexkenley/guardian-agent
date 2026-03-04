# Network Threat Analysis — Feature Proposal

**Status:** Draft
**Date:** 2026-03-04
**Author:** Alex

## Overview

This proposal outlines a phased plan to evolve GuardianAgent's network capabilities from basic device discovery into a comprehensive network threat analysis platform. The goal is device intelligence, behavioral baselining, anomaly detection, and active threat identification — all integrated with the existing Guardian security pipeline.

Currently, GuardianAgent can discover devices via ARP/ping scans (`net_scan`) and list open ports (`net_portscan`). This proposal extends that foundation across six phases.

---

## Phase 1 — Device Intelligence

**Goal:** Classify every discovered device by type, vendor, and role.

### MAC OUI Vendor Lookup
- Bundle or download the IEEE OUI database (≈40K entries, ~2MB)
- Resolve MAC addresses → vendor names (e.g., `Apple`, `TP-Link`, `Espressif`)
- Update on startup or weekly via `https://standards-oui.ieee.org/oui/oui.csv`

### Port-to-Service Mapping
- Map well-known ports to services: 80→HTTP, 443→HTTPS, 22→SSH, 631→IPP (printer), 8080→HTTP-Alt, 554→RTSP (camera), etc.
- Maintain a configurable service map in config or a bundled JSON file

### Device Type Classification
- Heuristic classifier using vendor + open ports + hostname patterns:
  - **Router/Gateway**: vendor match (Netgear, TP-Link, Ubiquiti) + ports 80/443/53
  - **Printer**: IPP (631), LPD (515), JetDirect (9100), vendor match (HP, Brother, Canon)
  - **IP Camera**: RTSP (554), ONVIF (80/8080), vendor match (Hikvision, Reolink, Dahua)
  - **IoT Device**: vendor match (Espressif, Tuya, Shelly) + limited ports
  - **NAS**: SMB (445), NFS (2049), vendor match (Synology, QNAP)
  - **Smart TV / Media**: DLNA (8200), vendor match (Samsung, LG, Roku, Sonos)
  - **Phone/Tablet**: vendor match (Apple, Samsung, Google) + minimal ports
  - **PC/Workstation**: SSH (22) + SMB (445) + high port count
  - **Unknown**: fallback
- Confidence score (0–1) based on how many signals match

### Data Model Changes

Extend `DiscoveredDevice` interface:

```typescript
interface DiscoveredDevice {
  // existing fields
  ip: string;
  mac: string;
  hostname: string;
  status: 'online' | 'offline';
  openPorts: number[];
  firstSeen: string;
  lastSeen: string;

  // new fields (Phase 1)
  vendor?: string;           // e.g., "Apple, Inc."
  deviceType?: DeviceType;   // classified type
  deviceTypeConfidence?: number; // 0–1
  services?: ServiceInfo[];  // mapped from open ports
  userLabel?: string;        // user-assigned friendly name
  trusted?: boolean;         // user-marked as trusted
}

type DeviceType = 'router' | 'printer' | 'camera' | 'iot' | 'nas' | 'media' |
                  'phone' | 'tablet' | 'pc' | 'server' | 'unknown';

interface ServiceInfo {
  port: number;
  protocol: 'tcp' | 'udp';
  service: string;       // e.g., "HTTP", "SSH", "RTSP"
  version?: string;      // from banner grab (Phase 3)
}
```

### New Tools

| Tool | Category | Description |
|------|----------|-------------|
| `net_classify` | `network` | Classify a single device or all discovered devices |
| `net_oui_lookup` | `network` | Look up MAC vendor from OUI database |

---

## Phase 2 — Network Baseline & Anomaly Detection

**Goal:** Learn what "normal" looks like, then flag deviations.

### NetworkBaselineService

New runtime service (`src/runtime/network-baseline.ts`):

```typescript
class NetworkBaselineService {
  // Builds and maintains a baseline model of the network
  buildBaseline(): Promise<NetworkBaseline>;
  checkAnomaly(current: NetworkSnapshot): AnomalyReport;
  acknowledgeDevice(mac: string): void;  // suppress alerts for known device
}

interface NetworkBaseline {
  knownDevices: Map<string, BaselineDevice>;  // keyed by MAC
  typicalPortProfile: Map<DeviceType, number[]>;
  lastUpdated: string;
  snapshotCount: number;
}

interface AnomalyReport {
  anomalies: Anomaly[];
  riskScore: number;  // 0–100
  timestamp: string;
}
```

### Anomaly Detection Rules

| Rule | Severity | Trigger |
|------|----------|---------|
| **New Device** | Medium | MAC address not in baseline |
| **Port Change** | Low–Medium | Device gains/loses ports vs baseline |
| **ARP Spoofing** | Critical | Two devices claim the same IP, or MAC/IP mapping changes unexpectedly |
| **Unusual Service** | Medium | Device type running unexpected service (e.g., printer with SSH) |
| **Device Gone** | Low | Baselined device not seen for configurable period |
| **Mass Port Open** | High | Device suddenly exposes many new ports |

### NetworkSentinelAgent

New built-in agent that:
1. Subscribes to `network:scan:complete` events
2. Runs anomaly detection against the baseline after every scan
3. Emits `security:network:anomaly` events for findings
4. Auto-updates baseline with acknowledged changes
5. Can be scheduled via cron for periodic autonomous scans

### Auto-Trigger

- After every `net_scan` completes, emit `network:scan:complete` event
- NetworkSentinelAgent picks it up and runs anomaly checks
- Results appear in Security > Monitoring tab as alerts

---

## Phase 3 — Service Fingerprinting

**Goal:** Identify what software is running on open ports.

### Banner Grabbing

New tool `net_banner_grab`:
- Connect to open ports and read the service banner
- Protocol-aware readers:
  - **HTTP**: `HEAD /` → parse `Server:` header
  - **SSH**: Read version string (e.g., `SSH-2.0-OpenSSH_8.9`)
  - **SMTP**: Read `220` greeting
  - **FTP**: Read `220` greeting
  - **Generic**: Read first bytes with timeout
- Timeout: 3 seconds per port (configurable)
- Rate limit: max 5 concurrent connections per device

### Version Detection

- Parse banner strings into structured data:
  - `SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.6` → service: SSH, version: 8.9p1, os: Ubuntu
  - `Apache/2.4.52` → service: HTTP, version: 2.4.52, software: Apache
- Feed version data into `ServiceInfo.version` on the device record
- Cross-reference with known vulnerability databases (future: CVE lookup)

### New Tools

| Tool | Category | Description |
|------|----------|-------------|
| `net_banner_grab` | `network` | Grab service banners from open ports on a device |
| `net_fingerprint` | `network` | Full fingerprint: OUI + port scan + banner grab + classify |

---

## Phase 4 — WiFi Integration

**Goal:** Correlate WiFi clients with discovered network devices.

### Network Connection Config

Extend configuration to support multiple network connection types:

```yaml
assistant:
  network:
    connections:
      - id: home-lan
        type: lan
        interface: eth0
        subnet: 192.168.1.0/24
      - id: home-wifi
        type: wifi
        interface: wlan0
        ssid: MyNetwork
        scanInterval: 300  # seconds
```

### WiFi Scanning

Platform-specific WiFi client enumeration:

| Platform | Command | Data |
|----------|---------|------|
| Linux | `nmcli dev wifi list` | SSID, BSSID, signal, channel, security |
| macOS | `/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -s` | SSID, BSSID, RSSI, channel, security |
| Windows (WSL) | `netsh.exe wlan show networks mode=bssid` | SSID, BSSID, signal, channel, auth |

### Client Correlation

- Match WiFi client MAC addresses to discovered devices
- Detect rogue access points (unknown BSSIDs)
- Track WiFi signal strength over time for proximity analysis

### New Tools

| Tool | Category | Description |
|------|----------|-------------|
| `net_wifi_scan` | `network` | Scan for nearby WiFi networks and clients |
| `net_wifi_clients` | `network` | List connected WiFi clients (requires AP mode or router API) |

---

## Phase 5 — Traffic Analysis & Threat Detection

**Goal:** Monitor network traffic patterns and detect threats.

### Connection Flow Tracking

Track connections over time (not packet capture — connection metadata only):

```typescript
interface ConnectionFlow {
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  protocol: 'tcp' | 'udp';
  bytesIn: number;
  bytesOut: number;
  startTime: string;
  endTime?: string;
  service?: string;
}
```

Data sources:
- `ss` / `netstat` for local connections
- Router API integration (if available) for full network flows
- `conntrack` (Linux) for NAT/connection tracking

### Threat Detection Rules

| Rule | Severity | Trigger |
|------|----------|---------|
| **Data Exfiltration** | Critical | Device sends >threshold bytes to external IP in time window |
| **Port Scanning** | High | Single source touches >20 ports on target in <60s |
| **DNS Tunneling** | High | Unusually large or frequent DNS queries from a device |
| **Beaconing** | High | Periodic outbound connections at regular intervals (C2 indicator) |
| **Lateral Movement** | Critical | Internal device scanning other internal devices |
| **Unusual External** | Medium | Device connects to IP/country it's never contacted before |

### IP Reputation Integration

- Feed external destination IPs through existing `ThreatIntelService`
- Cross-reference with threat intel watchlists
- Auto-flag connections to known malicious IPs

### Automated Alerting

- Anomalies above configurable severity threshold → `security:network:threat` event
- Events consumed by SentinelAgent for triage and notification
- Alert deduplication: same (src, dst, rule) suppressed for configurable window

### New Tools

| Tool | Category | Description |
|------|----------|-------------|
| `net_connections` | `network` | List active network connections with flow metadata |
| `net_traffic_baseline` | `network` | Build/query traffic baseline for a device |
| `net_threat_check` | `network` | Run threat detection rules against recent flows |

---

## Phase 6 — Network Connection Types

**Goal:** Generalize network management across LAN, WiFi, VPN, and remote connections.

### Generalized Connection Config

```yaml
assistant:
  network:
    connections:
      - id: home-lan
        type: lan
        interface: eth0
        subnet: 192.168.1.0/24
        scanSchedule: "0 */4 * * *"    # every 4 hours
        autoBaseline: true

      - id: home-wifi
        type: wifi
        interface: wlan0
        ssid: MyNetwork
        scanSchedule: "*/15 * * * *"   # every 15 minutes
        wifiMonitoring: true

      - id: work-vpn
        type: vpn
        interface: tun0
        subnet: 10.0.0.0/8
        scanSchedule: "0 9-17 * * 1-5" # business hours weekdays
        scanOnConnect: true

      - id: vps-remote
        type: remote
        host: my-server.example.com
        sshUser: admin
        scanSchedule: "0 0 * * *"      # daily
        remoteScanCommand: "nmap -sn 192.168.1.0/24"
```

### Connection Types

| Type | Description | Scan Method |
|------|-------------|-------------|
| `lan` | Direct wired LAN | ARP scan, ping sweep |
| `wifi` | WiFi network | ARP scan + WiFi client enumeration |
| `vpn` | VPN tunnel | Ping sweep (ARP may not work) |
| `remote` | Remote network via SSH | SSH + remote scan command |

### Per-Connection Features

- Independent scan schedules per connection
- Separate baselines per connection
- Cross-connection device correlation (same MAC on multiple networks)
- Connection health monitoring (interface up/down, latency)
- Auto-detect active connections on startup

---

## UI Changes

### Network > Devices Tab Enhancements

- Add columns: Vendor, Type, Trust Status
- Device detail drawer with full profile (ports, services, banners, history)
- "Trust" / "Label" actions per device
- Device type icons (router, printer, camera, etc.)
- Filter/sort by type, vendor, status

### Network > Threats Tab (New)

- Anomaly timeline view
- Active threat cards with severity indicators
- Baseline status and coverage metrics
- Acknowledged vs unacknowledged anomaly counts

### Security > Monitoring Integration

- Network anomalies feed into existing security monitoring
- Unified alert view across all security subsystems

---

## Config Schema Changes

```yaml
assistant:
  network:
    # Device intelligence (Phase 1)
    deviceIntelligence:
      enabled: true
      ouiDatabase: bundled        # or "remote" for auto-update
      autoClassify: true          # classify on scan completion

    # Baseline & anomaly (Phase 2)
    baseline:
      enabled: true
      minSnapshotsForBaseline: 3  # scans before baseline is "ready"
      anomalyRules:
        newDevice: { enabled: true, severity: medium }
        portChange: { enabled: true, severity: low }
        arpSpoofing: { enabled: true, severity: critical }
        unusualService: { enabled: true, severity: medium }

    # Service fingerprinting (Phase 3)
    fingerprinting:
      enabled: true
      bannerTimeout: 3000         # ms per port
      maxConcurrentPerDevice: 5
      autoFingerprint: false      # auto-run after scan

    # WiFi (Phase 4)
    wifi:
      enabled: false
      platform: auto              # auto-detect or linux/macos/windows
      scanInterval: 300

    # Traffic analysis (Phase 5)
    trafficAnalysis:
      enabled: false
      dataSource: ss              # ss, conntrack, router-api
      flowRetention: 86400000     # 24h in ms
      threatRules:
        dataExfiltration: { enabled: true, thresholdMB: 100, windowMinutes: 60 }
        portScanning: { enabled: true, portThreshold: 20, windowSeconds: 60 }
        beaconing: { enabled: true, minIntervals: 10, tolerancePercent: 5 }

    # Connections (Phase 6)
    connections: []
```

---

## New Tools Summary

| Phase | Tool | Category | Risk | Description |
|-------|------|----------|------|-------------|
| 1 | `net_classify` | `network` | low | Classify device type from scan data |
| 1 | `net_oui_lookup` | `network` | low | MAC → vendor lookup |
| 2 | `net_baseline` | `network` | low | Build/query network baseline |
| 2 | `net_anomaly_check` | `network` | low | Run anomaly detection |
| 3 | `net_banner_grab` | `network` | medium | Grab service banners |
| 3 | `net_fingerprint` | `network` | medium | Full device fingerprint |
| 4 | `net_wifi_scan` | `network` | low | Scan WiFi networks |
| 4 | `net_wifi_clients` | `network` | low | List WiFi clients |
| 5 | `net_connections` | `network` | low | List active connections |
| 5 | `net_traffic_baseline` | `network` | low | Traffic baseline management |
| 5 | `net_threat_check` | `network` | low | Run threat detection rules |

All tools pass through Guardian admission pipeline. Tools with `medium` risk require `network` capability grant.

---

## Security Considerations

- **Banner grabbing** connects to arbitrary ports on the local network — must be capability-gated and rate-limited
- **WiFi scanning** may require elevated privileges on some platforms
- **Traffic analysis** touches connection metadata — never capture payload content
- **Remote scanning** involves SSH credentials — must go through Guardian secret scanning, never log credentials
- **OUI database** updates from external URL — validate integrity, pin to HTTPS
- **All network tools** already classified as `network` risk in Guardian, requiring explicit capability grants per agent

---

## Open Questions

1. **OUI database bundling vs runtime download?** Bundling adds ~2MB to the package but avoids network dependency. Could offer both with a config flag.

2. **Router API integration?** Many consumer routers expose APIs (UniFi, OpenWrt, DD-WRT, Mikrotik). Should we build adapters, or rely on connector packs?

3. **Privileged operations?** Some features (ARP cache, conntrack, WiFi monitor mode) need root or `CAP_NET_RAW`. Document clearly and degrade gracefully.

4. **Historical data retention?** How long to keep device history, connection flows, and anomaly records? SQLite vs flat file for network state?

5. **Phase ordering flexibility?** Phases 1–3 are sequential dependencies. Phases 4–6 could be built independently. Should we prioritize based on user demand?

---

## Implementation Priority

**Recommended order:** Phase 1 → Phase 2 → Phase 3 → Phase 5 → Phase 4 → Phase 6

Rationale: Device intelligence (1) and anomaly detection (2) provide the most immediate value. Service fingerprinting (3) enriches device data. Traffic analysis (5) addresses the most critical threat scenarios. WiFi (4) and multi-connection (6) are additive features that build on the foundation.
