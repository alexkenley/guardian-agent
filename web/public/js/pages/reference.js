/**
 * Reference Guide page.
 */

import { api } from '../api.js';

const MAX_SEARCH_RESULTS = 8;

export async function renderReference(container) {
  container.innerHTML = '<h2 class="page-title">Reference Guide</h2><div class="loading">Loading...</div>';

  try {
    const guide = prepareGuide(apiReferenceToGuide(await api.reference()));
    const pages = guide.categories.flatMap((category) => category.pages);

    container.innerHTML = '<h2 class="page-title">Reference Guide</h2>';
    container.insertAdjacentHTML('beforeend', `
      <section class="guide-hero">
        <div>
          <div class="guide-kicker">Operator Wiki</div>
          <h3>${esc(guide.title || 'Reference Guide')}</h3>
          <p>${esc(guide.intro || '')}</p>
        </div>
        <div class="guide-hero-stats">
          <div class="guide-stat">
            <span class="guide-stat-value">${guide.categories.length}</span>
            <span class="guide-stat-label">Categories</span>
          </div>
          <div class="guide-stat">
            <span class="guide-stat-value">${pages.length}</span>
            <span class="guide-stat-label">Guides</span>
          </div>
        </div>
      </section>
      <div class="guide-wiki">
        <aside class="guide-sidebar">
          <div class="guide-sidebar-inner">
            <div class="guide-sidebar-top">
              <div class="guide-sidebar-title">Browse Guides</div>
              <div class="guide-search">
                <label class="guide-search__label" for="guide-search-input">Find a section</label>
                <input
                  id="guide-search-input"
                  class="guide-search__input"
                  data-guide-search-input
                  type="search"
                  placeholder="Search Second Brain, approvals, coding sessions..."
                  autocomplete="off"
                  spellcheck="false"
                >
                <div class="guide-search-results" data-guide-search-results hidden></div>
              </div>
            </div>
            <div class="guide-sidebar-scroll">
              ${(guide.categories || []).map((category) => `
                <section class="guide-nav-category">
                  <div class="guide-nav-heading">${esc(category.title)}</div>
                  <div class="guide-nav-description">${esc(category.description || '')}</div>
                  <nav class="guide-nav-links">
                    ${(category.pages || []).map((page) => `
                      <a class="guide-nav-link" href="#/reference" data-guide-link-target="${escAttr(page.articleId)}">
                        <span class="guide-nav-link-title">${esc(page.title)}</span>
                        <span class="guide-nav-link-summary">${esc(page.summary || '')}</span>
                      </a>
                    `).join('')}
                  </nav>
                </section>
              `).join('')}
            </div>
          </div>
        </aside>
        <main class="guide-content">
          ${(guide.categories || []).map((category) => `
            <section class="guide-category-block">
              <div class="guide-category-header">
                <div class="guide-category-kicker">Category</div>
                <h3>${esc(category.title)}</h3>
                <p>${esc(category.description || '')}</p>
              </div>
              ${(category.pages || []).map((page) => `
                <article class="guide-article" id="${escAttr(page.articleId)}" data-guide-article="${escAttr(page.articleId)}">
                  <header class="guide-article-header">
                    <h4>${esc(page.title)}</h4>
                    <p class="guide-page-summary">${esc(page.summary || '')}</p>
                  </header>
                  ${(page.sections || []).map((section) => `
                    <section
                      class="guide-section"
                      id="${escAttr(section.anchorId)}"
                      data-guide-section="${escAttr(section.anchorId)}"
                      data-guide-article-owner="${escAttr(page.articleId)}"
                    >
                      <h5>${esc(section.title)}</h5>
                      <ul>
                        ${(section.items || []).map((item) => `<li>${esc(item)}</li>`).join('')}
                      </ul>
                      ${section.note ? `<div class="guide-note">${esc(section.note)}</div>` : ''}
                    </section>
                  `).join('')}
                </article>
              `).join('')}
            </section>
          `).join('')}
        </main>
      </div>
    `);

    wireGuideInteractions(container, guide);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    container.innerHTML = `<h2 class="page-title">Reference Guide</h2><div class="loading">Error: ${esc(message)}</div>`;
  }
}

