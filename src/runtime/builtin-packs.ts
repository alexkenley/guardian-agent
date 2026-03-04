/**
 * Built-in connector pack templates for zero-config network & system workflows.
 *
 * Each template bundles a connector pack with pre-configured playbooks.
 * Users can install templates from the web UI or API with one click —
 * no configuration, signatures, or dry-run gates required.
 */

import type {
  AssistantConnectorPackConfig,
  AssistantConnectorPlaybookDefinition,
} from '../config/types.js';
import type { ConnectorPlaybookService } from './connectors.js';

export interface BuiltinTemplate {
  id: string;
  name: string;
  description: string;
  category: 'network' | 'system' | 'security';
  pack: AssistantConnectorPackConfig;
  playbooks: AssistantConnectorPlaybookDefinition[];
}

/** All built-in templates. */
export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  // ── Home Network ───────────────────────────────────────────
  {
    id: 'home-network',
    name: 'Home Network',
    description: 'Discover and monitor devices on your local network. Includes network discovery and full infrastructure audit playbooks.',
    category: 'network',
    pack: {
      id: 'home-network',
      name: 'Home Network',
      enabled: true,
      description: 'Local network discovery and monitoring tools.',
      allowedCapabilities: ['network.read', 'system.read'],
      allowedHosts: [],
      allowedPaths: [],
      allowedCommands: [],
      authMode: 'none',
      requireHumanApprovalForWrites: false,
    },
    playbooks: [
      {
        id: 'network-discovery',
        name: 'Network Discovery',
        enabled: true,
        mode: 'sequential',
        description: 'Discover network interfaces, ARP devices, check gateway reachability, and verify DNS.',
        steps: [
          { id: 'nd-1', name: 'List interfaces', packId: 'home-network', toolName: 'net_interfaces', args: {} },
          { id: 'nd-2', name: 'ARP scan', packId: 'home-network', toolName: 'net_arp_scan', args: {} },
          { id: 'nd-3', name: 'Ping gateway', packId: 'home-network', toolName: 'net_ping', args: { host: '192.168.1.1', count: 3 }, continueOnError: true },
          { id: 'nd-4', name: 'DNS check', packId: 'home-network', toolName: 'net_dns_lookup', args: { target: 'google.com', type: 'A' }, continueOnError: true },
        ],
      },
      {
        id: 'full-audit',
        name: 'Full Infrastructure Audit',
        enabled: true,
        mode: 'sequential',
        description: 'Comprehensive system and network audit: OS info, resources, interfaces, devices, connections, processes, and local port scan.',
        steps: [
          { id: 'fa-1', name: 'System info', packId: 'home-network', toolName: 'sys_info', args: {} },
          { id: 'fa-2', name: 'Resources', packId: 'home-network', toolName: 'sys_resources', args: {} },
          { id: 'fa-3', name: 'Interfaces', packId: 'home-network', toolName: 'net_interfaces', args: {} },
          { id: 'fa-4', name: 'ARP scan', packId: 'home-network', toolName: 'net_arp_scan', args: {}, continueOnError: true },
          { id: 'fa-5', name: 'Connections', packId: 'home-network', toolName: 'net_connections', args: {}, continueOnError: true },
          { id: 'fa-6', name: 'Top processes', packId: 'home-network', toolName: 'sys_processes', args: { sortBy: 'cpu', limit: 15 }, continueOnError: true },
          { id: 'fa-7', name: 'Local port scan', packId: 'home-network', toolName: 'net_port_check', args: { host: 'localhost', ports: [22, 80, 443, 3306, 5432, 8080, 8443] }, continueOnError: true },
        ],
      },
    ],
  },

  // ── System Monitor ─────────────────────────────────────────
  {
    id: 'system-monitor',
    name: 'System Monitor',
    description: 'Monitor OS health: system info, resource usage, processes, and services.',
    category: 'system',
    pack: {
      id: 'system-monitor',
      name: 'System Monitor',
      enabled: true,
      description: 'OS health monitoring tools.',
      allowedCapabilities: ['system.read'],
      allowedHosts: [],
      allowedPaths: [],
      allowedCommands: [],
      authMode: 'none',
      requireHumanApprovalForWrites: false,
    },
    playbooks: [
      {
        id: 'system-health',
        name: 'System Health Check',
        enabled: true,
        mode: 'sequential',
        description: 'Full OS health check: system info, resource usage, top processes, and service status.',
        steps: [
          { id: 'sh-1', name: 'System info', packId: 'system-monitor', toolName: 'sys_info', args: {} },
          { id: 'sh-2', name: 'Resources', packId: 'system-monitor', toolName: 'sys_resources', args: {} },
          { id: 'sh-3', name: 'Top 20 processes', packId: 'system-monitor', toolName: 'sys_processes', args: { sortBy: 'cpu', limit: 20 } },
          { id: 'sh-4', name: 'Services', packId: 'system-monitor', toolName: 'sys_services', args: {}, continueOnError: true },
        ],
      },
    ],
  },

  // ── Security Audit ─────────────────────────────────────────
  {
    id: 'security-audit',
    name: 'Security Audit',
    description: 'Security-focused scanning: active connections, running processes, and open ports on localhost.',
    category: 'security',
    pack: {
      id: 'security-audit',
      name: 'Security Audit',
      enabled: true,
      description: 'Local security scanning tools.',
      allowedCapabilities: ['network.read', 'system.read'],
      allowedHosts: [],
      allowedPaths: [],
      allowedCommands: [],
      authMode: 'none',
      requireHumanApprovalForWrites: false,
    },
    playbooks: [
      {
        id: 'security-scan',
        name: 'Security Scan',
        enabled: true,
        mode: 'sequential',
        description: 'Check active connections, running processes, and scan localhost for common open ports.',
        steps: [
          { id: 'ss-1', name: 'Active connections', packId: 'security-audit', toolName: 'net_connections', args: {} },
          { id: 'ss-2', name: 'Top 30 processes', packId: 'security-audit', toolName: 'sys_processes', args: { sortBy: 'cpu', limit: 30 } },
          { id: 'ss-3', name: 'Localhost port scan', packId: 'security-audit', toolName: 'net_port_check', args: {
            host: 'localhost',
            ports: [21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 993, 995, 1433, 3306, 3389, 5432, 5900, 6379, 8080, 8443],
          }},
        ],
      },
    ],
  },
];

