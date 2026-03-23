import readline from 'node:readline';

const serverKind = process.argv[2] === 'lightpanda' ? 'lightpanda' : 'playwright';
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
];

const LIGHTPANDA_TOOLS = [
  {
    name: 'goto',
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
    name: 'markdown',
    description: 'Extract page markdown.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'links',
    description: 'List links on the current page.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'structuredData',
    description: 'Extract structured page metadata.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'semantic_tree',
    description: 'Extract a semantic outline for the current page.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'interactiveElements',
    description: 'List interactive elements on the current page.',
    inputSchema: {
      type: 'object',
      properties: {},
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
      markdown: '# Example Domain\n\nThis domain is for use in documentation examples.\n\n[More information...](https://www.iana.org/help/example-domains)',
      links: [{ text: 'More information...', href: 'https://www.iana.org/help/example-domains' }],
      structuredData: {
        title: 'Example Domain',
        description: 'This domain is for use in illustrative examples in documents.',
        canonical: 'https://example.com/',
      },
      semanticTree: {
        outline: [
          'Header: Example Domain',
          'Body: explanatory copy',
          'Footer: More information link',
        ],
      },
      interactiveElements: [{ ref: 'link-more-info', role: 'link', name: 'More information...' }],
    };
  }

  if (url.includes('github.com')) {
    return {
      title: 'GitHub · Change is constant. GitHub keeps you ahead.',
      markdown: '# GitHub keeps you ahead.\n\nThe world’s most popular development platform.',
      links: [
        { text: 'Sign in', href: 'https://github.com/login' },
        { text: 'Sign up', href: 'https://github.com/signup' },
      ],
      structuredData: {
        title: 'GitHub',
        description: 'GitHub keeps you ahead.',
        canonical: 'https://github.com/',
        openGraphTitle: 'GitHub',
      },
      semanticTree: {
        outline: [
          'Header / Navigation',
          'Hero: GitHub keeps you ahead.',
          'Feature highlights',
          'Footer',
        ],
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
      markdown: '# Pizza order form\n\nCustomer name, telephone, email, toppings, and submit button.',
      links: [],
      structuredData: {
        title: 'HTTPBin Forms',
      },
      semanticTree: {
        outline: [
          'Form: customer details',
          'Form: pizza size',
          'Form: toppings',
          'Submit order button',
        ],
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
    markdown: `# ${currentUrl}`,
    links: [],
    structuredData: { title: currentUrl },
    semanticTree: { outline: [currentUrl] },
    interactiveElements: [],
  };
}

function buildToolText(name, args = {}) {
  if (name === 'browser_navigate' || name === 'goto') {
    currentUrl = typeof args.url === 'string' ? args.url : currentUrl;
    const page = pageProfile(currentUrl);
    return JSON.stringify({ url: currentUrl, title: page.title });
  }

  const page = pageProfile(currentUrl);

  if (name === 'browser_snapshot') {
    const snapshot = page.interactiveElements
      .map((element) => `${element.role} ref=${element.ref} ${element.name}`)
      .join('\n');
    return JSON.stringify({
      url: currentUrl,
      title: page.title,
      contentType: 'snapshot',
      snapshot,
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

  if (name === 'markdown') {
    return page.markdown;
  }

  if (name === 'links') {
    return JSON.stringify(page.links);
  }

  if (name === 'structuredData') {
    return JSON.stringify(page.structuredData);
  }

  if (name === 'semantic_tree') {
    return JSON.stringify(page.semanticTree);
  }

  if (name === 'interactiveElements') {
    return JSON.stringify(page.interactiveElements);
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
        name: `fake-${serverKind}-browser`,
        version: '0.1.0',
      },
    });
    return;
  }

  if (method === 'tools/list') {
    sendResult(id, {
      tools: serverKind === 'lightpanda' ? LIGHTPANDA_TOOLS : PLAYWRIGHT_TOOLS,
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
