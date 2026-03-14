# Superpowers Analysis

Date: 2026-03-14
Source repo: `https://github.com/obra/superpowers`
Local clone: `/mnt/s/Development/superpowers`

## Summary

`superpowers` is not an application framework. It is a skill-first workflow package for coding agents.

That matters for Guardian because the reusable value is:

- skill selection discipline
- concise, trigger-oriented skill authoring
- pressure-tested meta-skills
- tests that verify skill invocation behavior, not just downstream output

The reusable value is not:

- a drop-in runtime
- direct integration code for Guardian tools
- a replacement for Guardian's tool executor, approval model, or policy layer

## Popularity and License

- GitHub currently shows strong adoption for the repository.
- The repository is MIT licensed, so code and documentation patterns can be reused with attribution and preservation of the license notice where required.

## What Superpowers Actually Ships

The repository centers on:

- `skills/` for procedural instructions
- platform-specific install surfaces like `.codex/`, `.cursor-plugin/`, `.claude-plugin/`, `.opencode/`
- tests that exercise skill loading and triggering

Representative files:

- `README.md`
- `docs/README.codex.md`
- `.codex/INSTALL.md`
- `skills/using-superpowers/SKILL.md`
- `skills/writing-skills/SKILL.md`
- `skills/systematic-debugging/SKILL.md`
- `skills/verification-before-completion/SKILL.md`

## What Guardian Should Borrow

### 1. Meta-skill discipline

`skills/using-superpowers/SKILL.md` is effectively a bootstrap contract:

- check for relevant skills before acting
- use process skills before implementation skills
- do not rely on memory of a skill

Guardian already moved toward this with a skill catalog prompt, but Superpowers is stricter and more explicit. Borrow the enforcement pattern, not the exact wording.

### 2. Better skill authoring rules

`skills/writing-skills/SKILL.md` is stronger than Guardian's current `skills/skill-creator/SKILL.md` in three areas:

- it treats skill creation as an eval-driven loop
- it focuses heavily on trigger wording in frontmatter
- it distinguishes the trigger description from the workflow body

Guardian should import these ideas into its own skill authoring workflow and spec.

### 3. Procedural skills that are broadly portable

These skills are portable with minimal adaptation:

- `systematic-debugging`
- `verification-before-completion`
- `test-driven-development`
- `writing-plans`

These are mostly process skills. They do not depend on Superpowers internals in the way their subagent and worktree skills do.

### 4. Skill-trigger testing

The most valuable operational pattern in the repo is the test setup under `tests/`:

- explicit-skill request tests
- naive prompt skill-trigger tests
- end-to-end CLI behavior checks

Guardian should add equivalent tests around:

- auto-selection of `google-workspace`
- reading `SKILL.md` before tool use
- selecting the most specific skill when multiple skills match
- refusing to ask for raw OAuth tokens when Google is connected

## What Guardian Should Not Copy Blindly

### 1. Coding-workflow assumptions

Much of Superpowers assumes the agent is primarily a coding agent with:

- plan files
- git worktrees
- code review loops
- subagents

Guardian is broader. Those assumptions do not cleanly fit its security, assistant, and operations use cases.

### 2. Platform-specific discovery

Superpowers leans on host runtime conventions such as Codex scanning `~/.agents/skills` or Claude loading marketplace plugins.

Guardian already has its own `SkillRegistry`, `SkillResolver`, and prompt assembly. Reuse content patterns, not installation mechanics.

### 3. Overly rigid universal enforcement

Superpowers is intentionally dogmatic. That works for a narrow coding workflow. Guardian should keep the good discipline without turning every request into a coding-process ritual.

## Immediate Recommendations

### High-value imports

1. Adapt `writing-skills` into Guardian's `skill-creator` skill and skill spec.
2. Add process skills for debugging and verification, modeled on Superpowers.
3. Add skill-trigger evals to Guardian's test suite.

### Google-specific application

Superpowers does not solve Google Workspace directly. It helps indirectly by reinforcing the pattern we already want:

- expose the right skill
- force the model to read it when relevant
- test that this actually happens

For Google, OpenCLAW remains the better direct reference for domain skill content. Superpowers is the better reference for process rigor and eval design.

## Recommendation

Yes, borrow from `superpowers`, but do it selectively:

- borrow the meta-skill discipline
- borrow the skill-authoring and testing methodology
- borrow portable process skills
- do not try to mirror the repo wholesale or inherit its coding-agent assumptions everywhere

The right move for Guardian is a hybrid:

- OpenCLAW-style domain skills for Google Workspace and other tool families
- Superpowers-style process skills and skill-trigger evaluation for reliability
