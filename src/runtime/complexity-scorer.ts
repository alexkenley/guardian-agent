/**
 * Complexity Scorer — pure function module for message complexity analysis.
 *
 * Scores user messages on a 0-1 scale using 8 weighted text heuristics.
 * Used by the tier router to decide whether a message should go to the
 * local (free) LLM or the external (capable) LLM.
 *
 * No async, no runtime dependencies — pure text analysis.
 */

/** Result of a complexity scoring operation. */
export interface ComplexityResult {
  /** Overall complexity score, 0 (trivial) to 1 (highly complex). */
  score: number;
  /** Per-signal breakdown, each 0-1. */
  signals: Record<string, number>;
  /** Recommended tier based on score vs threshold. */
  tier: 'local' | 'external';
}

/** Deep-reasoning question words. */
const DEEP_QUESTIONS = /\b(why|how|explain|compare|analyze|analyse|evaluate|contrast|assess|justify|critique)\b/gi;

/** Shallow-question words (don't add complexity). */
const SHALLOW_QUESTIONS = /\b(what|list|show|get|find|who|where|when|which)\b/gi;

/** Technical jargon terms. */
const TECHNICAL_TERMS = /\b(api|schema|async|pipeline|middleware|runtime|deploy|kubernetes|docker|microservice|architecture|algorithm|database|sql|nosql|oauth|jwt|webhook|endpoint|latency|throughput|concurrency|mutex|semaphore|coroutine|regex|ssl|tls|dns|tcp|udp|graphql|restful|grpc|protobuf|serializ|deserializ|polymorphi|abstraction|encapsulat|inherit|recursion|memoiz|cache|proxy|loadbalanc|sharding|replicat|partition|index|normaliz|denormaliz|transpil|webpack|bundl|treeshak|hydrat|ssr|csr|csrf|xss|injection|sanitiz|encrypt|decrypt|hash|cipher|token|bearer|certificate|auth|scalab|monolith|distribut|orchestrat|infrastruc|refactor|deprecat|idempoten|payload|marshalling|versioning)/gi;

/** Multi-step markers: sequencing language and numbered steps. */
const MULTI_STEP = /\b(first|then|next|after that|finally|step \d|secondly|thirdly|lastly|afterward|subsequently)\b/gi;

/** Abstraction / advisory markers. */
const ABSTRACTION_MARKERS = /\b(best approach|trade-?offs?|should i|recommend|pros and cons|advantages|disadvantages|considerations|best practice|design pattern|when to use|which is better|opinion)\b/gi;

