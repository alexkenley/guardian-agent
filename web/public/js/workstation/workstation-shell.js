const WORKSTATION_MODE_KEY = 'guardianagent_workstation_mode';
const WORKSTATION_MODE_EVENT = 'guardianagent:workstation-mode-change';
const WORKSTATION_LAYOUT_KEY = 'guardianagent_workstation_layout_v1';
const CLASSIC_CHAT_WIDTH_KEY = 'guardianagent_chat_rail_width';
const CLASSIC_CHAT_HEIGHT_KEY = 'guardianagent_chat_rail_height';
const MIN_CHAT_WIDTH = 360;
const MAX_CHAT_WIDTH = 680;
const DEFAULT_CHAT_WIDTH = 460;
const MIN_CHAT_HEIGHT = 240;
const DEFAULT_CHAT_HEIGHT = 320;
const MIN_FRAME_WIDTH = 360;
const MIN_FRAME_HEIGHT = 260;
const FRAME_VIEWPORT_MARGIN = 8;

const ROUTE_META = {
  '/': {
    label: 'Second Brain',
    icon: '<path d="M9.5 2a4.5 4.5 0 0 0-4.4 3.5A3.5 3.5 0 0 0 3 9c0 1.2.6 2.3 1.5 3A3.5 3.5 0 0 0 7 18.5h.5V22h9V2H9.5Z"/>',
    sections: [
      { label: 'Today', tab: 'Today' },
      { label: 'Calendar', tab: 'Calendar' },
      { label: 'Tasks', tab: 'Tasks' },
      { label: 'Notes', tab: 'Notes' },
      { label: 'Contacts', tab: 'Contacts' },
      { label: 'Library', tab: 'Library' },
      { label: 'Briefs', tab: 'Briefs' },
      { label: 'Routines', tab: 'Routines' },
    ],
  },
  '/system': {
    label: 'System',
    icon: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    sections: [{ label: 'Pending Approvals' }, { label: 'Runtime' }, { label: 'Activity' }],
  },
  '/security': {
    label: 'Security',
    icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    sections: [{ label: 'Security Log' }, { label: 'Alerts' }, { label: 'Posture' }],
  },
  '/network': {
    label: 'Network',
    icon: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20"/><path d="M12 2a15 15 0 0 0 0 20"/>',
    sections: [{ label: 'Connections' }, { label: 'Hosts' }, { label: 'Traffic' }],
  },
  '/cloud': {
    label: 'Cloud',
    icon: '<path d="M17.5 19a4.5 4.5 0 1 0-1.5-8.7 7 7 0 0 0-13.5 2.6A4 4 0 0 0 5.5 19h12Z"/>',
    sections: [{ label: 'Connections' }, { label: 'Sync' }, { label: 'Profiles' }],
  },
  '/automations': {
    label: 'Automations',
    icon: '<path d="M18 3 22 7l-4 4"/><path d="M8 7v3a4 4 0 0 1-4 4"/><path d="M6 21l-4-4 4-4"/><path d="M16 17v-3a4 4 0 0 1 4-4"/>',
    sections: [{ label: 'Runs' }, { label: 'Schedules' }, { label: 'Approvals' }],
  },
  '/code': {
    label: 'Code',
    icon: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    sections: [{ label: 'Sessions' }, { label: 'Editor' }, { label: 'Terminal' }, { label: 'Tasks' }, { label: 'Checks' }],
  },
  '/memory': {
    label: 'Memory',
    icon: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
    sections: [
      { label: 'Browse', tab: 'Browse' },
      { label: 'Wiki', tab: 'Wiki' },
      { label: 'Entries', tab: 'Entries' },
      { label: 'Lint', tab: 'Lint' },
      { label: 'Audit', tab: 'Audit' },
    ],
  },
  '/reference': {
    label: 'Reference',
    icon: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    sections: [{ label: 'Guide' }, { label: 'Commands' }, { label: 'Configuration' }],
  },
  '/performance': {
    label: 'Performance',
    icon: '<circle cx="12" cy="12" r="10"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="m4.93 4.93 2.83 2.83"/><path d="m16.24 16.24 2.83 2.83"/><path d="m4.93 19.07 2.83-2.83"/><path d="m16.24 7.76 2.83-2.83"/>',
    sections: [{ label: 'Profiles' }, { label: 'Processes' }, { label: 'Latency' }, { label: 'Cleanup' }],
  },
  '/config': {
    label: 'Configuration',
    icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    sections: [
      { label: 'Overview', tab: 'overview' },
      { label: 'AI Providers', tab: 'ai-providers' },
      { label: 'Search Providers', tab: 'search-providers' },
      { label: 'Second Brain', tab: 'second-brain' },
      { label: 'Tools', tab: 'tools' },
      { label: 'Security', tab: 'security' },
      { label: 'Integration System', tab: 'integration-system' },
      { label: 'Appearance', tab: 'appearance' },
      { label: 'Shell Layer', tab: 'appearance', target: 'Shell Layer' },
      { label: 'Display Controls', tab: 'appearance', target: 'Display Controls' },
      { label: 'Configured Providers', tab: 'ai-providers', target: 'Configured Providers' },
      { label: 'Credential Refs', tab: 'ai-providers', target: 'Credential Refs' },
      { label: 'Sandbox & Policy Access', tab: 'security', target: 'Sandbox & Policy Access' },
      { label: 'Authentication', tab: 'security', target: 'Authentication' },
    ],
  },
};

