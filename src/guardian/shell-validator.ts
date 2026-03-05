/**
 * Shell command tokenizer and validator.
 *
 * POSIX-style shell tokenizer that handles quoting, escaping, and
 * command chaining. Used by ShellCommandController to validate
 * shell commands before execution.
 */

/** A parsed shell command with its arguments. */
export interface ParsedCommand {
  /** The command name (first token). */
  command: string;
  /** All arguments (remaining tokens). */
  args: string[];
  /** Redirect targets (paths after >, >>, <). */
  redirects: string[];
  /** The chain operator that precedes this command (null for first). */
  chainOp: string | null;
}

/** Result of shell command validation. */
export interface ShellValidationResult {
  valid: boolean;
  reason?: string;
  commands: ParsedCommand[];
}

const CHAIN_OPS = new Set(['&&', '||', ';', '|']);
const REDIRECT_OPS = new Set(['>', '>>', '<', '2>', '2>>']);

/**
 * Tokenize a shell command string into tokens.
 *
 * Handles:
 * - Single-quoted strings (no escape processing)
 * - Double-quoted strings (backslash escaping)
 * - Backslash escaping outside quotes
 * - Chain operators: &&, ||, ;, |
 * - Redirect operators: >, >>, <, 2>, 2>>
 * - Subshell detection: $(...) and backticks
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    // Single quote — no escaping inside
    if (ch === "'") {
      i++;
      while (i < len && input[i] !== "'") {
        current += input[i];
        i++;
      }
      if (i < len) i++; // skip closing quote
      continue;
    }

    // Double quote — backslash escaping
    if (ch === '"') {
      i++;
      while (i < len && input[i] !== '"') {
        // Command substitution is still active inside double quotes.
        if (input[i] === '$' && i + 1 < len && input[i + 1] === '(') {
          if (current) { tokens.push(current); current = ''; }
          tokens.push('$(');
          i += 2;
          continue;
        }
        if (input[i] === '`') {
          if (current) { tokens.push(current); current = ''; }
          tokens.push('`');
          i++;
          continue;
        }
        if (input[i] === '\\' && i + 1 < len) {
          i++;
          current += input[i];
        } else {
          current += input[i];
        }
        i++;
      }
      if (i < len) i++; // skip closing quote
      continue;
    }

    // Backslash escaping outside quotes
    if (ch === '\\' && i + 1 < len) {
      i++;
      current += input[i];
      i++;
      continue;
    }

    // Subshell markers — flag them as special tokens
    if (ch === '$' && i + 1 < len && input[i + 1] === '(') {
      if (current) { tokens.push(current); current = ''; }
      tokens.push('$(');
      i += 2;
      continue;
    }

    if (ch === '`') {
      if (current) { tokens.push(current); current = ''; }
      tokens.push('`');
      i++;
      continue;
    }

    // Chain operators
    if (ch === '&' && i + 1 < len && input[i + 1] === '&') {
      if (current) { tokens.push(current); current = ''; }
      tokens.push('&&');
      i += 2;
      continue;
    }

    if (ch === '|' && i + 1 < len && input[i + 1] === '|') {
      if (current) { tokens.push(current); current = ''; }
      tokens.push('||');
      i += 2;
      continue;
    }

    if (ch === '|') {
      if (current) { tokens.push(current); current = ''; }
      tokens.push('|');
      i++;
      continue;
    }

    if (ch === ';') {
      if (current) { tokens.push(current); current = ''; }
      tokens.push(';');
      i++;
      continue;
    }

    // Redirect operators
    if (ch === '>' || ch === '<') {
      if (current) {
        // Check for 2> / 2>>
        if (ch === '>' && current === '2') {
          current = '';
          if (i + 1 < len && input[i + 1] === '>') {
            tokens.push('2>>');
            i += 2;
          } else {
            tokens.push('2>');
            i++;
          }
          continue;
        }
        tokens.push(current);
        current = '';
      }

      if (ch === '>' && i + 1 < len && input[i + 1] === '>') {
        tokens.push('>>');
        i += 2;
      } else {
        tokens.push(ch);
        i++;
      }
      continue;
    }

    // Whitespace — delimiter
    if (ch === ' ' || ch === '\t') {
      if (current) { tokens.push(current); current = ''; }
      i++;
      continue;
    }

    // Regular character
    current += ch;
    i++;
  }

  if (current) tokens.push(current);

  return tokens;
}

/**
 * Split tokenized input into individual commands by chain operators.
 */
