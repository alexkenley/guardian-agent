import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const FAKE_MODEL_NAME = 'cross-domain-orchestration-stress-model';
const stressHarnessPaths = {
  projectRoot: process.cwd(),
  scratchDir: path.join(os.tmpdir(), 'guardian-cross-domain-stress-scratch'),
  appPort: 0,
};

const STRESS_CASES = [
  {
    id: 'orchestrated-general',
    prompt: 'I am new and probably mixing things up: save a Second Brain note that Harbor follow-up is risky, create a daily automation to remind me at 8 AM, inspect this repo for where automations render, then check whm_status for profileId social and assistant_security_summary. Do not edit code.',
    decision: {
      route: 'general_assistant',
      confidence: 'high',
      operation: 'run',
      summary: 'Coordinate Second Brain, automation, repo inspection, cloud status, and security summary work.',
      turnRelation: 'new_request',
      resolution: 'ready',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
      planned_steps: [
        {
          kind: 'write',
          summary: 'Save the requested Harbor follow-up note in Second Brain.',
          expectedToolCategories: ['second_brain_note_upsert'],
          required: true,
        },
        {
          kind: 'write',
          summary: 'Create the daily reminder automation.',
          expectedToolCategories: ['automation_save'],
          required: true,
          dependsOn: ['step_1'],
        },
        {
          kind: 'search',
          summary: 'Inspect the repo for automation rendering files without editing code.',
          expectedToolCategories: ['fs_search', 'code_symbol_search'],
          required: true,
          dependsOn: ['step_2'],
        },
        {
          kind: 'tool_call',
          summary: 'Check WHM status for profileId social.',
          expectedToolCategories: ['whm_status'],
          required: true,
          dependsOn: ['step_3'],
        },
        {
          kind: 'tool_call',
          summary: 'Summarize Assistant Security posture.',
          expectedToolCategories: ['assistant_security_summary'],
          required: true,
          dependsOn: ['step_4'],
        },
        {
          kind: 'answer',
          summary: 'Return a concise cross-domain status summary.',
          required: true,
          dependsOn: ['step_5'],
        },
      ],
    },
  },
  {
    id: 'bad-personal-route',
    prompt: 'Make a note that Harbor cleanup matters and create an automation to remind me every weekday. I do not know the right page, just do it.',
    decision: {
      route: 'personal_assistant_task',
      confidence: 'high',
      operation: 'create',
      summary: 'Create a Second Brain note and a reminder automation.',
      turnRelation: 'new_request',
      resolution: 'ready',
      executionClass: 'direct_assistant',
      preferredTier: 'local',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
      personalItemType: 'note',
      planned_steps: [
        {
          kind: 'write',
          summary: 'Create the Harbor cleanup Second Brain note.',
          expectedToolCategories: ['second_brain_note_upsert'],
          required: true,
        },
        {
          kind: 'write',
          summary: 'Create the weekday reminder automation.',
          expectedToolCategories: ['automation_save'],
          required: true,
          dependsOn: ['step_1'],
        },
      ],
    },
  },
  {
    id: 'bad-automation-route',
    prompt: 'Create an automation that checks the Guardian repo for TODOs, saves a Second Brain task for anything urgent, checks whm_status profileId social, and summarizes assistant_security_findings.',
    decision: {
      route: 'automation_authoring',
      confidence: 'high',
      operation: 'create',
      summary: 'Create an automation and coordinate repo, Second Brain, cloud, and security follow-up work.',
      turnRelation: 'new_request',
      resolution: 'ready',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
      planned_steps: [
        {
          kind: 'write',
          summary: 'Create the requested automation definition.',
          expectedToolCategories: ['automation_save'],
          required: true,
        },
        {
          kind: 'search',
          summary: 'Search the Guardian repo for TODOs.',
          expectedToolCategories: ['fs_search'],
          required: true,
          dependsOn: ['step_1'],
        },
        {
          kind: 'write',
          summary: 'Save an urgent Second Brain task if TODO evidence warrants it.',
          expectedToolCategories: ['second_brain_task_upsert'],
          required: true,
          dependsOn: ['step_2'],
        },
        {
          kind: 'tool_call',
          summary: 'Check WHM status for profileId social.',
          expectedToolCategories: ['whm_status'],
          required: true,
          dependsOn: ['step_3'],
        },
        {
          kind: 'tool_call',
          summary: 'Summarize Assistant Security findings.',
          expectedToolCategories: ['assistant_security_findings'],
          required: true,
          dependsOn: ['step_4'],
        },
      ],
    },
  },
  {
    id: 'security-cloud-operator',
    prompt: 'I might be mixing security things up: check assistant_security_summary, assistant_security_findings, security_posture_status, host_monitor_status, windows_defender_status, and whm_status for profileId social. If anything looks concerning, save a Second Brain task and create a weekly automation to rerun the security posture check. Do not change app guardrails.',
    decision: {
      route: 'security_task',
      confidence: 'high',
      operation: 'inspect',
      summary: 'Coordinate Assistant Security, host protection, WHM status, Second Brain follow-up, and security automation work.',
      turnRelation: 'new_request',
      resolution: 'ready',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
      planned_steps: [
        {
          kind: 'tool_call',
          summary: 'Read Assistant Security summary.',
          expectedToolCategories: ['assistant_security_summary'],
          required: true,
        },
        {
          kind: 'tool_call',
          summary: 'Read Assistant Security findings.',
          expectedToolCategories: ['assistant_security_findings'],
          required: true,
          dependsOn: ['step_1'],
        },
        {
          kind: 'tool_call',
          summary: 'Read overall security posture.',
          expectedToolCategories: ['security_posture_status'],
          required: true,
          dependsOn: ['step_2'],
        },
        {
          kind: 'tool_call',
          summary: 'Read host monitor status.',
          expectedToolCategories: ['host_monitor_status'],
          required: true,
          dependsOn: ['step_3'],
        },
        {
          kind: 'tool_call',
          summary: 'Read native Windows Defender status.',
          expectedToolCategories: ['windows_defender_status'],
          required: true,
          dependsOn: ['step_4'],
        },
        {
          kind: 'tool_call',
          summary: 'Check WHM social profile status.',
          expectedToolCategories: ['whm_status'],
          required: true,
          dependsOn: ['step_5'],
        },
        {
          kind: 'write',
          summary: 'Create a Second Brain follow-up task for concerning posture.',
          expectedToolCategories: ['second_brain_task_upsert'],
          required: true,
          dependsOn: ['step_6'],
        },
        {
          kind: 'write',
          summary: 'Create a weekly security posture automation.',
          expectedToolCategories: ['automation_save'],
          required: true,
          dependsOn: ['step_7'],
        },
        {
          kind: 'answer',
          summary: 'Return a concise operator-facing security/cloud status summary.',
          required: true,
          dependsOn: ['step_8'],
        },
      ],
    },
  },
  {
    id: 'web-browser-network-operator',
    prompt: 'I am trying to check a public page but I do not know the right tool: web search for Guardian Agent browser automation, fetch https://example.com, open it in the browser and read it, check DNS for example.com, then create a weekly automation to rerun the public page check.',
    decision: {
      route: 'general_assistant',
      confidence: 'high',
      operation: 'run',
      summary: 'Coordinate web search, web fetch, browser read, DNS diagnostics, and automation follow-up work.',
      turnRelation: 'new_request',
      resolution: 'ready',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
      planned_steps: [
        {
          kind: 'tool_call',
          summary: 'Search the web for Guardian Agent browser automation.',
          expectedToolCategories: ['web_search'],
          required: true,
        },
        {
          kind: 'tool_call',
          summary: 'Fetch the public example.com page.',
          expectedToolCategories: ['web_fetch'],
          required: true,
          dependsOn: ['step_1'],
        },
        {
          kind: 'tool_call',
          summary: 'Check browser wrapper availability.',
          expectedToolCategories: ['browser_capabilities'],
          required: true,
          dependsOn: ['step_2'],
        },
        {
          kind: 'tool_call',
          summary: 'Navigate the browser to example.com.',
          expectedToolCategories: ['browser_navigate'],
          required: true,
          dependsOn: ['step_3'],
        },
        {
          kind: 'tool_call',
          summary: 'Read the browser page.',
          expectedToolCategories: ['browser_read'],
          required: true,
          dependsOn: ['step_4'],
        },
        {
          kind: 'tool_call',
          summary: 'Check DNS for example.com.',
          expectedToolCategories: ['net_dns_lookup'],
          required: true,
          dependsOn: ['step_5'],
        },
        {
          kind: 'write',
          summary: 'Create a weekly public page check automation.',
          expectedToolCategories: ['automation_save'],
          required: true,
          dependsOn: ['step_6'],
        },
        {
          kind: 'answer',
          summary: 'Return a concise web/browser/network summary.',
          required: true,
          dependsOn: ['step_7'],
        },
      ],
    },
  },
  {
    id: 'workspace-email-contacts-operator',
    prompt: 'I might be confusing Gmail and contacts: look up the Gmail list schema, draft a Gmail note to operator@example.com saying the browser check passed, discover contacts from https://example.com, list contacts, create a local campaign for the discovered contacts, then give me a short status.',
    decision: {
      route: 'general_assistant',
      confidence: 'high',
      operation: 'run',
      summary: 'Coordinate Google Workspace discovery, Gmail drafting, contact discovery, and local campaign work.',
      turnRelation: 'new_request',
      resolution: 'ready',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
      planned_steps: [
        {
          kind: 'tool_call',
          summary: 'Look up Gmail message list schema.',
          expectedToolCategories: ['gws_schema'],
          required: true,
        },
        {
          kind: 'write',
          summary: 'Draft the requested Gmail note.',
          expectedToolCategories: ['gmail_draft'],
          required: true,
          dependsOn: ['step_1'],
        },
        {
          kind: 'tool_call',
          summary: 'Discover contacts from the public page.',
          expectedToolCategories: ['contacts_discover_browser'],
          required: true,
          dependsOn: ['step_2'],
        },
        {
          kind: 'read',
          summary: 'List local marketing contacts.',
          expectedToolCategories: ['contacts_list'],
          required: true,
          dependsOn: ['step_3'],
        },
        {
          kind: 'write',
          summary: 'Create a local campaign for review.',
          expectedToolCategories: ['campaign_create'],
          required: true,
          dependsOn: ['step_4'],
        },
        {
          kind: 'answer',
          summary: 'Return a concise workspace/email/contact summary.',
          required: true,
          dependsOn: ['step_5'],
        },
      ],
    },
  },
  {
    id: 'intel-doc-search-network-operator',
    prompt: 'Coordinate an operator research workflow: check intel_summary and intel_findings, check doc_search_status and search docs for orchestration approvals, run net_dns_lookup for example.com, then save a Second Brain task for any follow-up. Use the tool loop.',
    acceptableTraceRoutes: ['general_assistant', 'security_task'],
    decision: {
      route: 'general_assistant',
      confidence: 'high',
      operation: 'run',
      summary: 'Coordinate threat-intel, document search, DNS diagnostics, and Second Brain follow-up work.',
      turnRelation: 'new_request',
      resolution: 'ready',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
      planned_steps: [
        {
          kind: 'tool_call',
          summary: 'Read threat-intel summary.',
          expectedToolCategories: ['intel_summary'],
          required: true,
        },
        {
          kind: 'tool_call',
          summary: 'Read threat-intel findings.',
          expectedToolCategories: ['intel_findings'],
          required: true,
          dependsOn: ['step_1'],
        },
        {
          kind: 'tool_call',
          summary: 'Check document search index status.',
          expectedToolCategories: ['doc_search_status'],
          required: true,
          dependsOn: ['step_2'],
        },
        {
          kind: 'search',
          summary: 'Search indexed docs for orchestration approvals.',
          expectedToolCategories: ['doc_search'],
          required: true,
          dependsOn: ['step_3'],
        },
        {
          kind: 'tool_call',
          summary: 'Check DNS for example.com.',
          expectedToolCategories: ['net_dns_lookup'],
          required: true,
          dependsOn: ['step_4'],
        },
        {
          kind: 'write',
          summary: 'Create a Second Brain follow-up task.',
          expectedToolCategories: ['second_brain_task_upsert'],
          required: true,
          dependsOn: ['step_5'],
        },
        {
          kind: 'answer',
          summary: 'Return a concise research and follow-up summary.',
          required: true,
          dependsOn: ['step_6'],
        },
      ],
    },
  },
  {
    id: 'second-brain-routine-brief-operator',
    prompt: 'I am trying to organize my week and I might be mixing the Second Brain features: create a planning calendar event, save Pat Example as a work contact, save https://example.com as a library reference, check the routine catalog, create a topic-watch routine, generate a morning brief, run the horizon scan, then list the overview, calendar, routines, briefs, people, library, and usage summary.',
    decision: {
      route: 'personal_assistant_task',
      confidence: 'high',
      operation: 'create',
      summary: 'Coordinate rich Second Brain calendar, people, library, routine, brief, horizon, and overview work.',
      turnRelation: 'new_request',
      resolution: 'ready',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
      personalItemType: 'task',
      planned_steps: [
        {
          kind: 'write',
          summary: 'Create the requested planning calendar event.',
          expectedToolCategories: ['second_brain_calendar_upsert'],
          required: true,
        },
        {
          kind: 'write',
          summary: 'Save Pat Example as a Second Brain contact.',
          expectedToolCategories: ['second_brain_person_upsert'],
          required: true,
          dependsOn: ['step_1'],
        },
        {
          kind: 'write',
          summary: 'Save the library reference.',
          expectedToolCategories: ['second_brain_library_upsert'],
          required: true,
          dependsOn: ['step_2'],
        },
        {
          kind: 'read',
          summary: 'Check the routine catalog.',
          expectedToolCategories: ['second_brain_routine_catalog'],
          required: true,
          dependsOn: ['step_3'],
        },
        {
          kind: 'write',
          summary: 'Create a topic-watch Second Brain routine.',
          expectedToolCategories: ['second_brain_routine_create'],
          required: true,
          dependsOn: ['step_4'],
        },
        {
          kind: 'write',
          summary: 'Generate a morning brief.',
          expectedToolCategories: ['second_brain_generate_brief'],
          required: true,
          dependsOn: ['step_5'],
        },
        {
          kind: 'write',
          summary: 'Run the horizon scan.',
          expectedToolCategories: ['second_brain_horizon_scan'],
          required: true,
          dependsOn: ['step_6'],
        },
        {
          kind: 'read',
          summary: 'Read the Second Brain overview and related lists.',
          expectedToolCategories: ['second_brain_overview', 'second_brain_calendar_list', 'second_brain_routine_list', 'second_brain_brief_list', 'second_brain_people_list', 'second_brain_library_list', 'second_brain_usage'],
          required: true,
          dependsOn: ['step_7'],
        },
        {
          kind: 'answer',
          summary: 'Return a concise operator summary of the Second Brain changes and current state.',
          required: true,
          dependsOn: ['step_8'],
        },
      ],
    },
  },
  {
    id: 'browser-extraction-state-operator',
    prompt: 'Use the browser tools on https://example.com like an operator who does not know the right command: check capabilities, navigate, list links, extract structured and semantic data, capture browser state, list interactive targets, then save a Second Brain note with the public page summary.',
    acceptableTraceRoutes: ['general_assistant', 'personal_assistant_task'],
    decision: {
      route: 'general_assistant',
      confidence: 'high',
      operation: 'run',
      summary: 'Coordinate browser capability, navigation, extraction, interactive-state listing, and Second Brain note work.',
      turnRelation: 'new_request',
      resolution: 'ready',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
      planned_steps: [
        {
          kind: 'tool_call',
          summary: 'Check browser wrapper capabilities.',
          expectedToolCategories: ['browser_capabilities'],
          required: true,
        },
        {
          kind: 'tool_call',
          summary: 'Navigate to example.com.',
          expectedToolCategories: ['browser_navigate'],
          required: true,
          dependsOn: ['step_1'],
        },
        {
          kind: 'tool_call',
          summary: 'List page links.',
          expectedToolCategories: ['browser_links'],
          required: true,
          dependsOn: ['step_2'],
        },
        {
          kind: 'tool_call',
          summary: 'Extract page metadata and semantic structure.',
          expectedToolCategories: ['browser_extract'],
          required: true,
          dependsOn: ['step_3'],
        },
        {
          kind: 'tool_call',
          summary: 'Capture browser state.',
          expectedToolCategories: ['browser_state'],
          required: true,
          dependsOn: ['step_4'],
        },
        {
          kind: 'tool_call',
          summary: 'List interactive browser targets through the compatibility wrapper.',
          expectedToolCategories: ['browser_interact'],
          required: true,
          dependsOn: ['step_5'],
        },
        {
          kind: 'write',
          summary: 'Save a Second Brain note with the public page summary.',
          expectedToolCategories: ['second_brain_note_upsert'],
          required: true,
          dependsOn: ['step_6'],
        },
        {
          kind: 'answer',
          summary: 'Return a concise browser extraction summary.',
          required: true,
          dependsOn: ['step_7'],
        },
      ],
    },
  },
  {
    id: 'automation-control-output-operator',
    prompt: 'I created automations earlier and now I want to control them: create a simple step-based automation for output checks, list automations, dry-run that automation, disable it, search stored automation output for public page checks, then create a Second Brain task with the result.',
    decision: {
      route: 'automation_authoring',
      confidence: 'high',
      operation: 'update',
      summary: 'Coordinate automation listing, enablement control, dry-run execution, output search, and Second Brain follow-up work.',
      turnRelation: 'new_request',
      resolution: 'ready',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
      planned_steps: [
        {
          kind: 'write',
          summary: 'Create a simple step-based automation for output checks.',
          expectedToolCategories: ['automation_save'],
          required: true,
        },
        {
          kind: 'read',
          summary: 'List saved automations.',
          expectedToolCategories: ['automation_list'],
          required: true,
          dependsOn: ['step_1'],
        },
        {
          kind: 'write',
          summary: 'Dry-run the same automation.',
          expectedToolCategories: ['automation_run'],
          required: true,
          dependsOn: ['step_2'],
        },
        {
          kind: 'write',
          summary: 'Disable the same automation.',
          expectedToolCategories: ['automation_set_enabled'],
          required: true,
          dependsOn: ['step_3'],
        },
        {
          kind: 'read',
          summary: 'Search stored automation output for public page checks.',
          expectedToolCategories: ['automation_output_search'],
          required: true,
          dependsOn: ['step_4'],
        },
        {
          kind: 'write',
          summary: 'Create a Second Brain follow-up task with the result.',
          expectedToolCategories: ['second_brain_task_upsert'],
          required: true,
          dependsOn: ['step_5'],
        },
        {
          kind: 'answer',
          summary: 'Return a concise automation control summary.',
          required: true,
          dependsOn: ['step_6'],
        },
      ],
    },
  },
  {
    id: 'filesystem-coding-scratch-operator',
    prompt: 'Treat this as a safe scratch coding workflow, not a repo edit: make a temp scratch folder, write a small note file, read it, copy it, rename the copy, list and search the scratch folder, create or attach a coding session for this repo, show the current session, make a code plan, search symbols for WorkerManager, show git diff, and create one scratch TypeScript file under the temp folder.',
    decision: {
      route: 'coding_task',
      confidence: 'high',
      operation: 'create',
      summary: 'Coordinate safe scratch filesystem operations with backend coding session, planning, search, diff, and scratch file creation.',
      turnRelation: 'new_request',
      resolution: 'ready',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
      planned_steps: [
        {
          kind: 'write',
          summary: 'Create a temp scratch folder.',
          expectedToolCategories: ['fs_mkdir'],
          required: true,
        },
        {
          kind: 'write',
          summary: 'Write a scratch note file.',
          expectedToolCategories: ['fs_write'],
          required: true,
          dependsOn: ['step_1'],
        },
        {
          kind: 'read',
          summary: 'Read, copy, rename, list, and search the scratch material.',
          expectedToolCategories: ['fs_read', 'fs_copy', 'fs_move', 'fs_list', 'fs_search'],
          required: true,
          dependsOn: ['step_2'],
        },
        {
          kind: 'tool_call',
          summary: 'Create and inspect a backend coding session.',
          expectedToolCategories: ['code_session_create', 'code_session_current'],
          required: true,
          dependsOn: ['step_3'],
        },
        {
          kind: 'tool_call',
          summary: 'Generate a code plan, search symbols, and inspect git diff.',
          expectedToolCategories: ['code_plan', 'code_symbol_search', 'code_git_diff'],
          required: true,
          dependsOn: ['step_4'],
        },
        {
          kind: 'write',
          summary: 'Create a scratch TypeScript file under the temp folder.',
          expectedToolCategories: ['code_create'],
          required: true,
          dependsOn: ['step_5'],
        },
        {
          kind: 'answer',
          summary: 'Return a concise scratch coding workflow summary.',
          required: true,
          dependsOn: ['step_6'],
        },
      ],
    },
  },
  {
    id: 'system-network-diagnostics-operator',
    prompt: 'I am not sure whether this is system, network, or security: show system info, resources, top processes, network interfaces and connections, ping localhost, check the app port on localhost, and include a local MAC OUI lookup. Do not change anything.',
    decision: {
      route: 'security_task',
      confidence: 'high',
      operation: 'inspect',
      summary: 'Coordinate read-only local system and network diagnostic tools.',
      turnRelation: 'new_request',
      resolution: 'ready',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
      planned_steps: [
        {
          kind: 'tool_call',
          summary: 'Read system info and resources.',
          expectedToolCategories: ['sys_info', 'sys_resources'],
          required: true,
        },
        {
          kind: 'tool_call',
          summary: 'Read top processes.',
          expectedToolCategories: ['sys_processes'],
          required: true,
          dependsOn: ['step_1'],
        },
        {
          kind: 'tool_call',
          summary: 'Read network interfaces and connections.',
          expectedToolCategories: ['net_interfaces', 'net_connections'],
          required: true,
          dependsOn: ['step_2'],
        },
        {
          kind: 'tool_call',
          summary: 'Run localhost ping and app port diagnostics.',
          expectedToolCategories: ['net_ping', 'net_port_check'],
          required: true,
          dependsOn: ['step_3'],
        },
        {
          kind: 'tool_call',
          summary: 'Run a local MAC OUI lookup.',
          expectedToolCategories: ['net_oui_lookup'],
          required: true,
          dependsOn: ['step_4'],
        },
        {
          kind: 'answer',
          summary: 'Return a concise system and network diagnostic summary.',
          required: true,
          dependsOn: ['step_5'],
        },
      ],
    },
  },
];

