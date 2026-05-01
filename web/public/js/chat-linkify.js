const LINK_PATTERN = /\[([^\]\n]{1,240})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"']+)/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]$/;
const CLOSING_BRACKETS = new Map([
  [')', '('],
  [']', '['],
  ['}', '{'],
]);

function safeHttpUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.href;
    }
  } catch {
    return null;
  }
  return null;
}

function countChar(value, char) {
  let count = 0;
  for (const candidate of value) {
    if (candidate === char) {
      count += 1;
    }
  }
  return count;
}

function splitTrailingPlainUrlText(rawUrl) {
  let linkText = rawUrl;
  let suffix = '';
  while (TRAILING_PUNCTUATION.test(linkText)) {
    suffix = `${linkText.at(-1)}${suffix}`;
    linkText = linkText.slice(0, -1);
  }

  while (linkText.length > 0) {
    const close = linkText.at(-1);
    const open = CLOSING_BRACKETS.get(close);
    if (!open || countChar(linkText, close) <= countChar(linkText, open)) {
      break;
    }
    suffix = `${close}${suffix}`;
    linkText = linkText.slice(0, -1);
  }

  return { linkText, suffix };
}

function pushTextToken(tokens, text) {
  if (!text) {
    return;
  }
  const previous = tokens.at(-1);
  if (previous?.type === 'text') {
    previous.text = `${previous.text}${text}`;
    return;
  }
  tokens.push({ type: 'text', text });
}

export function parseSafeTextLinks(value) {
  const text = String(value ?? '');
  const tokens = [];
  let cursor = 0;
  LINK_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(LINK_PATTERN)) {
    const index = match.index ?? 0;
    if (index < cursor) {
      continue;
    }

    pushTextToken(tokens, text.slice(cursor, index));

    const markdownLabel = match[1];
    const markdownUrl = match[2];
    const plainUrl = match[3];
    if (markdownUrl) {
      const href = safeHttpUrl(markdownUrl);
      if (href) {
        tokens.push({ type: 'link', text: markdownLabel, href });
      } else {
        pushTextToken(tokens, match[0]);
      }
      cursor = index + match[0].length;
      continue;
    }

    const { linkText, suffix } = splitTrailingPlainUrlText(plainUrl);
    const href = safeHttpUrl(linkText);
    if (href) {
      tokens.push({ type: 'link', text: linkText, href });
      pushTextToken(tokens, suffix);
    } else {
      pushTextToken(tokens, match[0]);
    }
    cursor = index + match[0].length;
  }

  pushTextToken(tokens, text.slice(cursor));
  return tokens;
}

export function renderLinkedText(container, value) {
  container.replaceChildren();
  for (const token of parseSafeTextLinks(value)) {
    if (token.type === 'link') {
      const anchor = document.createElement('a');
      anchor.href = token.href;
      anchor.textContent = token.text;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.referrerPolicy = 'no-referrer';
      anchor.title = token.href;
      container.appendChild(anchor);
    } else {
      container.appendChild(document.createTextNode(token.text));
    }
  }
}