function apiReferenceToGuide(guide) {
  return {
    title: guide?.title || 'Reference Guide',
    intro: guide?.intro || '',
    categories: Array.isArray(guide?.categories) ? guide.categories : [],
  };
}

function prepareGuide(guide) {
  const categories = guide.categories.map((category, categoryIndex) => {
    const pages = (category.pages || []).map((page, pageIndex) => {
      const articleId = `guide-${page.id || `page-${categoryIndex + 1}-${pageIndex + 1}`}`;
      const sections = (page.sections || []).map((section, sectionIndex) => ({
        ...section,
        anchorId: `${articleId}-section-${sectionIndex + 1}-${slugify(section.title || `section-${sectionIndex + 1}`)}`,
      }));
      return {
        ...page,
        articleId,
        sections,
      };
    });
    return {
      ...category,
      pages,
    };
  });

  const searchEntries = categories.flatMap((category) => category.pages.flatMap((page) => (
    page.sections.map((section) => {
      const bodyText = [
        section.title,
        page.title,
        page.summary,
        category.title,
        category.description,
        ...(section.items || []),
        section.note || '',
      ].filter(Boolean).join(' ');
      return {
        articleId: page.articleId,
        targetId: section.anchorId,
        categoryTitle: category.title,
        categoryText: normalizeSearchText(category.title),
        pageTitle: page.title,
        pageTitleText: normalizeSearchText(page.title),
        pageSummary: page.summary || '',
        pageSummaryText: normalizeSearchText(page.summary || ''),
        sectionTitle: section.title,
        sectionTitleText: normalizeSearchText(section.title),
        snippetSources: [
          ...(section.items || []),
          section.note || '',
          page.summary || '',
          category.description || '',
        ].filter(Boolean),
        bodyText: normalizeSearchText(bodyText),
      };
    })
  )));

  return {
    ...guide,
    categories,
    searchEntries,
  };
}

function wireGuideInteractions(container, guide) {
  const navLinks = Array.from(container.querySelectorAll('[data-guide-link-target]'));
  const articles = Array.from(container.querySelectorAll('[data-guide-article]'));
  const searchInput = container.querySelector('[data-guide-search-input]');
  const searchResults = container.querySelector('[data-guide-search-results]');
  let focusTimer = null;

  if (navLinks.length === 0 || articles.length === 0) {
    return;
  }

  const clearFocusHighlight = () => {
    container.querySelectorAll('.guide-section.is-focus-target').forEach((node) => node.classList.remove('is-focus-target'));
    container.querySelectorAll('.guide-article.is-focus-article').forEach((node) => node.classList.remove('is-focus-article'));
  };

  const setActiveLink = (targetId) => {
    navLinks.forEach((link) => {
      link.classList.toggle('active', link.getAttribute('data-guide-link-target') === targetId);
    });
  };

  const focusTarget = (target) => {
    clearFocusHighlight();
    const article = target.closest('[data-guide-article]');
    if (target.matches('.guide-section')) {
      target.classList.add('is-focus-target');
    }
    article?.classList.add('is-focus-article');
    if (focusTimer) {
      window.clearTimeout(focusTimer);
    }
    focusTimer = window.setTimeout(() => {
      clearFocusHighlight();
    }, 2400);
  };

  const scrollToTarget = (targetId, articleId) => {
    const target = targetId ? container.querySelector(`#${cssEscape(targetId)}`) : null;
    if (!target) return;
    setActiveLink(articleId);
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    focusTarget(target);
  };

  navLinks.forEach((link) => {
    link.addEventListener('click', (event) => {
      const articleId = link.getAttribute('data-guide-link-target');
      if (!articleId) return;
      event.preventDefault();
      scrollToTarget(articleId, articleId);
    });
  });

  setActiveLink(articles[0].id);

  if (searchInput instanceof HTMLInputElement && searchResults instanceof HTMLElement) {
    const hideSearchResults = () => {
      searchResults.hidden = true;
      searchResults.innerHTML = '';
    };

    const renderSearchResults = () => {
      const query = searchInput.value.trim();
      if (!query) {
        hideSearchResults();
        return;
      }

      const results = searchGuideEntries(guide.searchEntries, query);
      if (results.length === 0) {
        searchResults.hidden = false;
        searchResults.innerHTML = '<div class="guide-search-empty">No matching sections.</div>';
        return;
      }

      searchResults.hidden = false;
      searchResults.innerHTML = `
        <div class="guide-search-results__title">Matching sections</div>
        ${results.map((result) => `
          <button
            class="guide-search-result"
            type="button"
            data-guide-search-target="${escAttr(result.targetId)}"
            data-guide-search-article="${escAttr(result.articleId)}"
            data-guide-search-label="${escAttr(`${result.pageTitle} / ${result.sectionTitle}`)}"
          >
            <span class="guide-search-result__eyebrow">${esc(`${result.categoryTitle} · ${result.pageTitle}`)}</span>
            <strong>${esc(result.sectionTitle)}</strong>
            <span>${esc(result.snippet)}</span>
          </button>
        `).join('')}
      `;
    };

    searchInput.addEventListener('input', () => {
      renderSearchResults();
    });

    searchInput.addEventListener('focus', () => {
      if (searchInput.value.trim()) {
        renderSearchResults();
      }
    });

    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        searchInput.value = '';
        hideSearchResults();
        return;
      }
      if (event.key !== 'Enter') return;
      const firstResult = searchResults.querySelector('[data-guide-search-target]');
      if (!(firstResult instanceof HTMLElement)) return;
      event.preventDefault();
      firstResult.click();
    });

    searchResults.addEventListener('click', (event) => {
      const button = event.target.closest('[data-guide-search-target]');
      if (!(button instanceof HTMLElement)) return;
      const targetId = button.getAttribute('data-guide-search-target');
      const articleId = button.getAttribute('data-guide-search-article');
      if (!targetId || !articleId) return;
      searchInput.value = button.getAttribute('data-guide-search-label') || searchInput.value;
      hideSearchResults();
      scrollToTarget(targetId, articleId);
    });
  }

  if (typeof IntersectionObserver !== 'undefined') {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      if (visible?.target?.id) {
        setActiveLink(visible.target.id);
      }
    }, {
      root: null,
      rootMargin: '-20% 0px -55% 0px',
      threshold: [0.1, 0.35, 0.6],
    });

    articles.forEach((article) => observer.observe(article));
  }
}