const FOLLOW_UP_HISTORY_INITIAL_PROMPT = 'Check assistant_security_summary and security_posture_status, then tell me the main concern I should watch.';
const FOLLOW_UP_HISTORY_PROMPT = 'Using the security summary and posture from that last answer, create a Second Brain task for the concern and a weekly automation to revisit it. Do not make me restate the details.';
const FOLLOW_UP_HISTORY_USER_ID = 'history-harness';

const FOLLOW_UP_HISTORY_CASES = [
  {
    id: 'history-reference-initial',
    prompt: FOLLOW_UP_HISTORY_INITIAL_PROMPT,
    decision: {
      route: 'security_task',
      confidence: 'high',
      operation: 'inspect',
      summary: 'Check Assistant Security summary and security posture.',
      turnRelation: 'new_request',
      resolution: 'ready',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
      planned_steps: [
        {
          kind: 'tool_call',
          summary: 'Read Assistant Security summary.',
          expectedToolCategories: ['assistant_security_summary'],
          required: true,
        },
        {
          kind: 'tool_call',
          summary: 'Read overall security posture.',
          expectedToolCategories: ['security_posture_status'],
          required: true,
          dependsOn: ['step_1'],
        },
        {
          kind: 'answer',
          summary: 'Return the status and concern to watch.',
          required: true,
          dependsOn: ['step_2'],
        },
      ],
    },
  },
  {
    id: 'history-reference-follow-up',
    prompt: FOLLOW_UP_HISTORY_PROMPT,
    decision: {
      route: 'general_assistant',
      confidence: 'high',
      operation: 'create',
      summary: 'Use prior security context to create a Second Brain task and weekly automation.',
      turnRelation: 'follow_up',
      resolution: 'ready',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'medium',
      preferredAnswerPath: 'tool_loop',
      simpleVsComplex: 'complex',
      planned_steps: [
        {
          kind: 'tool_call',
          summary: 'Refresh Assistant Security findings from the prior security context.',
          expectedToolCategories: ['assistant_security_findings'],
          required: true,
        },
        {
          kind: 'tool_call',
          summary: 'Refresh the security posture from the prior security context.',
          expectedToolCategories: ['security_posture_status'],
          required: true,
          dependsOn: ['step_1'],
        },
        {
          kind: 'write',
          summary: 'Create a Second Brain follow-up task based on the prior concern.',
          expectedToolCategories: ['second_brain_task_upsert'],
          required: true,
          dependsOn: ['step_2'],
        },
        {
          kind: 'write',
          summary: 'Create a weekly automation to revisit the same security/cloud posture.',
          expectedToolCategories: ['automation_save'],
          required: true,
          dependsOn: ['step_3'],
        },
        {
          kind: 'answer',
          summary: 'Confirm what was created and explicitly reference the reused security context.',
          required: true,
          dependsOn: ['step_4'],
        },
      ],
    },
  },
];

