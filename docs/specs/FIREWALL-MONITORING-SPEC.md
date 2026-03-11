# Firewall Monitoring Spec

**Status:** Host firewall v1 implemented, gateway firewall designed  
**Date:** 2026-03-11

## Goal

Extend GuardianAgent self-monitoring so firewall posture changes are treated as first-class security signals, not just incidental system drift.

This covers two related but distinct surfaces:

- **Host firewall monitoring**
  - the local machine GuardianAgent is running on
- **Gateway firewall monitoring**
  - the router, edge firewall, or network security appliance protecting the local network

## Implemented Now

Host firewall monitoring is integrated into the existing workstation monitor and Guardian self-policing path.

### Current Runtime Coverage

- **Windows**
  - `netsh advfirewall show allprofiles state`
  - `netsh advfirewall firewall show rule name=all`
  - alerts for disabled/partially disabled firewall profiles
  - alerts for rule/configuration drift relative to baseline
- **Linux**
  - `ufw status verbose` when available
  - fallback to `nft list ruleset`
  - fallback to `iptables-save`
  - alerts for explicit `ufw` disablement
  - drift alerts for ruleset changes
- **macOS**
  - `pfctl -s info`
  - `pfctl -sr`
  - alerts for disabled `pf`
  - drift alerts for ruleset changes

### Guardian Integration

Firewall findings feed the same security path as other host anomalies:

- workstation checks emit `host_alert` audit events
- notification service emits `security:alert`
- Security UI shows posture and active alerts
- critical/high firewall alerts contribute to host-monitor self-policing decisions

This means GuardianAgent can stop itself from taking further risky actions when the local firewall posture degrades unexpectedly.

### Current Alert Families

- `firewall_disabled`
- `firewall_change`

## Current Data Model

Host monitor snapshot now includes firewall posture:

```ts
interface HostMonitorSnapshot {
  processCount: number;
  suspiciousProcesses: Array<{ pid: number; name: string }>;
  persistenceEntryCount: number;
  watchedPathCount: number;
  knownExternalDestinationCount: number;
  listeningPortCount: number;
  firewallBackend: string;
  firewallEnabled: boolean | null;
  firewallRuleCount: number;
}
```

## Design Principles

- Prefer explicit OS-native sources over inference.
- Treat firewall disablement as a stronger signal than generic ruleset drift.
- Keep firewall monitoring inside host monitoring for local posture, not as a separate unrelated subsystem.
- Normalize into existing audit/notification/self-policing pipelines rather than inventing a new alert stack.
- Separate **gateway** firewall work from **host** firewall work so trust boundaries remain clear.

## Gateway Firewall Design

Gateway firewall monitoring should be implemented as a separate service that correlates with, but does not merge into, host monitoring internals.

### Why Separate It

- the trust boundary is different
- credentials and network access are different
- the data source is usually remote API/SSH, not local OS commands
- action surfaces can be much broader than read-only posture checks

### Proposed Runtime Shape

- new service: `GatewaySecurityService`
- new audit event type:
  - `gateway_alert`
- optional event bus family:
  - `security:gateway:alert`
- optional tool surfaces:
  - `gateway_firewall_status`
  - `gateway_firewall_check`

### Gateway Signals to Baseline

- policy mode / firewall enabled state
- WAN allow/deny posture
- NAT / port forward drift
- admin account changes
- DNS / DHCP changes relevant to traffic steering
- IDS/IPS on/off state
- firmware version drift
- VPN exposure changes

### First Providers to Target

- OPNsense / pfSense
- UniFi gateways
- Firewalla
- MikroTik

## Correlation Rules

The long-term value is not just collecting firewall state. It is correlating firewall changes with local agent behavior.

Examples:

- suspicious process + new external destination + firewall relaxation
- new listening port + new port-forward on gateway
- persistence change + host firewall disabled
- policy downgrade + host firewall rule drift

These correlations should escalate severity faster than any one signal alone.

## Recommended Next Steps

1. Keep the current host firewall collectors as the baseline implementation.
2. Add Windows-specific deeper checks:
   - firewall service state
   - default inbound/outbound action extraction
   - helper-backed Defender correlation
3. Add Linux backend normalization:
   - explicit `nftables` and `iptables` policy parsing
4. Add macOS Application Firewall visibility if practical in addition to `pf`
5. Implement `GatewaySecurityService` with one provider first, preferably OPNsense/pfSense or UniFi.
6. Add cross-signal escalation rules between host, network, and gateway findings.

## Non-Goals

- full enterprise firewall management
- pushing mutating gateway firewall changes in v1
- pretending local host-firewall state alone is sufficient network security visibility