function searchGuideEntries(entries, query) {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];
  const terms = normalized.split(' ').filter(Boolean);

  return entries
    .map((entry) => {
      const score = scoreSearchEntry(entry, normalized, terms);
      if (score <= 0) return null;
      return {
        ...entry,
        score,
        snippet: pickSearchSnippet(entry, normalized, terms),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.pageTitle.localeCompare(right.pageTitle))
    .slice(0, MAX_SEARCH_RESULTS);
}

function scoreSearchEntry(entry, normalizedQuery, terms) {
  if (!terms.every((term) => entry.bodyText.includes(term))) {
    return 0;
  }

  let score = 0;
  if (entry.sectionTitleText.startsWith(normalizedQuery)) score += 140;
  if (entry.sectionTitleText.includes(normalizedQuery)) score += 90;
  if (entry.pageTitleText.includes(normalizedQuery)) score += 50;
  if (entry.pageSummaryText.includes(normalizedQuery)) score += 30;
  if (entry.categoryText.includes(normalizedQuery)) score += 18;

  for (const term of terms) {
    if (entry.sectionTitleText.includes(term)) score += 30;
    if (entry.pageTitleText.includes(term)) score += 18;
    if (entry.pageSummaryText.includes(term)) score += 10;
    if (entry.categoryText.includes(term)) score += 6;
    if (entry.bodyText.includes(term)) score += 3;
  }

  return score;
}

function pickSearchSnippet(entry, normalizedQuery, terms) {
  const match = entry.snippetSources.find((source) => {
    const normalizedSource = normalizeSearchText(source);
    return normalizedSource.includes(normalizedQuery) || terms.every((term) => normalizedSource.includes(term));
  });
  return summarize(match || entry.pageSummary || entry.sectionTitle, 150);
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section';
}

function summarize(value, maxLength) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function escAttr(str) {
  return esc(str).replace(/"/g, '&quot;');
}

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