/** Constraint markers: conditional/exclusion language. */
const CONSTRAINT_MARKERS = /\b(but not|except|unless|however|without|excluding|only if|as long as|provided that|on the condition|do not|don't|must not|never)\b/gi;

/** Code block detection (fenced blocks or inline backticks with content). */
const CODE_BLOCK = /```[\s\S]*?```|`[^`]+`/g;

/** Web search intent patterns — external knowledge needed. */
const WEB_SEARCH_PATTERNS = [
  /\b(?:search|find|look\s*up|google|browse)\b/i,
  /\b(?:what\s+(?:are|is)\s+the\s+(?:latest|newest|current|best|top))\b/i,
  /\b(?:news|weather|price|recipe|reviews?|nearby|restaurants?|hotels?)\b/i,
  /\b(?:how\s+(?:to|do|does|can|much)|where\s+(?:is|are|can|to)|who\s+(?:is|are|was))\b/i,
];

/**
 * Score the complexity of a message.
 *
 * @param content  — the user message text
 * @param threshold — score at or above this is 'external', below is 'local' (default 0.5)
 * @returns ComplexityResult with score, signal breakdown, and tier
 */
export function scoreComplexity(content: string, threshold = 0.5): ComplexityResult {
  if (!content || content.trim().length === 0) {
    return { score: 0, signals: emptySignals(), tier: 'local' };
  }

  const text = content.trim();

  const signals: Record<string, number> = {
    messageLength: scoreMessageLength(text),
    sentenceCount: scoreSentenceCount(text),
    questionDepth: scoreQuestionDepth(text),
    technicalDensity: scoreTechnicalDensity(text),
    multiStepMarkers: scoreMultiStep(text),
    abstractionMarkers: scoreAbstraction(text),
    codeBlockPresence: scoreCodeBlocks(text),
    constraintComplexity: scoreConstraints(text),
    webSearchIntent: scoreWebSearchIntent(text),
  };

  // Weights sum to 1.0 — webSearchIntent is additive; core signals keep their strength.
  const weights: Record<string, number> = {
    messageLength: 0.09,
    sentenceCount: 0.04,
    questionDepth: 0.19,
    technicalDensity: 0.15,
    multiStepMarkers: 0.14,
    abstractionMarkers: 0.14,
    codeBlockPresence: 0.09,
    constraintComplexity: 0.09,
    webSearchIntent: 0.07,
  };

  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    score += signals[key] * weight;
  }

  score = clamp(score, 0, 1);
  const tier = score >= threshold ? 'external' : 'local';

  return { score, signals, tier };
}

// ─── Individual signal scorers ──────────────────────────────

/** Message length — saturates at ~800 chars. */
function scoreMessageLength(text: string): number {
  return clamp(text.length / 800, 0, 1);
}

/** Sentence count — saturates at ~6 sentences. */
function scoreSentenceCount(text: string): number {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  return clamp(sentences.length / 6, 0, 1);
}

/** Question depth — deep questions (why/how/explain) vs shallow (what/list). */
function scoreQuestionDepth(text: string): number {
  const deepMatches = (text.match(DEEP_QUESTIONS) ?? []).length;
  const shallowMatches = (text.match(SHALLOW_QUESTIONS) ?? []).length;
  const total = deepMatches + shallowMatches;
  if (total === 0) return 0;
  // Ratio of deep questions + bonus for having many deep questions
  const depthRatio = deepMatches / total;
  const volumeBonus = clamp(deepMatches / 4, 0, 0.5);
  return clamp(depthRatio * 0.7 + volumeBonus, 0, 1);
}

/** Technical density — ratio of technical terms to total words. */
function scoreTechnicalDensity(text: string): number {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return 0;
  const techMatches = (text.match(TECHNICAL_TERMS) ?? []).length;
  // Saturates when ~20% of words are technical
  return clamp((techMatches / words.length) / 0.2, 0, 1);
}

/** Multi-step markers — sequencing language presence. */
function scoreMultiStep(text: string): number {
  const matches = (text.match(MULTI_STEP) ?? []).length;
  // 1 marker = 0.4, 2 = 0.7, 3+ = 1.0
  if (matches === 0) return 0;
  if (matches === 1) return 0.4;
  if (matches === 2) return 0.7;
  return 1.0;
}

/** Abstraction markers — advisory/design language. */
function scoreAbstraction(text: string): number {
  const matches = (text.match(ABSTRACTION_MARKERS) ?? []).length;
  if (matches === 0) return 0;
  if (matches === 1) return 0.5;
  return 1.0;
}

/** Code block presence — fenced or inline code. */
function scoreCodeBlocks(text: string): number {
  const blocks = (text.match(CODE_BLOCK) ?? []);
  if (blocks.length === 0) return 0;
  // Fenced blocks are more significant than inline
  const hasFenced = blocks.some(b => b.startsWith('```'));
  if (hasFenced) return 1.0;
  // Inline only
  return clamp(blocks.length / 3, 0.3, 0.8);
}

/** Constraint complexity — conditional/exclusion language. */
function scoreConstraints(text: string): number {
  const matches = (text.match(CONSTRAINT_MARKERS) ?? []).length;
  if (matches === 0) return 0;
  if (matches === 1) return 0.4;
  if (matches === 2) return 0.7;
  return 1.0;
}

/** Web search intent — presence of patterns suggesting external knowledge is needed. */
function scoreWebSearchIntent(text: string): number {
  // Exclude filesystem-focused messages
  if (/\b(file|folder|directory|path|\.txt|\.json|\.ts|\.js|\.py)\b/i.test(text)) return 0;
  const matchCount = WEB_SEARCH_PATTERNS.filter(p => p.test(text)).length;
  if (matchCount === 0) return 0;
  if (matchCount === 1) return 0.4;
  if (matchCount === 2) return 0.7;
  return 1.0;
}

// ─── Helpers ────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function emptySignals(): Record<string, number> {
  return {
    messageLength: 0,
    sentenceCount: 0,
    questionDepth: 0,
    technicalDensity: 0,
    multiStepMarkers: 0,
    abstractionMarkers: 0,
    codeBlockPresence: 0,
    constraintComplexity: 0,
    webSearchIntent: 0,
  };
}