const ALL_STRESS_CASES = [...STRESS_CASES, ...FOLLOW_UP_HISTORY_CASES];

const STRESS_TOOL_SEQUENCES = {
  'orchestrated-general': [
    'second_brain_note_upsert',
    'automation_save',
    'fs_search',
    'whm_status',
    'assistant_security_summary',
  ],
  'bad-personal-route': [
    'second_brain_note_upsert',
    'automation_save',
  ],
  'bad-automation-route': [
    'automation_save',
    'fs_search',
    'second_brain_task_upsert',
    'whm_status',
    'assistant_security_findings',
  ],
  'security-cloud-operator': [
    'assistant_security_summary',
    'assistant_security_findings',
    'security_posture_status',
    'host_monitor_status',
    'windows_defender_status',
    'whm_status',
    'second_brain_task_upsert',
    'automation_save',
  ],
  'web-browser-network-operator': [
    'web_search',
    'web_fetch',
    'browser_capabilities',
    'browser_navigate',
    'browser_read',
    'net_dns_lookup',
    'automation_save',
  ],
  'workspace-email-contacts-operator': [
    'gws_schema',
    'gmail_draft',
    'contacts_discover_browser',
    'contacts_list',
    'campaign_create',
  ],
  'intel-doc-search-network-operator': [
    'intel_summary',
    'intel_findings',
    'doc_search_status',
    'doc_search',
    'net_dns_lookup',
    'second_brain_task_upsert',
  ],
  'second-brain-routine-brief-operator': [
    'second_brain_calendar_upsert',
    'second_brain_person_upsert',
    'second_brain_library_upsert',
    'second_brain_routine_catalog',
    'second_brain_routine_create',
    'second_brain_generate_brief',
    'second_brain_horizon_scan',
    'second_brain_overview',
    'second_brain_calendar_list',
    'second_brain_routine_list',
    'second_brain_brief_list',
    'second_brain_people_list',
    'second_brain_library_list',
    'second_brain_usage',
  ],
  'browser-extraction-state-operator': [
    'browser_capabilities',
    'browser_navigate',
    'browser_links',
    'browser_extract',
    'browser_state',
    'browser_interact',
    'second_brain_note_upsert',
  ],
  'automation-control-output-operator': [
    'automation_save',
    'automation_list',
    'automation_run',
    'automation_set_enabled',
    'automation_output_search',
    'second_brain_task_upsert',
  ],
  'filesystem-coding-scratch-operator': [
    'fs_mkdir',
    'fs_write',
    'fs_read',
    'fs_copy',
    'fs_move',
    'fs_list',
    'fs_search',
    'code_session_create',
    'code_session_current',
    'code_plan',
    'code_symbol_search',
    'code_git_diff',
    'code_create',
  ],
  'system-network-diagnostics-operator': [
    'sys_info',
    'sys_resources',
    'sys_processes',
    'net_interfaces',
    'net_connections',
    'net_ping',
    'net_port_check',
    'net_oui_lookup',
  ],
  'history-reference-initial': [
    'assistant_security_summary',
    'security_posture_status',
  ],
  'history-reference-follow-up': [
    'assistant_security_findings',
    'security_posture_status',
    'second_brain_task_upsert',
    'automation_save',
  ],
};

