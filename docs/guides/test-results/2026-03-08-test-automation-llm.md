PS S:\Development\GuardianAgent\scripts> .\test-automations.ps1
.\test-automations.ps1: The term '.\test-automations.ps1' is not recognized as a name of a cmdlet, function, script file, or executable program.
Check the spelling of the name, or if a path was included, verify that the path is correct and try again.
PS S:\Development\GuardianAgent\scripts> test-automations-llm.ps1
test-automations-llm.ps1: The term 'test-automations-llm.ps1' is not recognized as a name of a cmdlet, function, script file, or executable program.
Check the spelling of the name, or if a path was included, verify that the path is correct and try again.

Suggestion [3,General]: The command "test-automations-llm.ps1" was not found, but does exist in the current location. PowerShell does not load commands from the current location by default. If you trust this command, instead type: ".\test-automations-llm.ps1". See "get-help about_Command_Precedence" for more details.
PS S:\Development\GuardianAgent\scripts> .\test-automations-llm.ps1
[auto-llm] Starting GuardianAgent with token: <redacted-harness-token>
[auto-llm] App PID: 38428, waiting for /health...
[auto-llm] App is healthy after 2s
[auto-llm] Ready with auth token: <redacted-harness-token>

[auto-llm] LLM Provider: ollama (ollama) — model: gpt-oss:latest, locality: local
[auto-llm] LLM Provider: openai (openai) — model: gpt-4o, locality: external

[auto-llm] === Prerequisite Check ===
  PASS prerequisite: automation tools available
  PASS setup: autonomous policy for LLM tests

[auto-llm] === Section 1: Tool Discovery ===
  PASS discovery: automation tools query
  PASS discovery: mentions automation concepts
  PASS discovery: find_tools was invoked (called: find_tools)
  PASS discovery: specific tool names
  PASS discovery: mentions specific tool names

[auto-llm] === Section 2: Single-Tool Automation Creation ===
  PASS create-single: basic creation
  PASS create-single: confirms creation
  PASS create-single: workflow_upsert was called (called: workflow_upsert)
  PASS create-single: verify via list
  FAIL create-single: automation appears in list - expected 'sys.health|health.check' in: No automations (workflows) are currently defined in this workspace.
If you’d like to create a new one, let me know the details and I’ll set it up.
  PASS create-single: workflow_list was called (called: workflow_list)

[auto-llm] === Section 3: Pipeline Automation Creation ===
  PASS create-pipeline: sequential creation
  PASS create-pipeline: confirms multi-step creation
  PASS create-pipeline: workflow_upsert was called (called: workflow_upsert, workflow_upsert)
  PASS create-pipeline: parallel creation
  PASS create-pipeline: confirms parallel creation
  PASS create-pipeline: workflow_upsert was called (called: workflow_upsert, workflow_upsert)

[auto-llm] === Section 4: Scheduling ===
  PASS schedule: create scheduled task
  PASS schedule: confirms schedule creation
  FAIL schedule: task_create was called - no tool calls detected
  PASS schedule: verify via task_list
  PASS schedule: task_list was called (called: task_list)

[auto-llm] === Section 5: Tool Composition for Monitoring ===
  PASS compose-http: HTTP monitoring pipeline
  PASS compose-http: confirms HTTP monitoring concept
  PASS compose-http: workflow_upsert was called (called: workflow_upsert, workflow_upsert)
  PASS compose-net: network sweep pipeline
  PASS compose-net: confirms network monitoring concept
  PASS compose-net: workflow_upsert was called (called: workflow_upsert)

[auto-llm] === Section 6: Running Automations ===
  PASS run: dry run
  PASS run: confirms dry run execution
  FAIL run: workflow_run was called for dry run - no tool calls detected
  PASS run: real execution
  PASS run: confirms real execution
  FAIL run: workflow_run was called for real run - no tool calls detected
  PASS run: pipeline execution
  PASS run: workflow_run was called for pipeline (called: workflow_run)

[auto-llm] === Section 7: Schedule Management ===
  PASS sched-mgmt: list tasks
  PASS sched-mgmt: task_list was called (called: task_list)
  PASS sched-mgmt: update schedule
  PASS sched-mgmt: confirms schedule update
  FAIL sched-mgmt: task_update or task_list was called - no tool calls detected

[auto-llm] === Section 8: Natural Language Requests ===
  PASS natural: monitoring suggestion
  PASS natural: suggests relevant monitoring tools
  PASS natural: daily schedule creation
  FAIL natural: confirms daily scheduled automation - expected 'creat|automat|daily|9|schedul|resource' in: I could not generate a final response for that request.
  FAIL natural: automation tools were called - expected tool matching 'workflow_upsert|task_create', got: find_tools, workflow_list, workflow_list, workflow_list, workflow_list, find_tools, workflow_list, find_tools, find_tools
  PASS natural: weekday schedule
  PASS natural: confirms weekday scheduled automation
  PASS natural: automation tools were called (called: task_create, workflow_upsert)

[auto-llm] === Section 9: Listing & Inspection ===
  PASS list: show all automations
  PASS list: shows automation names
  PASS list: listing tools were called (called: workflow_list)
  PASS list: count automations
  PASS list: workflow_list was called (called: workflow_list)

[auto-llm] === Section 10: Deletion ===
  PASS delete: single automation
  PASS delete: confirms deletion
  PASS delete: workflow_delete was called (called: workflow_delete)
  PASS delete: pipeline automation
  PASS delete: workflow_delete was called for pipeline (called: workflow_delete)
  PASS delete: http monitor automation
  PASS delete: workflow_delete was called for http monitor (called: workflow_delete)
  PASS delete: cleanup remaining
  PASS delete: workflow_delete was called for cleanup (called: workflow_delete, workflow_delete, workflow_delete, workflow_delete)
  PASS delete: cleanup tasks
  PASS delete: task cleanup tools were called (called: task_list, task_delete, task_delete, task_list)

[auto-llm] === Section 11: Edge Cases ===
  PASS edge: non-existent automation
  PASS edge: reports automation not found
  PASS edge: sub-minute interval
  PASS edge: explains cron minimum interval limitation

[auto-llm] === Job History Verification ===
  PASS job history: 63 automation-related tool executions recorded
  PASS job history: tools used: find_tools, task_create, task_delete, task_list, workflow_delete, workflow_list, workflow_run, workflow_upsert
  PASS job history: all expected automation tools were called

[auto-llm] === Cleanup ===
  PASS cleanup: policy restored to approve_by_policy

============================================
  PASS: 68  FAIL: 7  SKIP: 0  Total: 75
============================================

Failed tests:
  FAIL: create-single: automation appears in list - expected 'sys.health|health.check' in: No automations (workflows) are currently defined in this workspace.
If you’d like to create a new one, let me know the details and I’ll set it up.
  FAIL: schedule: task_create was called - no tool calls detected
  FAIL: run: workflow_run was called for dry run - no tool calls detected
  FAIL: run: workflow_run was called for real run - no tool calls detected
  FAIL: sched-mgmt: task_update or task_list was called - no tool calls detected
  FAIL: natural: confirms daily scheduled automation - expected 'creat|automat|daily|9|schedul|resource' in: I could not generate a final response for that request.
  FAIL: natural: automation tools were called - expected tool matching 'workflow_upsert|task_create', got: find_tools, workflow_list, workflow_list, workflow_list, workflow_list, find_tools, workflow_list, find_tools, find_tools

[auto-llm] Full app log: %LOCALAPPDATA%\\Temp\\guardian-autollm-harness.log
[auto-llm] Stopping app (PID 38428)...
PS S:\Development\GuardianAgent\scripts>