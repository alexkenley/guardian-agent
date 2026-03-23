import readline from 'node:readline';

let currentUrl = 'about:blank';

const PLAYWRIGHT_TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description: 'Capture a page accessibility snapshot.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element on the current page.',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string' },
        ref: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an element.',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string' },
        ref: { type: 'string' },
        text: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_select_option',
    description: 'Select an option in a form field.',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string' },
        ref: { type: 'string' },
        values: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },
  },
  {
    name: 'browser_evaluate',
    description: 'Evaluate a browser-side extraction function.',
    inputSchema: {
      type: 'object',
      properties: {
        function: { type: 'string' },
      },
      required: ['function'],
    },
  },
];

function sendMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

function pageProfile(url) {
  if (url.includes('example.com')) {
    return {
      title: 'Example Domain',
      links: [{ text: 'More information...', href: 'https://www.iana.org/help/example-domains' }],
      structuredData: {
        metadata: {
          url: 'https://example.com/',
          title: 'Example Domain',
          description: 'This domain is for use in illustrative examples in documents.',
          canonicalUrl: 'https://example.com/',
          openGraph: {
            title: 'Example Domain',
            description: 'This domain is for use in illustrative examples in documents.',
            type: 'website',
            image: null,
          },
          twitter: {
            card: null,
            title: null,
            description: null,
            image: null,
          },
        },
        headings: [{ level: 1, text: 'Example Domain' }],
        landmarks: [{ role: 'main', label: null }],
        jsonLd: [],
      },
      interactiveElements: [{ ref: 'link-more-info', role: 'link', name: 'More information...' }],
    };
  }

  if (url.includes('github.com')) {
    return {
      title: 'GitHub · Change is constant. GitHub keeps you ahead.',
      links: [
        { text: 'Sign in', href: 'https://github.com/login' },
        { text: 'Sign up', href: 'https://github.com/signup' },
      ],
      structuredData: {
        metadata: {
          url: 'https://github.com/',
          title: 'GitHub',
          description: 'GitHub keeps you ahead.',
          canonicalUrl: 'https://github.com/',
          openGraph: {
            title: 'GitHub',
            description: 'GitHub keeps you ahead.',
            type: 'website',
            image: null,
          },
          twitter: {
            card: null,
            title: null,
            description: null,
            image: null,
          },
        },
        headings: [
          { level: 1, text: 'GitHub keeps you ahead.' },
          { level: 2, text: 'The world’s most popular development platform.' },
        ],
        landmarks: [
          { role: 'banner', label: null },
          { role: 'main', label: null },
          { role: 'contentinfo', label: null },
        ],
        jsonLd: [],
      },
      interactiveElements: [
        { ref: 'e1', role: 'link', name: 'Sign in' },
        { ref: 'e2', role: 'link', name: 'Sign up' },
      ],
    };
  }

  if (url.includes('httpbin.org/forms/post')) {
    return {
      title: 'HTTPBin Forms',
      links: [],
      structuredData: {
        metadata: {
          url: 'https://httpbin.org/forms/post',
          title: 'HTTPBin Forms',
          description: 'Pizza order form.',
          canonicalUrl: 'https://httpbin.org/forms/post',
          openGraph: {
            title: 'HTTPBin Forms',
            description: 'Pizza order form.',
            type: 'website',
            image: null,
          },
          twitter: {
            card: null,
            title: null,
            description: null,
            image: null,
          },
        },
        headings: [{ level: 1, text: 'Pizza order form' }],
        landmarks: [{ role: 'main', label: null }],
        jsonLd: [],
      },
      interactiveElements: [
        { ref: 'e5', role: 'textbox', name: 'Customer name' },
        { ref: 'e6', role: 'textbox', name: 'Telephone' },
        { ref: 'e7', role: 'textbox', name: 'E-mail address' },
        { ref: 'e9', role: 'button', name: 'Submit order' },
      ],
    };
  }

  return {
    title: currentUrl,
    links: [],
    structuredData: {
      metadata: {
        url: currentUrl,
        title: currentUrl,
        description: null,
        canonicalUrl: currentUrl,
        openGraph: {
          title: currentUrl,
          description: null,
          type: null,
          image: null,
        },
        twitter: {
          card: null,
          title: null,
          description: null,
          image: null,
        },
      },
      headings: [],
      landmarks: [],
      jsonLd: [],
    },
    interactiveElements: [],
  };
}

function buildSnapshot(page) {
  return page.interactiveElements
    .map((element) => `${element.role} ref=${element.ref} ${element.name}`)
    .join('\n');
}

function buildEvaluateResult(page, fnSource) {
  const source = String(fnSource || '');
  if (source.includes('querySelectorAll(\'a[href]\')') || source.includes('querySelectorAll("a[href]")')) {
    return JSON.stringify(page.links);
  }
  return JSON.stringify(page.structuredData);
}

function buildToolText(name, args = {}) {
  if (name === 'browser_navigate') {
    currentUrl = typeof args.url === 'string' ? args.url : currentUrl;
    const page = pageProfile(currentUrl);
    return JSON.stringify({ url: currentUrl, title: page.title });
  }

  const page = pageProfile(currentUrl);

  if (name === 'browser_snapshot') {
    return JSON.stringify({
      url: currentUrl,
      title: page.title,
      contentType: 'snapshot',
      snapshot: buildSnapshot(page),
    });
  }

  if (name === 'browser_click') {
    return JSON.stringify({
      clicked: args.element ?? args.ref ?? null,
      url: currentUrl,
    });
  }

  if (name === 'browser_type') {
    return JSON.stringify({
      element: args.element ?? args.ref ?? null,
      text: args.text ?? '',
      url: currentUrl,
    });
  }

  if (name === 'browser_select_option') {
    return JSON.stringify({
      element: args.element ?? args.ref ?? null,
      values: Array.isArray(args.values) ? args.values : [],
      url: currentUrl,
    });
  }

  if (name === 'browser_evaluate') {
    return buildEvaluateResult(page, args.function);
  }

  return JSON.stringify({ ok: true, name, url: currentUrl });
}

function handleRequest(message) {
  if (!message || typeof message !== 'object') {
    return;
  }

  const { id, method, params } = message;
  if (!method) {
    return;
  }

  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: 'fake-playwright-browser',
        version: '0.1.0',
      },
    });
    return;
  }

  if (method === 'tools/list') {
    sendResult(id, {
      tools: PLAYWRIGHT_TOOLS,
    });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    if (typeof name !== 'string') {
      sendError(id, -32602, 'Tool name is required');
      return;
    }
    sendResult(id, {
      content: [
        {
          type: 'text',
          text: buildToolText(name, params?.arguments ?? {}),
        },
      ],
    });
    return;
  }

  if (id !== undefined && id !== null) {
    sendError(id, -32601, `Unsupported method '${method}'`);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  try {
    handleRequest(JSON.parse(trimmed));
  } catch {
    // Ignore malformed input so the harness can surface protocol issues cleanly.
  }
});