const EXPECTED_TOOL_FAILURES = {
  // The isolated harness intentionally does not connect a real Google account.
  // This still exercises Gmail draft approval/resume plumbing; the post-approval
  // API call is expected to stop at the auth boundary.
  'workspace-email-contacts-operator': new Set(['gmail_draft']),
};

function buildStressToolArgs(toolName, testCaseId) {
  const scratchRoot = path.join(stressHarnessPaths.scratchDir, testCaseId);
  const scratchNotePath = path.join(scratchRoot, 'operator-note.txt');
  const scratchCopyPath = path.join(scratchRoot, 'operator-note-copy.txt');
  const scratchMovedPath = path.join(scratchRoot, 'operator-note-renamed.txt');
  const scratchCodePath = path.join(scratchRoot, 'generated-stress.ts');
  switch (toolName) {
    case 'second_brain_note_upsert':
      return {
        title: testCaseId === 'bad-personal-route'
          ? 'Harbor cleanup'
          : testCaseId === 'browser-extraction-state-operator'
            ? 'Example.com browser extraction'
            : 'Harbor follow-up risk',
        content: testCaseId === 'bad-personal-route'
          ? 'Harbor cleanup matters.'
          : testCaseId === 'browser-extraction-state-operator'
            ? 'Example.com browser extraction completed in the orchestration stress harness.'
            : 'Harbor follow-up is risky.',
        tags: testCaseId === 'browser-extraction-state-operator' ? ['stress', 'browser'] : ['stress', 'harbor'],
      };
    case 'second_brain_task_upsert':
      return {
        title: testCaseId === 'security-cloud-operator'
          || testCaseId === 'history-reference-follow-up'
          || testCaseId === 'intel-doc-search-network-operator'
          ? 'Review Guardian security posture findings'
          : testCaseId === 'automation-control-output-operator'
            ? 'Review automation output control result'
            : 'Review urgent Guardian TODO evidence',
        details: testCaseId === 'security-cloud-operator'
          || testCaseId === 'history-reference-follow-up'
          || testCaseId === 'intel-doc-search-network-operator'
          ? 'Created by cross-domain stress harness after security/cloud posture review.'
          : testCaseId === 'automation-control-output-operator'
            ? 'Created by cross-domain stress harness after automation control and output search.'
            : 'Created by cross-domain stress harness after repo TODO inspection.',
        status: 'todo',
        priority: 'high',
      };
    case 'second_brain_calendar_upsert':
      return {
        id: 'stress-week-planning',
        title: 'Stress Harness Week Planning',
        description: 'Planning event created by the cross-domain orchestration stress harness.',
        startsAt: Date.now() + 86_400_000,
        endsAt: Date.now() + 90_000_000,
        location: 'Guardian workspace',
      };
    case 'second_brain_person_upsert':
      return {
        id: 'stress-pat-example',
        name: 'Pat Example',
        email: 'pat@example.com',
        title: 'Operations Lead',
        company: 'Example Ops',
        relationship: 'work',
        notes: 'Created by cross-domain orchestration stress harness.',
      };
    case 'second_brain_library_upsert':
      return {
        id: 'stress-example-reference',
        title: 'Example Domain Reference',
        url: 'https://example.com',
        summary: 'Reference link saved during cross-domain orchestration stress testing.',
        tags: ['stress', 'reference'],
        kind: 'reference',
      };
    case 'second_brain_routine_catalog':
      return {};
    case 'second_brain_routine_create':
      return {
        templateId: 'topic-watch',
        name: 'Stress Harness Topic Watch',
        enabled: true,
        timing: {
          kind: 'scheduled',
          schedule: {
            cadence: 'weekly',
            time: '08:30',
            dayOfWeek: 'monday',
          },
        },
        trigger: {
          mode: 'horizon',
          lookaheadMinutes: 1440,
        },
        config: {
          topicQuery: 'Guardian orchestration approvals',
          includeOverdue: true,
        },
        delivery: ['web'],
        defaultRoutingBias: 'balanced',
      };
    case 'second_brain_generate_brief':
      return {
        kind: 'morning',
      };
    case 'second_brain_horizon_scan':
      return {
        source: 'cross-domain-stress-harness',
      };
    case 'second_brain_overview':
      return {};
    case 'second_brain_calendar_list':
      return {
        includePast: true,
        limit: 10,
      };
    case 'second_brain_routine_list':
      return {};
    case 'second_brain_brief_list':
      return {
        limit: 10,
      };
    case 'second_brain_people_list':
      return {
        query: 'Pat',
        limit: 10,
      };
    case 'second_brain_library_list':
      return {
        query: 'Example',
        limit: 10,
      };
    case 'second_brain_usage':
      return {};
    case 'automation_save':
      return {
        id: testCaseId === 'bad-automation-route'
          ? 'cross-domain-todo-security-check'
          : testCaseId === 'security-cloud-operator' || testCaseId === 'history-reference-follow-up'
            ? 'weekly-security-posture-check'
            : testCaseId === 'web-browser-network-operator'
              ? 'weekly-public-page-check'
              : testCaseId === 'automation-control-output-operator'
                ? 'stress-output-search-check'
              : 'cross-domain-harbor-reminder',
        name: testCaseId === 'bad-automation-route'
          ? 'Guardian TODO and Security Check'
          : testCaseId === 'security-cloud-operator' || testCaseId === 'history-reference-follow-up'
            ? 'Weekly Security Posture Check'
            : testCaseId === 'web-browser-network-operator'
              ? 'Weekly Public Page Check'
              : testCaseId === 'automation-control-output-operator'
                ? 'Stress Output Search Check'
              : 'Harbor Follow-up Reminder',
        description: 'Created by cross-domain orchestration stress harness.',
        enabled: true,
        kind: testCaseId === 'automation-control-output-operator' ? 'workflow' : 'assistant_task',
        ...(testCaseId === 'automation-control-output-operator'
          ? {
              mode: 'sequential',
              steps: [
                {
                  id: 'status',
                  toolName: 'assistant_security_summary',
                  args: {},
                },
              ],
            }
          : {
              task: {
                target: 'default',
                prompt: testCaseId === 'bad-automation-route'
                  ? 'Check Guardian repo TODOs, create urgent Second Brain follow-up tasks, check WHM social status, and summarize Assistant Security findings.'
                  : testCaseId === 'security-cloud-operator'
                    ? 'Run assistant_security_summary, assistant_security_findings, security_posture_status, host_monitor_status, windows_defender_status, and whm_status for profileId social. Summarize concerns for the operator.'
                  : testCaseId === 'history-reference-follow-up'
                    ? 'Run assistant_security_summary, assistant_security_findings, and security_posture_status. Summarize concerns for the operator.'
                    : testCaseId === 'web-browser-network-operator'
                      ? 'Run web_fetch for https://example.com, browser_read the page, and net_dns_lookup example.com. Summarize public page availability.'
                      : 'Remind me to review Harbor follow-up risk.',
                channel: 'web',
                deliver: false,
              },
            }),
        schedule: {
          enabled: true,
          cron: testCaseId === 'bad-personal-route' ? '0 8 * * 1-5' : '0 8 * * *',
        },
      };
    case 'automation_list':
      return {};
    case 'automation_set_enabled':
      return {
        automationId: 'stress-output-search-check',
        enabled: false,
      };
    case 'automation_run':
      return {
        automationId: 'stress-output-search-check',
        dryRun: true,
      };
    case 'automation_output_search':
      return {
        query: 'public page',
        automationId: 'stress-output-search-check',
        limit: 10,
      };
    case 'fs_search':
      return {
        path: testCaseId === 'filesystem-coding-scratch-operator' ? scratchRoot : 'src',
        query: testCaseId === 'bad-automation-route'
          ? 'TODO'
          : testCaseId === 'filesystem-coding-scratch-operator'
            ? 'scratch note'
            : 'automation',
        mode: 'content',
        maxResults: 5,
      };
    case 'fs_mkdir':
      return {
        path: scratchRoot,
        recursive: true,
      };
    case 'fs_write':
      return {
        path: scratchNotePath,
        content: 'Scratch note for cross-domain orchestration stress testing.\n',
        append: false,
      };
    case 'fs_read':
      return {
        path: scratchNotePath,
        maxBytes: 1200,
      };
    case 'fs_copy':
      return {
        source: scratchNotePath,
        destination: scratchCopyPath,
      };
    case 'fs_move':
      return {
        source: scratchCopyPath,
        destination: scratchMovedPath,
      };
    case 'fs_list':
      return {
        path: scratchRoot,
      };
    case 'whm_status':
      return {
        profile: 'social',
        includeServices: false,
      };
    case 'assistant_security_summary':
      return {};
    case 'assistant_security_findings':
      return {
        limit: 5,
      };
    case 'security_posture_status':
      return {
        profile: 'personal',
        currentMode: 'monitor',
      };
    case 'host_monitor_status':
      return {
        limit: 5,
        includeAcknowledged: false,
      };
    case 'windows_defender_status':
      return {};
    case 'web_search':
      return {
        query: 'Guardian Agent browser automation',
        maxResults: 2,
        provider: 'duckduckgo',
      };
    case 'web_fetch':
      return {
        url: 'https://example.com',
        maxChars: 1200,
      };
    case 'browser_capabilities':
      return {};
    case 'browser_navigate':
      return {
        url: 'https://example.com',
        mode: 'read',
      };
    case 'browser_read':
      return {
        url: 'https://example.com',
        maxChars: 1200,
      };
    case 'browser_links':
      return {
        url: 'https://example.com',
        maxItems: 20,
      };
    case 'browser_extract':
      return {
        url: 'https://example.com',
        type: 'both',
        maxChars: 4000,
      };
    case 'browser_state':
      return {
        url: 'https://example.com',
        maxChars: 4000,
      };
    case 'browser_interact':
      return {
        url: 'https://example.com',
        action: 'list',
      };
    case 'net_dns_lookup':
      return {
        target: 'example.com',
        type: 'A',
      };
    case 'sys_info':
      return {};
    case 'sys_resources':
      return {};
    case 'sys_processes':
      return {
        sortBy: 'cpu',
        limit: 10,
      };
    case 'net_interfaces':
      return {};
    case 'net_connections':
      return {
        state: 'LISTEN',
      };
    case 'net_ping':
      return {
        host: '127.0.0.1',
        count: 1,
      };
    case 'net_port_check':
      return {
        host: '127.0.0.1',
        ports: [stressHarnessPaths.appPort || 80],
      };
    case 'net_oui_lookup':
      return {
        mac: '00:00:5E:00:53:01',
      };
    case 'code_session_create':
      return {
        title: 'Cross-domain stress coding session',
        workspaceRoot: stressHarnessPaths.projectRoot,
        attach: true,
      };
    case 'code_session_current':
      return {};
    case 'code_plan':
      return {
        task: 'Plan a small read-only orchestration observability check.',
        cwd: stressHarnessPaths.projectRoot,
        selectedFiles: ['src/supervisor/worker-manager.ts'],
      };
    case 'code_symbol_search':
      return {
        path: path.join(stressHarnessPaths.projectRoot, 'src', 'supervisor'),
        query: 'WorkerManager',
        mode: 'content',
        maxResults: 5,
      };
    case 'code_git_diff':
      return {
        cwd: stressHarnessPaths.projectRoot,
      };
    case 'code_create':
      return {
        path: scratchCodePath,
        content: [
          'export const stressHarnessGenerated = true;',
          'export function describeStressHarness(): string {',
          "  return 'cross-domain orchestration scratch file';",
          '}',
          '',
        ].join('\n'),
        overwrite: true,
      };
    case 'gws_schema':
      return {
        schemaPath: 'gmail.users.messages.list',
      };
    case 'gmail_draft':
      return {
        to: 'operator@example.com',
        subject: 'Guardian browser check',
        body: 'The browser check completed in the orchestration stress harness.',
      };
    case 'contacts_discover_browser':
      return {
        url: 'https://example.com',
        maxContacts: 5,
        tags: ['stress'],
      };
    case 'contacts_list':
      return {
        limit: 10,
      };
    case 'campaign_create':
      return {
        name: 'Guardian Stress Follow-up',
        subjectTemplate: 'Guardian status follow-up',
        bodyTemplate: 'Review the latest Guardian orchestration status.',
      };
    case 'intel_summary':
      return {};
    case 'intel_findings':
      return {
        limit: 5,
      };
    case 'doc_search_status':
      return {};
    case 'doc_search':
      return {
        query: 'orchestration approvals',
        limit: 5,
      };
    default:
      return {};
  }
}

