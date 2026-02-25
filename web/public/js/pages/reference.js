/**
 * Reference Guide page.
 */

import { api } from '../api.js';

export async function renderReference(container) {
  container.innerHTML = '<h2 class="page-title">Reference Guide</h2><div class="loading">Loading...</div>';

  try {
    const guide = await api.reference();

    container.innerHTML = '<h2 class="page-title">Reference Guide</h2>';

    const intro = document.createElement('div');
    intro.className = 'guide-intro';
    intro.textContent = guide.intro || '';
    container.appendChild(intro);

    const grid = document.createElement('div');
    grid.className = 'guide-grid';

    for (const section of guide.sections || []) {
      const card = document.createElement('section');
      card.className = 'guide-card';

      const title = document.createElement('h3');
      title.textContent = section.title || 'Section';
      card.appendChild(title);

      const list = document.createElement('ul');
      for (const item of section.items || []) {
        const li = document.createElement('li');
        li.textContent = item;
        list.appendChild(li);
      }
      card.appendChild(list);

      grid.appendChild(card);
    }

    container.appendChild(grid);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    container.innerHTML = `<h2 class="page-title">Reference Guide</h2><div class="loading">Error: ${esc(message)}</div>`;
  }
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
