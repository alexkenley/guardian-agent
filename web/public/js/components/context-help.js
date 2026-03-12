function esc(value) {
  const element = document.createElement('div');
  element.textContent = value == null ? '' : String(value);
  return element.innerHTML;
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildHelpPayload(title, help = {}) {
  return {
    title: normalizeText(help.title || title || 'About this section'),
    whatItIs: normalizeText(help.whatItIs || ''),
    whatSeeing: normalizeText(help.whatSeeing || ''),
    whatCanDo: normalizeText(help.whatCanDo || ''),
    howLinks: normalizeText(help.howLinks || ''),
    whenToUse: normalizeText(help.whenToUse || ''),
    whereNext: normalizeText(help.whereNext || ''),
  };
}

function buildNativeTooltip(payload) {
  return [
    payload.title,
    payload.whatItIs ? `What it is: ${payload.whatItIs}` : '',
    payload.whatSeeing ? `What you're seeing: ${payload.whatSeeing}` : '',
    payload.whatCanDo ? `What you can do: ${payload.whatCanDo}` : '',
    payload.howLinks ? `How it links: ${payload.howLinks}` : '',
    payload.whenToUse ? `When to use it: ${payload.whenToUse}` : '',
    payload.whereNext ? `Where to go next: ${payload.whereNext}` : '',
  ].filter(Boolean).join('\n');
}

export function renderGuidancePanel({
  kicker = 'Guide',
  title = '',
  compact = false,
  whatItIs = '',
  whatSeeing = '',
  whatCanDo = '',
  howLinks = '',
  extras = [],
} = {}) {
  const items = [
    { label: 'What it is', text: whatItIs },
    { label: 'What you are seeing', text: whatSeeing },
    { label: 'What you can do', text: whatCanDo },
    { label: 'How it links', text: howLinks },
    ...extras.filter((item) => item?.label && item?.text),
  ].filter((item) => item.text);

  return `
    <section class="context-panel${compact ? ' compact' : ''}">
      <div class="context-kicker">${esc(kicker)}</div>
      ${title ? `<h3 class="context-title">${esc(title)}</h3>` : ''}
      <div class="context-grid">
        ${items.map((item) => `
          <div class="context-item">
            <div class="context-label">${esc(item.label)}</div>
            <div class="context-copy">${esc(item.text)}</div>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

export function renderInfoButton(title, help = {}) {
  const payload = buildHelpPayload(title, help);
  const tooltipText = buildNativeTooltip(payload);
  return `
    <button
      type="button"
      class="section-info-button"
      aria-label="${escAttr(`About ${payload.title}`)}"
      title="${escAttr(tooltipText)}"
      data-help-title="${escAttr(payload.title)}"
      data-help-what="${escAttr(payload.whatItIs)}"
      data-help-seeing="${escAttr(payload.whatSeeing)}"
      data-help-can-do="${escAttr(payload.whatCanDo)}"
      data-help-links="${escAttr(payload.howLinks)}"
      data-help-when="${escAttr(payload.whenToUse)}"
      data-help-next="${escAttr(payload.whereNext)}"
    >i</button>
  `;
}

export function enhanceSectionHelp(root, helpMap = {}, fallbackFactory = null) {
  if (!root) return;

  root.querySelectorAll('.table-header > h3, .section-header').forEach((header) => {
    if (!(header instanceof HTMLElement)) return;
    if (header.parentElement?.classList.contains('section-heading')) return;

    const title = normalizeText(header.textContent);
    if (!title) return;

    const help = helpMap[title] || (typeof fallbackFactory === 'function' ? fallbackFactory(title) : null);
    if (!help) return;

    const wrapper = document.createElement('div');
    wrapper.className = `section-heading${header.classList.contains('section-header') ? ' standalone' : ''}`;

    const buttonHost = document.createElement('div');
    buttonHost.innerHTML = renderInfoButton(title, help);
    const button = buttonHost.firstElementChild;
    if (!button) return;

    const parent = header.parentElement;
    if (!parent) return;

    if (parent.classList.contains('table-header')) {
      parent.insertBefore(wrapper, header);
      wrapper.appendChild(header);
      wrapper.appendChild(button);
      return;
    }

    parent.replaceChild(wrapper, header);
    wrapper.appendChild(header);
    wrapper.appendChild(button);
  });

  activateContextHelp(root);
}

export function activateContextHelp(root = document) {
  root.querySelectorAll('.section-info-button').forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) return;
    if (button.dataset.helpBound === 'true') return;
    button.dataset.helpBound = 'true';

    button.addEventListener('mouseenter', () => showTooltip(button));
    button.addEventListener('focus', () => showTooltip(button));
    button.addEventListener('mouseleave', () => hideTooltip(button));
    button.addEventListener('blur', () => hideTooltip(button));
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideTooltip(button);
        button.blur();
      }
    });
  });
}