function findStressCaseForContent(content) {
  const lookupKey = extractLookupKey(String(content ?? ''));
  return ALL_STRESS_CASES.find((entry) => entry.prompt === lookupKey)
    ?? findLatestStressCaseInContent(content)
    ?? null;
}

function findLatestStressCaseInContent(content) {
  const text = String(content ?? '');
  return ALL_STRESS_CASES
    .map((entry) => ({ entry, index: text.lastIndexOf(entry.prompt) }))
    .filter((match) => match.index >= 0)
    .sort((left, right) => right.index - left.index)[0]?.entry
    ?? null;
}

function hasFollowUpHistoryContext(messages) {
  const latestUserIndex = messages.map((message) => message.role).lastIndexOf('user');
  const priorMessages = latestUserIndex >= 0 ? messages.slice(0, latestUserIndex) : messages;
  return priorMessages.some((message) => {
    const content = String(message?.content ?? '');
    return content.includes(FOLLOW_UP_HISTORY_INITIAL_PROMPT)
      || content.includes('assistant_security_summary')
      || content.includes('security_posture_status')
      || content.includes('security posture');
  });
}

function createChatCompletionResponse({ model, content = '', finishReason = 'stop', toolCalls }) {
  const message = {
    role: 'assistant',
    content,
  };
  if (toolCalls?.length) {
    message.tool_calls = toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    }));
  }
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  };
}

