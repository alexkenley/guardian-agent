# Guardian Agent - Agentic System Uplift Plan

## 1. Overview
This document outlines the strategic uplifts required to elevate Guardian Agent from a highly capable, reactive orchestrator to a fully autonomous, self-correcting agentic system. While the system currently excels at secure tool execution, memory persistence, and technical error recovery, these uplifts will close the loop on proactive planning, logical observation, and semantic recovery.

## 2. Intent Gateway Complex Planning Model (Proactive Planning DAG)

**Current State:** The `IntentGateway` routes requests directly to skills or prerouters, acting reactively to individual user prompts.

**The Uplift:** Introduce a "Planning Phase" for complex intents using a Directed Acyclic Graph (DAG) of sub-tasks. When the `IntentGateway` classifies an objective as "complex", it routes to a `TaskPlanner` before execution. The `AssistantOrchestrator` consumes this DAG, autonomously transitioning from step $N$ to step $N+1$.

### Deep Dive: Integration with Second Brain & Automations
The DAG planner will act as an orchestrator of existing primitives, not a replacement for them.
*   **Second-Brain Routines:** If a step in the DAG requires executing a known Second-Brain routine (e.g., "Morning Briefing"), that routine becomes a single node in the DAG. The planner will not micromanage the routine; it will trigger it, wait for the aggregated output, and pass that output to the next step (e.g., "Draft an email based on the briefing").
*   **Creating Automations:** The planner can identify when a sub-task is repetitive and propose creating a new automation as part of its plan. It leverages the existing `automation-builder` skill as a specialized node within the DAG.

### Deep Dive: Augmenting Coding Skills
Guardian already possesses robust coding skills (e.g., `test-driven-development`, `coding-workspace`) that handle their own micro-planning. 
*   **No Interference:** The top-level TaskPlanner operates as a **meta-planner**. If a node in the DAG is "Implement the authentication feature", the TaskPlanner does not attempt to write the code itself.
*   **Delegation:** Instead, it delegates that entire node to the appropriate specialized coding skill. The coding skill executes its internal loop (write tests, write code, run tests), and once it succeeds, control returns to the top-level DAG. This prevents the top-level planner from getting bogged down in syntax errors and keeps responsibilities strictly bounded.

## 3. Self-Reflection Loop (Observation)

**Current State:** The system observes tool output primarily for technical success (e.g., did the HTTP request succeed? Did the file read throw an error?).

**The Uplift:** Implement autonomous semantic validation. Introduce a `ReflectionCheck` after critical tool executions. Instead of blindly accepting a successful technical execution, the agent evaluates the *quality* of the payload ("Does this output satisfy the intended sub-goal?").

## 4. Memory Compaction & Context Budgeting

**Current State:** Guardian has a highly sophisticated memory architecture (`docs/guides/MEMORY-SYSTEM.md`) featuring FTS5 search, cross-scope bridging (Code vs Global), and an existing `automated-maintenance-service.ts` that handles idle background hygiene (archiving duplicates, pruning).

**The Uplift:** Rather than adding new, competing background processes, this uplift focuses on **in-session context compaction** during long-running DAG execution to prevent prompt bloat.
*   **Evolving `compactedSummary`:** During a deep autonomous run, the orchestrator will aggressively compress older `AssistantTraceStep` logs and raw tool outputs into dense "insight nodes" within the active session.
*   **Synergy with Existing Maintenance:** When the autonomous task finishes and falls out of the context window, this highly compressed session trace is handed off to the existing `Memory Flush` mechanism. The background maintenance jobs will then process it just like any other flush, ensuring we do not introduce unnecessary architectural complexity or conflicting background sweeps.

## 5. Logical Fallback Strategies & Dynamic Tooling (Recovery)

**Current State:** Exceptional technical recovery (LLM fallback chains, structured JSON repair).

**The Uplift:** Implement logical pivot mechanisms for semantic failures caught by the Self-Reflection Loop. If a step is flagged as failing semantically, the `AssistantOrchestrator` triggers a `RecoveryPlanner` to generate an alternative approach.

### Deep Dive: Dynamic Skill Creation via Sandbox
A critical component of this recovery is the ability to autonomously build missing capabilities.
*   **The Problem:** The DAG execution might block because no existing tool can parse a proprietary file format or interact with an undocumented API required for the sub-task.
*   **The Sandbox Pivot:** The Recovery Planner can pivot to **Dynamic Skill Creation**. It proposes writing a new, ad-hoc skill to fulfill the immediate need.
*   **Safe Execution:** Leveraging the existing secure sandbox architecture, the agent can draft the skill code, execute and test it within the isolated sandbox boundary, verify it solves the blocked step, and then temporarily register it to the `SkillRegistry` to unblock the main DAG execution. 
*   **Approval Gate:** Any promotion of a dynamically created skill out of the sandbox to a permanent, trusted skill must still pass through the standard Guardian review/approval layers.

## 6. Implementation Roadmap
*   **Phase 1: The Meta-Planner DAG.** Modify `IntentGateway` to route complex tasks to a DAG generator. Ensure nodes correctly delegate to existing Second-Brain routines and Coding Skills without interference.
*   **Phase 2: Semantic Reflection.** Implement the evaluation step post-tool-execution.
*   **Phase 3: Sandbox Dynamic Tooling.** Hook the recovery loop into the sandbox environment, allowing the orchestrator to draft and test temporary skills to unblock failures.
*   **Phase 4: In-Session Compaction.** Enhance the orchestrator's trace tracking to compress intermediate results in-memory, handing off cleanly to the existing Memory Flush system.