export function splitCommands(tokens: string[]): ParsedCommand[] {
  const commands: ParsedCommand[] = [];
  let currentTokens: string[] = [];
  let chainOp: string | null = null;

  for (const token of tokens) {
    if (CHAIN_OPS.has(token)) {
      if (currentTokens.length > 0) {
        commands.push(parseCommandTokens(currentTokens, chainOp));
      }
      chainOp = token;
      currentTokens = [];
    } else {
      currentTokens.push(token);
    }
  }

  if (currentTokens.length > 0) {
    commands.push(parseCommandTokens(currentTokens, chainOp));
  }

  return commands;
}

/** Parse a single command's tokens into a ParsedCommand. */
function parseCommandTokens(tokens: string[], chainOp: string | null): ParsedCommand {
  const redirects: string[] = [];
  const args: string[] = [];
  let command = '';

  let i = 0;

  // First non-redirect token is the command
  while (i < tokens.length) {
    if (REDIRECT_OPS.has(tokens[i])) {
      // Skip redirect op and capture target
      i++;
      if (i < tokens.length) {
        redirects.push(tokens[i]);
      }
      i++;
      continue;
    }
    if (!command) {
      command = tokens[i];
    } else {
      args.push(tokens[i]);
    }
    i++;
  }

  // Re-scan args for redirect ops embedded in them
  const cleanArgs: string[] = [];
  for (let j = 0; j < args.length; j++) {
    if (REDIRECT_OPS.has(args[j])) {
      if (j + 1 < args.length) {
        redirects.push(args[j + 1]);
        j++;
      }
    } else {
      cleanArgs.push(args[j]);
    }
  }

  return { command, args: cleanArgs, redirects, chainOp };
}

function allowedEntryMatchesCommand(cmd: ParsedCommand, allowedEntry: string): boolean {
  const allowedTokens = tokenize(allowedEntry.trim())
    .filter((token) => !CHAIN_OPS.has(token) && !REDIRECT_OPS.has(token));
  if (allowedTokens.length === 0) return false;

  const [allowedCommand, ...allowedArgs] = allowedTokens;
  if (cmd.command !== allowedCommand) return false;

  // Allow bare command entries (e.g. "git") to match any args.
  if (allowedArgs.length === 0) return true;

  // Allow command+arg prefixes (e.g. "git status" matches "git status -s").
  if (cmd.args.length < allowedArgs.length) return false;
  return allowedArgs.every((arg, idx) => cmd.args[idx] === arg);
}

/**
 * Validate a shell command string against allowed commands and denied paths.
 *
 * @param input - Raw shell command string
 * @param allowedCommands - Allowed command prefixes (e.g., ['git', 'npm'])
 * @param deniedPathChecker - Function that returns true if a path is denied
 * @returns Validation result
 */
export function validateShellCommand(
  input: string,
  allowedCommands: string[],
  deniedPathChecker?: (path: string) => boolean,
): ShellValidationResult {
  // Tokenize
  let tokens: string[];
  try {
    tokens = tokenize(input);
  } catch {
    return { valid: false, reason: 'Failed to parse shell command', commands: [] };
  }

  if (tokens.length === 0) {
    return { valid: false, reason: 'Empty command', commands: [] };
  }

  // Check for subshell markers
  if (tokens.includes('$(') || tokens.includes('`')) {
    return { valid: false, reason: 'Subshell execution not allowed', commands: [] };
  }

  // Split into individual commands
  const commands = splitCommands(tokens);

  if (commands.length === 0) {
    return { valid: false, reason: 'No commands parsed', commands: [] };
  }

  // Validate each command
  for (const cmd of commands) {
    if (!cmd.command) {
      return { valid: false, reason: 'Empty command in chain', commands };
    }

    // Check command against allowed list
    const isAllowed = allowedCommands.some((allowed) =>
      allowedEntryMatchesCommand(cmd, allowed),
    );

    if (!isAllowed) {
      return { valid: false, reason: `Command '${cmd.command}' is not in allowed list`, commands };
    }

    // Check all args and redirects against denied paths
    if (deniedPathChecker) {
      for (const arg of cmd.args) {
        if (deniedPathChecker(arg)) {
          return { valid: false, reason: `Argument '${arg}' references a denied path`, commands };
        }
      }

      for (const redirect of cmd.redirects) {
        if (deniedPathChecker(redirect)) {
          return { valid: false, reason: `Redirect target '${redirect}' references a denied path`, commands };
        }
      }
    }
  }

  return { valid: true, commands };
}