const DOCK_ROUTES = ['/', '/system', '/security', '/network', '/cloud', '/automations', '/code', '/memory', '/reference', '/performance', '/config'];

export function installClassicChatRailResize({ layout, chatPanel }) {
  if (!layout || !chatPanel) {
    return { apply: () => {}, destroy: () => {} };
  }

  const existing = chatPanel.querySelector('.chat-rail-resizer');
  if (existing) existing.remove();

  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'chat-rail-resizer';
  handle.setAttribute('aria-label', 'Resize chat rail');
  handle.title = 'Resize chat rail';
  chatPanel.prepend(handle);

  const clampWidth = (value) => {
    const viewportMax = Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, Math.floor(window.innerWidth * 0.48)));
    return Math.max(MIN_CHAT_WIDTH, Math.min(viewportMax, value));
  };
  const clampHeight = (value) => {
    const viewportMax = Math.max(MIN_CHAT_HEIGHT, Math.floor(window.innerHeight * 0.58));
    return Math.max(MIN_CHAT_HEIGHT, Math.min(viewportMax, value));
  };
  const isStackedLayout = () => window.matchMedia('(max-width: 1024px)').matches;

  const applyWidth = (width) => {
    const next = clampWidth(width || DEFAULT_CHAT_WIDTH);
    layout.style.setProperty('--chat-column-width', `${next}px`);
    layout.style.setProperty('--layout-chat-column', `${next}px`);
    layout.style.setProperty('--layout-chat-column-wide', `${next}px`);
  };
  const applyHeight = (height) => {
    const next = clampHeight(height || DEFAULT_CHAT_HEIGHT);
    layout.style.setProperty('--chat-row-height', `${next}px`);
  };

  const stored = Number(localStorage.getItem(CLASSIC_CHAT_WIDTH_KEY));
  const storedHeight = Number(localStorage.getItem(CLASSIC_CHAT_HEIGHT_KEY));
  applyWidth(Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_CHAT_WIDTH);
  applyHeight(Number.isFinite(storedHeight) && storedHeight > 0 ? storedHeight : DEFAULT_CHAT_HEIGHT);

  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartWidth = DEFAULT_CHAT_WIDTH;
  let dragStartHeight = DEFAULT_CHAT_HEIGHT;
  let dragging = false;

  const stopDrag = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('is-resizing-chat-rail');
    const width = parseInt(layout.style.getPropertyValue('--chat-column-width'), 10);
    const height = parseInt(layout.style.getPropertyValue('--chat-row-height'), 10);
    if (Number.isFinite(width)) localStorage.setItem(CLASSIC_CHAT_WIDTH_KEY, String(width));
    if (Number.isFinite(height)) localStorage.setItem(CLASSIC_CHAT_HEIGHT_KEY, String(height));
    window.removeEventListener('pointermove', onDrag);
    window.removeEventListener('pointerup', stopDrag);
    window.removeEventListener('pointercancel', stopDrag);
  };

  function onDrag(event) {
    if (!dragging) return;
    if (isStackedLayout()) {
      applyHeight(dragStartHeight + dragStartY - event.clientY);
    } else {
      applyWidth(dragStartWidth + dragStartX - event.clientX);
    }
  }

  handle.addEventListener('pointerdown', (event) => {
    if (document.body.classList.contains('workstation-mode')) return;
    dragging = true;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragStartWidth = chatPanel.getBoundingClientRect().width || DEFAULT_CHAT_WIDTH;
    dragStartHeight = chatPanel.getBoundingClientRect().height || DEFAULT_CHAT_HEIGHT;
    document.body.classList.add('is-resizing-chat-rail');
    handle.setPointerCapture?.(event.pointerId);
    window.addEventListener('pointermove', onDrag);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
  });

  window.addEventListener('resize', () => {
    const width = parseInt(layout.style.getPropertyValue('--chat-column-width'), 10);
    const height = parseInt(layout.style.getPropertyValue('--chat-row-height'), 10);
    applyWidth(Number.isFinite(width) ? width : DEFAULT_CHAT_WIDTH);
    applyHeight(Number.isFinite(height) ? height : DEFAULT_CHAT_HEIGHT);
  });

  return { apply: applyWidth, destroy: () => handle.remove() };
}