function createOllamaResponse({ model, content = '', toolCalls, doneReason = 'stop' }) {
  const message = {
    role: 'assistant',
    content,
  };
  if (toolCalls?.length) {
    message.tool_calls = toolCalls.map((toolCall) => ({
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    }));
  }
  return {
    model,
    created_at: new Date().toISOString(),
    message,
    done: true,
    done_reason: doneReason,
    prompt_eval_count: 1,
    eval_count: 1,
  };
}

function createToolCallPayload(name, args, useOllamaPayload) {
  if (useOllamaPayload) {
    return createOllamaResponse({
      model: FAKE_MODEL_NAME,
      doneReason: 'tool_calls',
      toolCalls: [{ name, arguments: args }],
    });
  }
  return createChatCompletionResponse({
    model: FAKE_MODEL_NAME,
    finishReason: 'tool_calls',
    toolCalls: [{
      id: `cross-domain-${name}-${Date.now()}`,
      name,
      arguments: JSON.stringify(args),
    }],
  });
}

function createTextPayload(content, useOllamaPayload) {
  if (useOllamaPayload) {
    return createOllamaResponse({ model: FAKE_MODEL_NAME, content });
  }
  return createChatCompletionResponse({ model: FAKE_MODEL_NAME, content });
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to allocate free port');
  }
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function requestJson(baseUrl, token, method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function getPendingApprovalSummaries(response) {
  const metadata = response?.metadata;
  if (Array.isArray(metadata?.pendingApprovals)) {
    return metadata.pendingApprovals;
  }
  const pendingActionApprovals = metadata?.pendingAction?.blocker?.approvalSummaries;
  return Array.isArray(pendingActionApprovals) ? pendingActionApprovals : [];
}

function normalizeApprovalSummary(result, approval, decision = 'approved') {
  const toolName = approval?.toolName || 'tool';
  if (result?.success === false) {
    const rawMessage = typeof result?.message === 'string' ? result.message.trim() : '';
    return `Failed: ${toolName}: ${rawMessage || 'unknown error'}`;
  }
  return `${toolName}: ${decision === 'approved' ? 'Approved and executed' : 'Denied'}`;
}

async function continueAfterApproval({ baseUrl, token, approval, decisionResult, userId, channel, surfaceId }) {
  if (decisionResult?.continuedResponse && typeof decisionResult.continuedResponse.content === 'string') {
    return decisionResult.continuedResponse;
  }

  const hasExplicitContinuationDirective = decisionResult?.continuedResponse || decisionResult?.continueConversation !== undefined;
  const needsSyntheticContinuation = decisionResult?.success !== false
    && (
      decisionResult?.continueConversation === true
      || !hasExplicitContinuationDirective
    );
  if (!needsSyntheticContinuation) {
    return null;
  }

  const summary = normalizeApprovalSummary(decisionResult, approval, 'approved');
  return requestJson(baseUrl, token, 'POST', '/api/message', {
    content: `[Context: User is currently viewing the chat panel] [User approved the pending tool action(s). Result: ${summary}] Please continue with the current request only. Do not resume older unrelated pending tasks.`,
    userId,
    channel,
    surfaceId,
  });
}

async function drainApprovals({ baseUrl, token, response, userId, channel, surfaceId }) {
  let current = response;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const pending = getPendingApprovalSummaries(current);
    if (pending.length <= 0) {
      return current;
    }
    const approval = pending[0];
    assert.ok(approval?.id, `Expected pending approval id: ${JSON.stringify(current)}`);
    const decision = await requestJson(baseUrl, token, 'POST', '/api/tools/approvals/decision', {
      approvalId: approval.id,
      decision: 'approved',
      actor: 'cross-domain-harness',
      userId,
      channel,
      surfaceId,
    });
    assert.equal(decision.success, true, `Expected approval decision to succeed: ${JSON.stringify(decision)}`);
    const continued = await continueAfterApproval({
      baseUrl,
      token,
      approval,
      decisionResult: decision,
      userId,
      channel,
      surfaceId,
    });
    assert.ok(continued, `Expected approval continuation response: ${JSON.stringify(decision)}`);
    current = continued;
  }
  throw new Error(`Too many approval continuations for ${surfaceId}: ${JSON.stringify(current)}`);
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      const json = await response.json();
      if (json?.status === 'ok') {
        return;
      }
    } catch {
      // Retry until ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('GuardianAgent did not become healthy within 90 seconds.');
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

function extractLatestUser(messages) {
  return String([...messages].reverse().find((message) => message.role === 'user')?.content ?? '');
}

function extractLookupKey(content) {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? content.trim();
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function resolveHostPlaywrightBrowsersPath() {
  const explicit = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local', 'ms-playwright') : '',
    process.env.HOME ? path.join(process.env.HOME, '.cache', 'ms-playwright') : '',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? undefined;
}

async function assertDelegatedToolCalls(tracePath, beforeCount, testCaseId, provider) {
  const expectedTools = STRESS_TOOL_SEQUENCES[testCaseId] ?? [];
  if (expectedTools.length === 0) return new Set();
  const expectedFailureTools = EXPECTED_TOOL_FAILURES[testCaseId] ?? new Set();
  await waitFor(() => {
    const progress = provider.getProgress();
    return (progress[testCaseId] ?? 0) >= expectedTools.length ? true : null;
  }, 15_000, `Expected ${testCaseId} model loop to emit ${expectedTools.join(', ')}`);
  const deadline = Date.now() + 30_000;
  let completedToolNames = new Set();
  let completedEntries = [];
  while (Date.now() < deadline) {
    completedEntries = readJsonLines(tracePath)
      .slice(beforeCount)
      .filter((entry) => entry.stage === 'delegated_tool_call_completed');
    completedToolNames = new Set(
      completedEntries
        .map((entry) => entry.details?.toolName)
        .filter((toolName) => typeof toolName === 'string'),
    );
    const terminalToolNames = new Set(
      completedEntries
        .filter((entry) => ['succeeded', 'failed'].includes(entry.details?.resultStatus))
        .map((entry) => entry.details?.toolName)
        .filter((toolName) => typeof toolName === 'string'),
    );
    if (expectedTools.every((toolName) => terminalToolNames.has(toolName))) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const terminalToolNames = new Set(
    completedEntries
      .filter((entry) => ['succeeded', 'failed'].includes(entry.details?.resultStatus))
      .map((entry) => entry.details?.toolName)
      .filter((toolName) => typeof toolName === 'string'),
  );
  const missingExpected = expectedTools.filter((toolName) => !terminalToolNames.has(toolName));
  assert.deepEqual(
    missingExpected,
    [],
    `Expected ${testCaseId} trace to include a terminal result for every planned tool. Saw: ${JSON.stringify([...completedToolNames])}`,
  );
  const failedExpectedTools = completedEntries
    .filter((entry) => expectedTools.includes(entry.details?.toolName))
    .filter((entry) => entry.details?.resultStatus === 'failed')
    .map((entry) => ({
      toolName: entry.details?.toolName,
      message: entry.details?.resultMessage,
      output: entry.details?.rawOutput,
    }));
  const unexpectedFailures = failedExpectedTools.filter((entry) => !expectedFailureTools.has(entry.toolName));
  assert.deepEqual(
    unexpectedFailures,
    [],
    `Expected ${testCaseId} planned tools to succeed except explicit expected failures. Failures: ${JSON.stringify(failedExpectedTools)}`,
  );
  return completedToolNames;
}

function createIsolatedHarnessEnv(tmpDir, extraEnv = {}) {
  const appData = path.join(tmpDir, 'AppData', 'Roaming');
  const localAppData = path.join(tmpDir, 'AppData', 'Local');
  const playwrightBrowsersPath = resolveHostPlaywrightBrowsersPath();
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  return {
    ...process.env,
    HOME: tmpDir,
    USERPROFILE: tmpDir,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: tmpDir,
    XDG_DATA_HOME: tmpDir,
    XDG_CACHE_HOME: tmpDir,
    ...(playwrightBrowsersPath ? { PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath } : {}),
    NO_COLOR: '1',
    ...extraEnv,
  };
}

async function startFakeProvider() {
  const decisionByPrompt = new Map(ALL_STRESS_CASES.map((entry) => [entry.prompt, entry.decision]));
  const progressByCase = new Map();
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: FAKE_MODEL_NAME, size: 1 }] }));
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/api/chat' || url.pathname === '/v1/chat/completions')) {
      const parsed = await readJsonBody(req);
      const useOllamaPayload = url.pathname === '/api/chat';
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const tools = Array.isArray(parsed.tools)
        ? parsed.tools.map((tool) => String(tool?.function?.name ?? tool?.name ?? '')).filter(Boolean)
        : [];
      const latestUser = extractLatestUser(messages);
      const lookupKey = extractLookupKey(latestUser);
      const toolMessages = messages.filter((message) => message.role === 'tool');
      const historyContextSeen = hasFollowUpHistoryContext(messages);
      calls.push({ latestUser, lookupKey, tools, toolMessageCount: toolMessages.length, historyContextSeen });

      if (tools.includes('route_intent')) {
        const decision = decisionByPrompt.get(lookupKey) ?? {
          route: 'general_assistant',
          confidence: 'medium',
          operation: 'inspect',
          summary: 'Default stress route.',
          turnRelation: 'new_request',
          resolution: 'ready',
          executionClass: 'tool_orchestration',
          preferredTier: 'external',
          requiresRepoGrounding: false,
          requiresToolSynthesis: true,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'tool_loop',
          simpleVsComplex: 'complex',
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createToolCallPayload('route_intent', decision, useOllamaPayload)));
        return;
      }

      if (String(latestUser).startsWith('Confirmation reason:')) {
        const originalPrompt = findLatestStressCaseInContent(latestUser);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createTextPayload(JSON.stringify(
          originalPrompt?.decision ?? {
            route: 'general_assistant',
            confidence: 'medium',
            operation: 'inspect',
            summary: 'Default confirmation route.',
            turnRelation: 'new_request',
            resolution: 'ready',
            executionClass: 'tool_orchestration',
            preferredTier: 'external',
            requiresRepoGrounding: false,
            requiresToolSynthesis: true,
            expectedContextPressure: 'medium',
            preferredAnswerPath: 'tool_loop',
            simpleVsComplex: 'complex',
          },
        ), useOllamaPayload)));
        return;
      }

      const testCase = findStressCaseForContent(latestUser);
      if (testCase) {
        if (testCase.id === 'history-reference-follow-up' && !historyContextSeen) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(createTextPayload(
            'Missing prior conversation context for the follow-up reference.',
            useOllamaPayload,
          )));
          return;
        }
        const sequence = STRESS_TOOL_SEQUENCES[testCase.id] ?? [];
        const state = progressByCase.get(testCase.id) ?? { index: 0, findAttempts: 0 };
        const nextTool = sequence[state.index];
        if (nextTool) {
          if (!tools.includes(nextTool) && tools.includes('find_tools') && state.findAttempts <= 0) {
            state.findAttempts += 1;
            progressByCase.set(testCase.id, state);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(createToolCallPayload('find_tools', {
              query: nextTool,
              maxResults: 10,
            }, useOllamaPayload)));
            return;
          }
          state.index += 1;
          state.findAttempts = 0;
          progressByCase.set(testCase.id, state);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(createToolCallPayload(
            nextTool,
            buildStressToolArgs(nextTool, testCase.id),
            useOllamaPayload,
          )));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createTextPayload(
          `Cross-domain stress completed ${sequence.join(', ')} and returned an operator summary.`,
          useOllamaPayload,
        )));
        return;
      }

      if (tools.includes('fs_search') && toolMessages.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createToolCallPayload('fs_search', {
          path: 'src',
          query: 'automation',
          mode: 'content',
          maxResults: 5,
        }, useOllamaPayload)));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(createTextPayload('Cross-domain stress reached orchestrated tool-loop synthesis.', useOllamaPayload)));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start fake provider');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    getProgress: () => Object.fromEntries(
      [...progressByCase.entries()].map(([id, state]) => [id, state.index ?? 0]),
    ),
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function startMockCloudServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let response;
    if (url.pathname === '/json-api/gethostname') {
      response = { metadata: { result: 1 }, data: { hostname: 'whm.social.local' } };
    } else if (url.pathname === '/json-api/version') {
      response = { metadata: { result: 1 }, data: { version: '124.0.1' } };
    } else if (url.pathname === '/json-api/systemloadavg') {
      response = { metadata: { result: 1 }, data: { one: 0.11, five: 0.22, fifteen: 0.33 } };
    } else if (url.pathname === '/json-api/servicestatus') {
      response = {
        metadata: { result: 1 },
        data: {
          service: [
            { name: 'httpd', running: 1 },
            { name: 'mysql', running: 1 },
          ],
        },
      };
    }

    if (!response) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start mock cloud server');
  }
  return {
    port: address.port,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function runHarness() {
  const args = new Set(process.argv.slice(2));
  const keepTmp = args.has('--keep-tmp') || process.env.HARNESS_KEEP_TMP === '1';
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-cross-domain-stress-'));
  const harnessHome = path.join(tmpDir, 'home');
  const configPath = path.join(tmpDir, 'config.yaml');
  const logPath = path.join(tmpDir, 'guardian.log');
  const port = await getFreePort();
  const token = `cross-domain-stress-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  stressHarnessPaths.projectRoot = projectRoot;
  stressHarnessPaths.scratchDir = path.join(harnessHome, 'scratch');
  stressHarnessPaths.appPort = port;
  const provider = await startFakeProvider();
  const cloud = await startMockCloudServer();
  fs.mkdirSync(harnessHome, { recursive: true });
  const searchDocsDir = path.join(harnessHome, 'search-docs');
  fs.mkdirSync(searchDocsDir, { recursive: true });
  fs.writeFileSync(
    path.join(searchDocsDir, 'orchestration-approvals.md'),
    [
      '# Orchestration Approvals',
      '',
      'Guardian approvals pause mutating tool calls and resume the same brokered worker after the operator decision.',
      'Document search should return this note for orchestration approvals regression checks.',
    ].join('\n'),
  );

  const config = `
llm:
  local:
    provider: ollama
    baseUrl: ${provider.baseUrl}
    model: ${FAKE_MODEL_NAME}
defaultProvider: local
channels:
  cli:
    enabled: false
  web:
    enabled: true
    host: 127.0.0.1
    port: ${port}
    authToken: "${token}"
assistant:
  identity:
    mode: single_user
    primaryUserId: harness
  setup:
    completed: true
  skills:
    enabled: false
  tools:
    enabled: true
    policyMode: autonomous
    allowedPaths:
      - ${JSON.stringify(projectRoot)}
      - ${JSON.stringify(harnessHome)}
    allowedDomains:
      - 127.0.0.1
      - localhost
      - 127.0.0.1.nip.io
      - example.com
      - html.duckduckgo.com
      - gmail.googleapis.com
    allowedCommands:
      - echo
      - nslookup
      - ping
      - tasklist
      - wmic
      - netstat
    webSearch:
      provider: duckduckgo
    search:
      enabled: true
      sqlitePath: ${JSON.stringify(path.join(harnessHome, 'search-index.sqlite'))}
      defaultMode: keyword
      maxResults: 5
      sources:
        - id: harness-docs
          name: Harness Docs
          type: directory
          path: ${JSON.stringify(searchDocsDir)}
          globs:
            - "**/*.md"
          enabled: true
    browser:
      enabled: true
      playwrightEnabled: true
      allowedDomains:
        - example.com
    sandbox:
      enabled: true
      enforcementMode: permissive
      degradedFallback:
        allowNetworkTools: true
        allowBrowserTools: true
        allowMcpServers: false
        allowPackageManagers: false
        allowManualCodeTerminals: false
    cloud:
      enabled: true
      cpanelProfiles:
        - id: social
          name: Social WHM
          type: whm
          host: 127.0.0.1.nip.io
          port: ${cloud.port}
          username: root
          apiToken: whm-secret
          ssl: false
guardian:
  ssrf:
    allowlist:
      - 127.0.0.1.nip.io
  enabled: true
  rateLimit:
    maxPerMinute: 120
    maxPerHour: 1000
    burstAllowed: 20
`;
  fs.writeFileSync(configPath, config);

  let appProcess;
  let logStream;
  try {
    appProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', configPath], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: createIsolatedHarnessEnv(harnessHome),
    });
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
    appProcess.stdout.pipe(logStream);
    appProcess.stderr.pipe(logStream);

    await waitForHealth(baseUrl);
    const tracePath = path.join(harnessHome, '.guardianagent', 'routing', 'intent-routing.jsonl');

    for (const testCase of STRESS_CASES) {
      const beforeCount = readJsonLines(tracePath).length;
      const surfaceId = `cross-domain-${testCase.id}`;
      let response = await requestJson(baseUrl, token, 'POST', '/api/message', {
        content: testCase.prompt,
        userId: 'harness',
        channel: 'web',
        surfaceId,
      });
      response = await drainApprovals({
        baseUrl,
        token,
        response,
        userId: 'harness',
        channel: 'web',
        surfaceId,
      });

      assert.ok(
        String(response.content ?? '').trim().length > 0,
        `Expected non-empty response for ${testCase.id}: ${JSON.stringify(response)}`,
      );
      assert.doesNotMatch(
        String(response.content ?? ''),
        /could not complete|failed/i,
        `Expected ${testCase.id} not to fail after falling through to orchestration: ${JSON.stringify(response)}`,
      );
      assert.doesNotMatch(
        String(response.content ?? ''),
        /waiting for approval/i,
        `Expected ${testCase.id} approvals to drain to a final response: ${JSON.stringify(response)}`,
      );

      const directTrace = await waitFor(() => {
        const entries = readJsonLines(tracePath).slice(beforeCount);
        return entries.find((entry) => entry.stage === 'direct_candidates_evaluated') ?? null;
      }, 10_000, `Expected direct candidate trace for ${testCase.id}`);

      assert.deepEqual(
        directTrace.details?.candidates ?? null,
        [],
        `Expected no direct candidates for ${testCase.id}: ${JSON.stringify(directTrace)}`,
      );
      assert.ok(
        (testCase.acceptableTraceRoutes ?? [testCase.decision.route, 'general_assistant']).includes(directTrace.details?.route),
        `Expected trace route for ${testCase.id} to preserve an acceptable orchestration route: ${JSON.stringify(directTrace)}`,
      );

      const gatewayTrace = readJsonLines(tracePath)
        .slice(beforeCount)
        .find((entry) => entry.stage === 'gateway_classified');
      assert.ok(gatewayTrace, `Expected gateway trace for ${testCase.id}`);
      assert.ok(
        Array.isArray(gatewayTrace.details?.plannedStepKinds)
        && gatewayTrace.details.plannedStepKinds.length >= 2,
        `Expected planned step trace for ${testCase.id}: ${JSON.stringify(gatewayTrace)}`,
      );
      await assertDelegatedToolCalls(tracePath, beforeCount, testCase.id, provider);
    }

    const historySurfaceId = 'cross-domain-history-reference';
    const historyInitialBeforeCount = readJsonLines(tracePath).length;
    let historyInitial = await requestJson(baseUrl, token, 'POST', '/api/message', {
      content: FOLLOW_UP_HISTORY_INITIAL_PROMPT,
      userId: FOLLOW_UP_HISTORY_USER_ID,
      channel: 'web',
      surfaceId: historySurfaceId,
    });
    historyInitial = await drainApprovals({
      baseUrl,
      token,
      response: historyInitial,
      userId: FOLLOW_UP_HISTORY_USER_ID,
      channel: 'web',
      surfaceId: historySurfaceId,
    });
    assert.ok(
      String(historyInitial.content ?? '').trim().length > 0,
      `Expected non-empty initial history response: ${JSON.stringify(historyInitial)}`,
    );
    assert.doesNotMatch(
      String(historyInitial.content ?? ''),
      /waiting for approval/i,
      `Expected initial history request not to remain approval-blocked: ${JSON.stringify(historyInitial)}`,
    );
    await assertDelegatedToolCalls(tracePath, historyInitialBeforeCount, 'history-reference-initial', provider);

    const historyFollowUpBeforeCount = readJsonLines(tracePath).length;
    let historyFollowUp = await requestJson(baseUrl, token, 'POST', '/api/message', {
      content: FOLLOW_UP_HISTORY_PROMPT,
      userId: FOLLOW_UP_HISTORY_USER_ID,
      channel: 'web',
      surfaceId: historySurfaceId,
    });
    historyFollowUp = await drainApprovals({
      baseUrl,
      token,
      response: historyFollowUp,
      userId: FOLLOW_UP_HISTORY_USER_ID,
      channel: 'web',
      surfaceId: historySurfaceId,
    });
    assert.ok(
      String(historyFollowUp.content ?? '').trim().length > 0,
      `Expected non-empty follow-up response: ${JSON.stringify(historyFollowUp)}`,
    );
    assert.doesNotMatch(
      String(historyFollowUp.content ?? ''),
      /waiting for approval/i,
      `Expected follow-up approvals to drain to a final response: ${JSON.stringify(historyFollowUp)}`,
    );
    assert.doesNotMatch(
      String(historyFollowUp.content ?? ''),
      /missing prior conversation context/i,
      `Expected follow-up to receive enough history context: ${JSON.stringify(historyFollowUp)}`,
    );
    await assertDelegatedToolCalls(tracePath, historyFollowUpBeforeCount, 'history-reference-follow-up', provider);
    assert.ok(
      provider.calls.some((call) => call.lookupKey === FOLLOW_UP_HISTORY_PROMPT && call.historyContextSeen),
      `Expected fake provider to observe prior history for follow-up. Calls: ${JSON.stringify(provider.calls.slice(-12))}`,
    );

    console.log('PASS cross-domain orchestration stress harness');
  } finally {
    if (appProcess && !appProcess.killed) {
      appProcess.kill('SIGTERM');
    }
    if (logStream) {
      logStream.end();
    }
    await provider.close().catch(() => {});
    await cloud.close().catch(() => {});
    if (!keepTmp) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } else {
      console.log(`Kept temp directory: ${tmpDir}`);
    }
  }
}

runHarness().catch((error) => {
  console.error(`FAIL cross-domain orchestration stress harness: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