/**
 * Install a built-in template into a ConnectorPlaybookService instance.
 * Automatically enables the framework and playbook engine.
 */
export function installTemplate(
  templateId: string,
  service: ConnectorPlaybookService,
): { success: boolean; message: string } {
  const template = BUILTIN_TEMPLATES.find((t) => t.id === templateId);
  if (!template) {
    return { success: false, message: `Template '${templateId}' not found.` };
  }

  // Auto-enable the framework and playbook engine
  service.updateSettings({
    enabled: true,
    playbooks: {
      enabled: true,
      requireSignedDefinitions: false,
      requireDryRunOnFirstExecution: false,
    },
  });

  // Upsert the pack
  service.upsertPack(template.pack);

  // Upsert all playbooks
  for (const playbook of template.playbooks) {
    service.upsertPlaybook(playbook);
  }

  const playbookNames = template.playbooks.map((p) => p.name).join(', ');
  return {
    success: true,
    message: `Installed template '${template.name}' with ${template.playbooks.length} playbook(s): ${playbookNames}.`,
  };
}

/**
 * List all available templates with installation status.
 */
export function listTemplates(
  service: ConnectorPlaybookService,
): Array<BuiltinTemplate & { installed: boolean; playbookCount: number }> {
  const state = service.getState();
  const installedPackIds = new Set(state.packs.map((p) => p.id));

  return BUILTIN_TEMPLATES.map((template) => ({
    ...template,
    installed: installedPackIds.has(template.pack.id),
    playbookCount: template.playbooks.length,
  }));
}
