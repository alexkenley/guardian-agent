/**
 * Reusable tab component.
 *
 * createTabs(container, tabs, defaultTab?)
 *   tabs: [{ id, label, render(panel) }]
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
  });

  // Activate default tab
  switchTo(defaultTab || tabs[0]?.id);

  return { switchTo };
}