function ensureTooltip() {
  let tooltip = document.querySelector('.context-help-tooltip');
  if (tooltip) return tooltip;

  tooltip = document.createElement('div');
  tooltip.className = 'context-help-tooltip';
  tooltip.hidden = true;
  document.body.appendChild(tooltip);
  return tooltip;
}

function showTooltip(button) {
  const tooltip = ensureTooltip();
  const payload = {
    title: button.dataset.helpTitle || 'About this section',
    whatItIs: button.dataset.helpWhat || '',
    whatSeeing: button.dataset.helpSeeing || '',
    whatCanDo: button.dataset.helpCanDo || '',
    howLinks: button.dataset.helpLinks || '',
    whenToUse: button.dataset.helpWhen || '',
    whereNext: button.dataset.helpNext || '',
  };

  const rows = [
    ['What it is', payload.whatItIs],
    ['What you are seeing', payload.whatSeeing],
    ['What you can do', payload.whatCanDo],
    ['How it links', payload.howLinks],
    ['When to use it', payload.whenToUse],
    ['Where to go next', payload.whereNext],
  ].filter(([, value]) => value);

  tooltip.innerHTML = `
    <div class="context-help-tooltip-title">${esc(payload.title)}</div>
    ${rows.map(([label, value]) => `
      <div class="context-help-tooltip-row">
        <div class="context-help-tooltip-label">${esc(label)}</div>
        <div class="context-help-tooltip-copy">${esc(value)}</div>
      </div>
    `).join('')}
  `;
  tooltip.hidden = false;
  tooltip.dataset.openFor = button.dataset.helpTitle || '';

  positionTooltip(button, tooltip);
}

function hideTooltip(button) {
  const tooltip = document.querySelector('.context-help-tooltip');
  if (!tooltip) return;
  if (button && tooltip.dataset.openFor && tooltip.dataset.openFor !== (button.dataset.helpTitle || '')) return;
  tooltip.hidden = true;
  tooltip.dataset.openFor = '';
}

function positionTooltip(button, tooltip) {
  const rect = button.getBoundingClientRect();
  const padding = 12;

  tooltip.style.left = '0px';
  tooltip.style.top = '0px';

  const tooltipRect = tooltip.getBoundingClientRect();
  let left = rect.left + window.scrollX - tooltipRect.width + rect.width;
  let top = rect.bottom + window.scrollY + 10;

  if (left < window.scrollX + padding) {
    left = window.scrollX + padding;
  }

  const maxLeft = window.scrollX + window.innerWidth - tooltipRect.width - padding;
  if (left > maxLeft) {
    left = maxLeft;
  }

  const maxTop = window.scrollY + window.innerHeight - tooltipRect.height - padding;
  if (top > maxTop) {
    top = rect.top + window.scrollY - tooltipRect.height - 10;
  }

  tooltip.style.left = `${Math.max(window.scrollX + padding, left)}px`;
  tooltip.style.top = `${Math.max(window.scrollY + padding, top)}px`;
}