export function initWorkstationShell({
  app,
  routes,
  chatPanel,
  layout,
  content,
  getRouteState,
  renderRoute,
  updateChatContext,
}) {
  if (!app || !routes || !chatPanel || !layout || !content) return null;

  let active = localStorage.getItem(WORKSTATION_MODE_KEY) === 'true';
  let activePath = null;
  let activeRoute = null;
  let zIndex = 20;
  let paletteSelectedIndex = 0;
  const frames = new Map();
  const frameState = loadLayoutState();
  const classicChatParent = layout;

  const shell = document.createElement('section');
  shell.id = 'workstation-shell';
  shell.className = 'workstation-shell';
  shell.setAttribute('aria-label', 'Guardian workstation shell');
  shell.innerHTML = `
    <header class="ws-titlebar">
      <div class="ws-titlebar__left">
        <span class="ws-brand"><span class="logo-mark" aria-hidden="true"></span><span>Guardian Workstation</span></span>
        <span class="ws-workspace-name">Desktop</span>
      </div>
      <div class="ws-titlebar__center">
        <button class="ws-command-trigger" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <span>Search panels and sections</span>
          <kbd>Ctrl K</kbd>
        </button>
      </div>
      <div class="ws-titlebar__right">
        <span class="ws-clock"></span>
        <span class="ws-status">Connected</span>
        <button class="ws-exit" type="button">Classic</button>
        <button class="ws-killswitch" type="button" title="Shut down all services" aria-label="Shut down all services">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m13 2-9 13h7l-1 7 9-13h-7l1-7Z"/>
            <path d="m3 3 18 18"/>
          </svg>
          <span>Killswitch</span>
        </button>
      </div>
    </header>
    <main class="ws-stage">
      <div class="ws-desktop-hint">Open panels from the dock or search. Windows keep their size, position, and stacking order.</div>
    </main>
    <nav class="ws-dock" aria-label="Workstation dock"></nav>
    <div class="ws-palette-backdrop">
      <div class="ws-palette" role="dialog" aria-label="Command palette">
        <div class="ws-palette__input">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="search" placeholder="Search panels, sub-panels, and sections" aria-label="Open a page or frame">
          <span class="ws-kbd">Esc</span>
        </div>
        <div class="ws-palette__list"></div>
      </div>
    </div>
  `;
  app.appendChild(shell);

  const stage = shell.querySelector('.ws-stage');
  const dock = shell.querySelector('.ws-dock');
  const clockEl = shell.querySelector('.ws-clock');
  const statusEl = shell.querySelector('.ws-status');
  const palette = shell.querySelector('.ws-palette-backdrop');
  const paletteInput = shell.querySelector('.ws-palette__input input');
  const paletteList = shell.querySelector('.ws-palette__list');
  const commandTrigger = shell.querySelector('.ws-command-trigger');
  const workspaceName = shell.querySelector('.ws-workspace-name');
  const exitButton = shell.querySelector('.ws-exit');
  const workstationKillButton = shell.querySelector('.ws-killswitch');
  const toggleButton = document.getElementById('workstation-toggle');

  const chatFrame = createFrame({
    key: 'chat',
    title: 'Assistant',
    routePath: 'persistent chat',
    icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    trust: 'request scoped',
    className: 'ws-chat-frame',
    bodyClassName: 'ws-chat-body',
    rect: getSavedRect('chat') || chatRect(),
  });
  frames.set('chat', chatFrame);
  stage.appendChild(chatFrame.el);

  renderDock();
  renderPaletteRows('');
  syncMode();
  startClock();
  observeConnection();

  exitButton.addEventListener('click', () => setActive(false));
  workstationKillButton?.addEventListener('click', () => {
    document.getElementById('killswitch-btn')?.click();
  });
  window.addEventListener(WORKSTATION_MODE_EVENT, (event) => setActive(Boolean(event?.detail?.active)));
  toggleButton?.addEventListener('click', () => setActive(!active));
  commandTrigger?.addEventListener('click', () => openPalette());
  palette?.addEventListener('click', (event) => {
    if (event.target === palette) closePalette();
  });
  paletteInput?.addEventListener('input', () => renderPaletteRows(paletteInput.value));
  paletteInput?.addEventListener('keydown', (event) => {
    const rows = getPaletteRows();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      paletteSelectedIndex = rows.length ? (paletteSelectedIndex + 1) % rows.length : 0;
      syncPaletteSelection();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      paletteSelectedIndex = rows.length ? (paletteSelectedIndex - 1 + rows.length) % rows.length : 0;
      syncPaletteSelection();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const selected = rows[paletteSelectedIndex] || rows[0];
      if (selected) {
        closePalette();
        void openTarget(JSON.parse(selected.dataset.target || '{}'));
      }
    }
  });
  window.addEventListener('keydown', (event) => {
    const isCommandK = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
    if (isCommandK && active) {
      event.preventDefault();
      openPalette();
    }
    if (event.key === 'Escape') closePalette();
  });
  window.addEventListener('resize', () => constrainAllFrames());
  window.addEventListener('pagehide', () => saveLayoutState());
  window.addEventListener('beforeunload', () => saveLayoutState());

  async function renderActiveRoute(options = {}) {
    if (!active) return false;
    const state = getRouteState();
    const path = state.path || '/';
    const route = state.route || routes['/'];
    const raw = window.location.hash.slice(1) || '/';
    const [, query] = raw.split('?');
    const params = new URLSearchParams(query || '');
    await openRouteFrame(path, route, params, { options, flashIfOpen: true });
    return true;
  }

  async function refreshActiveRoute(options = {}) {
    if (!active || !activePath || !activeRoute) return false;
    const frame = frames.get(activePath);
    if (!frame) return false;
    await renderRouteIntoFrame(frame, activeRoute, frame.params || new URLSearchParams(), options);
    return true;
  }

  async function openRouteFrame(path, route, params = new URLSearchParams(), { options = {}, flashIfOpen = true } = {}) {
    const key = path || '/';
    let frame = frames.get(key);
    const alreadyOpen = Boolean(frame);
    if (!frame) {
      const meta = getMeta(key, route);
      frame = createFrame({
        key,
        title: meta.label,
        routePath: key,
        icon: meta.icon,
        trust: 'page trusted',
        className: `ws-page-frame ws-route-frame ws-route-${cssSlug(route.name || key)}`,
        bodyClassName: 'ws-page-content',
        rect: getSavedRect(key) || defaultRouteRect(frames.size),
      });
      frames.set(key, frame);
      stage.appendChild(frame.el);
    }

    frame.el.hidden = false;
    frame.el.classList.toggle('is-maximized', Boolean(frameState.frames?.[key]?.maximized));
    frame.routeDef = route;
    frame.params = params;
    const meta = getMeta(key, route);
    frame.title.textContent = meta.label;
    frame.route.textContent = key;
    frame.icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${meta.icon}</svg>`;
    frame.body.className = `ws-frame__body ws-page-content${route.name === 'code' ? ' content-code-page' : ''}`;
    renderFrameNav(frame, key, route, params);
    focusFrame(frame, alreadyOpen && flashIfOpen);
    await renderRouteIntoFrame(frame, route, params, options);
    syncDock(key);
    saveLayoutState();
  }

  async function renderRouteIntoFrame(frame, route, params, options = {}) {
    updateChatContext?.(route.name);
    activePath = frame.key;
    activeRoute = route;
    workspaceName.textContent = `${getMeta(frame.key, route).label} active`;
    const target = options?.workstationTarget || null;
    await renderRoute({
      route,
      path: frame.key,
      params,
      container: frame.body,
      options,
    });
    if (target?.target) {
      await applyTarget(frame, target);
    } else {
      frame.body.scrollTop = 0;
    }
  }

  async function openTarget(target) {
    if (!target?.path || !routes[target.path]) return;
    const params = new URLSearchParams();
    if (target.tab) params.set('tab', target.tab);
    await openRouteFrame(target.path, routes[target.path], params, {
      options: { workstationTarget: target },
      flashIfOpen: true,
    });
    const nextHash = hashFor(target.path, params);
    if (window.location.hash !== nextHash) {
      window.history.pushState(null, '', nextHash);
    }
  }

  function setActive(nextActive) {
    active = Boolean(nextActive);
    localStorage.setItem(WORKSTATION_MODE_KEY, String(active));
    syncMode();
    if (active) void renderActiveRoute();
  }

  function syncMode() {
    document.body.classList.toggle('workstation-mode', active);
    toggleButton?.classList.toggle('is-active', active);
    if (toggleButton) {
      toggleButton.title = active ? 'Return to classic shell' : 'Open workstation shell';
      toggleButton.setAttribute('aria-pressed', String(active));
    }

    if (active) {
      chatFrame.body.appendChild(chatPanel);
      chatPanel.hidden = false;
      chatFrame.el.hidden = frameState.closed?.chat === true;
      restorePersistedRouteFrames();
    } else {
      classicChatParent.appendChild(chatPanel);
      chatPanel.hidden = false;
      closePalette();
    }
    syncDock(activePath);
  }

  function restorePersistedRouteFrames() {
    for (const [key, saved] of Object.entries(frameState.frames || {})) {
      if (key === 'chat' || saved.closed || frames.has(key) || !routes[key]) continue;
      void openRouteFrame(key, routes[key], new URLSearchParams(saved.query || ''), { flashIfOpen: false });
    }
  }

  function createFrame({ key, title, routePath, icon, trust, className, bodyClassName, rect }) {
    const frame = document.createElement('article');
    frame.className = `ws-frame ${className || ''}`.trim();
    frame.dataset.frameId = key;
    frame.innerHTML = `
      <header class="ws-frame__head">
        <span class="ws-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></span>
        <span class="ws-frame__title"><span class="ws-frame__label"></span><span class="ws-frame__route"></span></span>
        <span class="ws-frame__trust"></span>
        <span class="ws-frame__controls">
          <button class="ws-frame-control is-max" type="button" title="Maximize" aria-label="Maximize frame"><svg viewBox="0 0 24 24"><path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6"/></svg></button>
          <button class="ws-frame-control is-close" type="button" title="Close" aria-label="Close frame"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </span>
      </header>
      <nav class="ws-frame__nav" aria-label="Window sections" hidden></nav>
      <div class="ws-frame__body ${bodyClassName || ''}"></div>
      <span class="ws-resize-handle ws-resize-top" data-resize-edge="top" aria-hidden="true"></span>
      <span class="ws-resize-handle ws-resize-right" data-resize-edge="right" aria-hidden="true"></span>
      <span class="ws-resize-handle ws-resize-left" data-resize-edge="left" aria-hidden="true"></span>
      <span class="ws-resize-handle ws-resize-bottom" data-resize-edge="bottom" aria-hidden="true"></span>
      <span class="ws-resize-handle ws-resize-bottom-right" data-resize-edge="bottom-right" aria-hidden="true"></span>
      <span class="ws-resize-handle ws-resize-bottom-left" data-resize-edge="bottom-left" aria-hidden="true"></span>
    `;
    const frameObj = {
      key,
      el: frame,
      title: frame.querySelector('.ws-frame__label'),
      route: frame.querySelector('.ws-frame__route'),
      trust: frame.querySelector('.ws-frame__trust'),
      head: frame.querySelector('.ws-frame__head'),
      nav: frame.querySelector('.ws-frame__nav'),
      body: frame.querySelector('.ws-frame__body'),
      icon: frame.querySelector('.ws-icon'),
    };
    frameObj.title.textContent = title;
    frameObj.route.textContent = routePath;
    frameObj.trust.textContent = trust;
    setRect(frame, rect);
    makeDraggable(frameObj);
    frame.querySelectorAll('[data-resize-edge]').forEach((handle) => makeResizable(frameObj, handle));
    frame.addEventListener('pointerdown', () => focusFrame(frameObj, false));
    frame.querySelector('.is-close')?.addEventListener('click', () => closeFrame(frameObj));
    frame.querySelector('.is-max')?.addEventListener('click', () => {
      frame.classList.toggle('is-maximized');
      focusFrame(frameObj, false);
      saveLayoutState();
    });
    return frameObj;
  }

  function renderFrameNav(frame, path, route, params = new URLSearchParams()) {
    if (!frame.nav) return;
    const meta = getMeta(path, route);
    const seen = new Set();
    const tabs = [];
    for (const section of meta.sections || []) {
      if (!section.tab || seen.has(section.tab)) continue;
      seen.add(section.tab);
      tabs.push({ id: section.tab, label: section.label });
    }

    if (!tabs.length) {
      frame.nav.hidden = true;
      frame.nav.innerHTML = '';
      return;
    }

    const activeTab = params.get('tab') || tabs[0]?.id;
    frame.nav.hidden = false;
    frame.nav.innerHTML = tabs.map((tab) => `
      <button
        class="ws-frame__nav-btn${tab.id === activeTab ? ' is-active' : ''}"
        type="button"
        data-ws-tab="${escapeHtml(tab.id)}"
      >${escapeHtml(tab.label)}</button>
    `).join('');

    frame.nav.querySelectorAll('[data-ws-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        void openTarget({
          path,
          tab: button.dataset.wsTab,
          target: '',
          label: `${meta.label} · ${button.textContent?.trim() || button.dataset.wsTab}`,
        });
      });
    });
  }

  function closeFrame(frame) {
    const wasActiveRoute = frame.key !== 'chat' && activePath === frame.key;
    persistFrameSnapshot(frame, true);
    frame.el.hidden = true;
    if (!frameState.closed) frameState.closed = {};
    frameState.closed[frame.key] = true;
    if (frame.key !== 'chat') {
      frames.delete(frame.key);
      frame.el.remove();
    }
    if (wasActiveRoute) {
      const nextFrame = findTopOpenRouteFrame();
      activePath = nextFrame?.key || null;
      activeRoute = nextFrame?.routeDef || null;
      if (nextFrame) {
        focusFrame(nextFrame, false);
      }
    }
    syncDock(activePath);
    saveLayoutState();
  }

  function makeDraggable(frame) {
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let dragging = false;

    frame.head.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button') || frame.el.classList.contains('is-maximized')) return;
      dragging = true;
      focusFrame(frame, false);
      startX = event.clientX;
      startY = event.clientY;
      startLeft = frame.el.offsetLeft;
      startTop = frame.el.offsetTop;
      frame.head.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
    });

    function onMove(event) {
      if (!dragging) return;
      const bounds = getStageBounds();
      frame.el.style.left = `${clamp(startLeft + event.clientX - startX, FRAME_VIEWPORT_MARGIN, bounds.width - frame.el.offsetWidth - FRAME_VIEWPORT_MARGIN)}px`;
      frame.el.style.top = `${clamp(startTop + event.clientY - startY, 0, bounds.height - frame.el.offsetHeight - FRAME_VIEWPORT_MARGIN)}px`;
      frame.el.style.right = 'auto';
      persistFrameSnapshot(frame, false);
      writeLayoutState();
    }

    function stop() {
      dragging = false;
      persistFrameSnapshot(frame, false);
      saveLayoutState();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    }
  }

  function makeResizable(frame, handle) {
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let startWidth = 0;
    let startHeight = 0;
    let resizing = false;
    const edge = handle.dataset.resizeEdge || 'bottom-right';

    handle.addEventListener('pointerdown', (event) => {
      if (frame.el.classList.contains('is-maximized')) return;
      event.preventDefault();
      event.stopPropagation();
      resizing = true;
      focusFrame(frame, false);
      startX = event.clientX;
      startY = event.clientY;
      startLeft = frame.el.offsetLeft;
      startTop = frame.el.offsetTop;
      startWidth = frame.el.offsetWidth;
      startHeight = frame.el.offsetHeight;
      handle.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
    });

    function onMove(event) {
      if (!resizing) return;
      const bounds = getStageBounds();
      if (edge.includes('right')) {
        frame.el.style.width = `${clamp(startWidth + event.clientX - startX, MIN_FRAME_WIDTH, bounds.width - frame.el.offsetLeft - FRAME_VIEWPORT_MARGIN)}px`;
      }
      if (edge.includes('left')) {
        const delta = event.clientX - startX;
        const nextWidth = clamp(startWidth - delta, MIN_FRAME_WIDTH, startLeft + startWidth - FRAME_VIEWPORT_MARGIN);
        const nextLeft = startLeft + (startWidth - nextWidth);
        frame.el.style.left = `${nextLeft}px`;
        frame.el.style.width = `${nextWidth}px`;
      }
      if (edge.includes('bottom')) {
        frame.el.style.height = `${clamp(startHeight + event.clientY - startY, MIN_FRAME_HEIGHT, bounds.height - frame.el.offsetTop - FRAME_VIEWPORT_MARGIN)}px`;
      }
      if (edge.includes('top')) {
        const bottom = startTop + startHeight;
        const nextTop = clamp(startTop + event.clientY - startY, 0, bottom - MIN_FRAME_HEIGHT);
        frame.el.style.top = `${nextTop}px`;
        frame.el.style.height = `${bottom - nextTop}px`;
      }
      persistFrameSnapshot(frame, false);
      writeLayoutState();
    }

    function stop() {
      resizing = false;
      persistFrameSnapshot(frame, false);
      saveLayoutState();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    }
  }

  function renderDock() {
    dock.innerHTML = '';
    for (const path of DOCK_ROUTES) {
      if (!routes[path]) continue;
      const meta = getMeta(path, routes[path]);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ws-dock-item';
      button.title = meta.label;
      button.dataset.path = path;
      button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${meta.icon}</svg><span class="ws-dock-tip">${escapeHtml(meta.label)}</span>`;
      button.addEventListener('click', () => void openTarget({ path }));
      dock.appendChild(button);
      if (path === '/code' || path === '/config') {
        const sep = document.createElement('span');
        sep.className = 'ws-dock-sep';
        dock.appendChild(sep);
      }
    }
    const chatButton = document.createElement('button');
    chatButton.type = 'button';
    chatButton.className = 'ws-dock-item is-open';
    chatButton.title = 'Assistant';
    chatButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span class="ws-dock-tip">Assistant</span>';
    chatButton.addEventListener('click', () => {
      if (chatFrame.el.hidden) {
        chatFrame.el.hidden = false;
        if (frameState.closed) frameState.closed.chat = false;
        focusFrame(chatFrame, true);
      } else {
        focusFrame(chatFrame, true);
      }
      syncDock(activePath);
      saveLayoutState();
    });
    dock.appendChild(chatButton);
    const commandButton = document.createElement('button');
    commandButton.type = 'button';
    commandButton.className = 'ws-dock-item';
    commandButton.title = 'Command Palette';
    commandButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><span class="ws-dock-tip">Command Palette</span>';
    commandButton.addEventListener('click', () => openPalette());
    dock.appendChild(commandButton);
  }

  function syncDock(path) {
    dock.querySelectorAll('.ws-dock-item[data-path]').forEach((button) => {
      const frame = frames.get(button.dataset.path);
      const isOpen = Boolean(frame && !frame.el.hidden);
      button.classList.toggle('is-open', isOpen);
      button.classList.toggle('is-active', isOpen && button.dataset.path === path);
    });
    const chatButton = Array.from(dock.querySelectorAll('.ws-dock-item')).find((button) => button.title === 'Assistant');
    chatButton?.classList.toggle('is-open', !chatFrame.el.hidden);
  }

  function renderPaletteRows(filterText) {
    const filter = filterText.trim().toLowerCase();
    const targets = buildPaletteTargets().filter((target) => {
      if (!filter) return true;
      return `${target.label} ${target.path} ${target.meta || ''}`.toLowerCase().includes(filter);
    });
    paletteSelectedIndex = 0;
    paletteList.innerHTML = targets.map((target, index) => {
      const meta = getMeta(target.path, routes[target.path]);
      return `
        <button class="ws-palette__row${index === 0 ? ' is-selected' : ''}" type="button" data-target="${escapeHtml(JSON.stringify(target))}">
          <svg viewBox="0 0 24 24" aria-hidden="true">${meta.icon}</svg>
          <span class="ws-palette__label">${escapeHtml(target.label)}<span class="ws-palette__meta">${escapeHtml(target.meta || `Open ${target.path}`)}</span></span>
          <span class="ws-kbd">Enter</span>
        </button>
      `;
    }).join('');
    paletteList.querySelectorAll('.ws-palette__row').forEach((button) => {
      button.addEventListener('click', () => {
        closePalette();
        void openTarget(JSON.parse(button.dataset.target || '{}'));
      });
    });
  }

  function buildPaletteTargets() {
    const targets = [];
    for (const path of DOCK_ROUTES) {
      if (!routes[path]) continue;
      const meta = getMeta(path, routes[path]);
      targets.push({ path, label: meta.label, meta: `Panel · ${path}` });
      for (const section of meta.sections || []) {
        targets.push({
          path,
          tab: section.tab,
          target: section.target || (section.tab ? '' : section.label),
          label: `${meta.label} · ${section.label}`,
          meta: section.tab ? `Sub-panel · ${section.tab}` : 'Section',
        });
      }
    }
    return targets;
  }

  function getPaletteRows() {
    return Array.from(paletteList.querySelectorAll('.ws-palette__row'));
  }

  function syncPaletteSelection() {
    getPaletteRows().forEach((row, index) => {
      row.classList.toggle('is-selected', index === paletteSelectedIndex);
      if (index === paletteSelectedIndex) row.scrollIntoView({ block: 'nearest' });
    });
  }

  function openPalette() {
    palette.classList.add('is-open');
    paletteInput.value = '';
    renderPaletteRows('');
    paletteInput.focus();
  }

  function closePalette() {
    palette.classList.remove('is-open');
  }

  function focusFrame(frame, flash = false) {
    shell.querySelectorAll('.ws-frame').forEach((candidate) => candidate.classList.remove('is-active'));
    frame.el.classList.add('is-active');
    frame.el.style.zIndex = String(++zIndex);
    activePath = frame.key === 'chat' ? activePath : frame.key;
    if (frame.routeDef) activeRoute = frame.routeDef;
    if (flash) flashFrame(frame.el);
    syncDock(activePath);
    saveLayoutState();
  }

  function findTopOpenRouteFrame() {
    return Array.from(frames.values())
      .filter((frame) => frame.key !== 'chat' && !frame.el.hidden)
      .sort((a, b) => Number(b.el.style.zIndex || 0) - Number(a.el.style.zIndex || 0))[0] || null;
  }

  function flashFrame(frameEl) {
    frameEl.classList.remove('ws-frame-flash');
    void frameEl.offsetWidth;
    frameEl.classList.add('ws-frame-flash');
    window.setTimeout(() => frameEl.classList.remove('ws-frame-flash'), 520);
  }

  async function applyTarget(frame, target) {
    if (!target?.target) return;
    const targetText = target.target;
    if (!targetText) return;
    await delay(100);
    let found = findElementByText(frame.body, targetText);
    if (!found && target.label) {
      found = findElementByText(frame.body, target.label);
    }
    if (found) {
      found.scrollIntoView({ block: 'start', inline: 'nearest' });
      found.classList.add('ws-section-flash');
      window.setTimeout(() => found.classList.remove('ws-section-flash'), 1200);
    }
  }

  function constrainAllFrames() {
    const bounds = getStageBounds();
    for (const frame of frames.values()) {
      if (frame.el.hidden || frame.el.classList.contains('is-maximized')) continue;
      const rect = frame.el.getBoundingClientRect();
      frame.el.style.left = `${clamp(frame.el.offsetLeft, FRAME_VIEWPORT_MARGIN, Math.max(FRAME_VIEWPORT_MARGIN, bounds.width - rect.width - FRAME_VIEWPORT_MARGIN))}px`;
      frame.el.style.top = `${clamp(frame.el.offsetTop, 0, Math.max(0, bounds.height - rect.height - FRAME_VIEWPORT_MARGIN))}px`;
    }
    saveLayoutState();
  }

  function getStageBounds() {
    return {
      width: stage?.clientWidth || window.innerWidth,
      height: stage?.clientHeight || Math.max(MIN_FRAME_HEIGHT, window.innerHeight - 38),
    };
  }

  function saveLayoutState() {
    const state = {
      frames: { ...(frameState.frames || {}) },
      closed: { ...(frameState.closed || {}) },
    };
    for (const [key, frame] of frames.entries()) {
      state.frames[key] = snapshotFrame(frame, frame.el.hidden);
      state.closed[key] = frame.el.hidden;
    }
    Object.assign(frameState, state);
    writeLayoutState();
  }

  function persistFrameSnapshot(frame, closed = frame.el.hidden) {
    if (!frameState.frames) frameState.frames = {};
    if (!frameState.closed) frameState.closed = {};
    frameState.frames[frame.key] = snapshotFrame(frame, closed);
    frameState.closed[frame.key] = closed;
  }

  function writeLayoutState() {
    localStorage.setItem(WORKSTATION_LAYOUT_KEY, JSON.stringify({
      frames: frameState.frames || {},
      closed: frameState.closed || {},
    }));
  }

  function snapshotFrame(frame, closed = frame.el.hidden) {
    const maximized = frame.el.classList.contains('is-maximized');
    const rect = maximized && frameState.frames?.[frame.key]
      ? {
          left: frameState.frames[frame.key].left,
          top: frameState.frames[frame.key].top,
          width: frameState.frames[frame.key].width,
          height: frameState.frames[frame.key].height,
        }
      : getRect(frame.el);
    return {
      ...rect,
      z: Number(frame.el.style.zIndex || 0),
      closed,
      maximized,
      query: frame.params ? frame.params.toString() : '',
    };
  }

  function getSavedRect(key) {
    const saved = frameState.frames?.[key];
    if (!saved) return null;
    return {
      left: Number(saved.left) || 24,
      top: Number(saved.top) || 72,
      width: Number(saved.width) || 680,
      height: Number(saved.height) || 480,
    };
  }

  function startClock() {
    const tick = () => {
      const now = new Date();
      clockEl.textContent = now.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    };
    tick();
    window.setInterval(tick, 1000);
  }

  function observeConnection() {
    const source = document.getElementById('connection-indicator');
    if (!source) return;
    const sync = () => {
      statusEl.textContent = source.textContent || 'Disconnected';
      statusEl.style.color = source.classList.contains('connected') ? 'var(--success)' : 'var(--error)';
    };
    sync();
    new MutationObserver(sync).observe(source, { childList: true, attributes: true, subtree: true });
  }

  return {
    isActive: () => active,
    setActive,
    renderActiveRoute,
    refreshActiveRoute,
    restoreClassicChat: () => {
      if (!active && chatPanel.parentElement !== classicChatParent) classicChatParent.appendChild(chatPanel);
    },
  };
}

