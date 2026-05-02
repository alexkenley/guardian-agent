/**
 * Reusable tab component.
 *
 * createTabs(container, tabs, defaultTab?)
 *   tabs: [{ id, label, render(panel), tooltip? }]
 *   Returns { switchTo(tabId) }
 *
 * Renders lazily — tab content is only rendered on first switch.
 */

export function createTabs(container, tabs, defaultTab) {
  const bar = document.createElement('div');
  bar.className = 'tab-bar';

  const panels = {};
  const rendered = {};
  const buttons = {};

  for (const tab of tabs) {
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.textContent = tab.label;
    btn.dataset.tabId = tab.id;
    if (tab.tooltip) {
      btn.title = tab.tooltip;
      btn.setAttribute('aria-label', `${tab.label}: ${tab.tooltip}`);
    }
    buttons[tab.id] = btn;
    bar.appendChild(btn);

    const panel = document.createElement('div');
    panel.className = 'tab-panel';
    panel.style.display = 'none';
    panels[tab.id] = panel;
  }

  container.appendChild(bar);
  for (const tab of tabs) {
    container.appendChild(panels[tab.id]);
  }

  function switchTo(tabId) {
    container.dataset.activeTab = tabId;
    for (const t of tabs) {
      const isActive = t.id === tabId;
      buttons[t.id].classList.toggle('active', isActive);
      panels[t.id].style.display = isActive ? '' : 'none';
    }

    // Lazy render on first switch
    if (!rendered[tabId]) {
      rendered[tabId] = true;
      const tab = tabs.find(t => t.id === tabId);
      if (tab) tab.render(panels[tabId]);
    }
  }

  // Click handler
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    switchTo(btn.dataset.tabId);
    keepTabBarVisible(container, bar);
  });

  // Activate default tab
  switchTo(defaultTab || tabs[0]?.id);

  return { switchTo };
}

function keepTabBarVisible(container, bar) {
  requestAnimationFrame(() => {
    if (!container?.isConnected || !bar?.isConnected) return;
    const scrollParent = findScrollParent(container);
    if (!scrollParent) return;

    if (scrollParent === document.documentElement || scrollParent === document.body) {
      bar.scrollIntoView({ block: 'start', inline: 'nearest' });
      return;
    }

    const parentRect = scrollParent.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    if (barRect.top < parentRect.top || barRect.top > parentRect.top + 8) {
      scrollParent.scrollTop += barRect.top - parentRect.top;
    }
  });
}

function findScrollParent(element) {
  let node = element.parentElement;
  while (node) {
    const style = window.getComputedStyle(node);
    if (/(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`) && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}