function loadLayoutState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKSTATION_LAYOUT_KEY) || '{}');
    return {
      frames: parsed && typeof parsed.frames === 'object' ? parsed.frames : {},
      closed: parsed && typeof parsed.closed === 'object' ? parsed.closed : {},
    };
  } catch {
    return { frames: {}, closed: {} };
  }
}

function getMeta(path, route) {
  return ROUTE_META[path] || {
    label: titleCase(route?.name || path.replace('/', '') || 'Second Brain'),
    icon: '<rect x="4" y="4" width="16" height="16"/>',
    sections: [],
  };
}

function defaultRouteRect(index = 0) {
  const width = Math.min(920, Math.max(620, Math.floor(window.innerWidth * 0.58)));
  const height = Math.min(680, Math.max(440, window.innerHeight - 190));
  const offset = Math.min(120, index * 28);
  return {
    left: 24 + offset,
    top: 64 + offset,
    width,
    height,
  };
}

function chatRect() {
  return {
    left: Math.max(24, window.innerWidth - 484),
    top: 72,
    width: 460,
    height: Math.max(430, window.innerHeight - 150),
  };
}

function setRect(el, rect) {
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.top}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

function getRect(el) {
  const rect = el.getBoundingClientRect();
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function hashFor(path, params) {
  const query = params?.toString?.() || '';
  return `#${path}${query ? `?${query}` : ''}`;
}

function findButtonByText(root, text) {
  return Array.from(root.querySelectorAll('button')).find((button) => normalize(button.textContent) === normalize(text));
}

function findElementByText(root, text) {
  const wanted = normalize(text);
  const candidates = root.querySelectorAll('h1,h2,h3,h4,.table-header,.cfg-item-title,.cfg-check-title,.panel__header,[data-tab-id],button');
  return Array.from(candidates).find((el) => normalize(el.textContent).includes(wanted));
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cssSlug(value) {
  return String(value || 'page').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
}

function titleCase(value) {
  return String(value)
    .split(/[-\s]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
