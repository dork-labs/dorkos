/**
 * Roadmap Visualization - Vanilla JavaScript
 * Loads roadmap.json and renders Kanban/List views
 */

(function() {
  'use strict';

  // State
  let roadmapData = null;
  let currentView = 'timeline'; // 'timeline', 'status', or 'priority'
  let filters = {
    type: '',
    moscow: '',
    status: '',
    hideCompleted: false
  };

  // DOM Elements
  const elements = {
    projectName: document.getElementById('project-name'),
    projectSummary: document.getElementById('project-summary'),
    lastUpdated: document.getElementById('last-updated'),
    themeToggle: document.getElementById('theme-toggle'),
    mustHavePercent: document.getElementById('must-have-percent'),
    mustHaveWarning: document.getElementById('must-have-warning'),
    totalItems: document.getElementById('total-items'),
    inProgressCount: document.getElementById('in-progress-count'),
    atRiskCount: document.getElementById('at-risk-count'),
    timelineView: document.getElementById('timeline-view'),
    statusView: document.getElementById('status-view'),
    priorityView: document.getElementById('priority-view'),
    timelineBtn: document.getElementById('timeline-btn'),
    statusBtn: document.getElementById('status-btn'),
    priorityBtn: document.getElementById('priority-btn'),
    filterType: document.getElementById('filter-type'),
    filterMoscow: document.getElementById('filter-moscow'),
    filterStatus: document.getElementById('filter-status'),
    hideCompleted: document.getElementById('hide-completed'),
    emptyState: document.getElementById('empty-state'),
    // Timeline view columns
    nowItems: document.getElementById('now-items'),
    nextItems: document.getElementById('next-items'),
    laterItems: document.getElementById('later-items'),
    // Status view columns
    notStartedItems: document.getElementById('not-started-items'),
    inProgressItems: document.getElementById('in-progress-items'),
    completedItems: document.getElementById('completed-items'),
    onHoldItems: document.getElementById('on-hold-items'),
    // completedColumn queried fresh in renderStatusView() for reliable access
    // Priority view containers
    mustHaveItems: document.getElementById('must-have-items'),
    shouldHaveItems: document.getElementById('should-have-items'),
    couldHaveItems: document.getElementById('could-have-items'),
    wontHaveItems: document.getElementById('wont-have-items'),
    // Modal elements
    modal: document.getElementById('item-modal'),
    modalBackdrop: document.querySelector('.modal-backdrop'),
    modalClose: document.getElementById('modal-close'),
    modalTitle: document.getElementById('modal-title'),
    modalStatusBadge: document.getElementById('modal-status-badge'),
    modalDescription: document.getElementById('modal-description'),
    modalMeta: document.getElementById('modal-meta'),
    modalLabels: document.getElementById('modal-labels'),
    modalSpecLinks: document.getElementById('modal-spec-links'),
    modalActions: document.getElementById('modal-actions'),
    modalDependenciesSection: document.getElementById('modal-dependencies-section'),
    modalDependencies: document.getElementById('modal-dependencies'),
    modalContextSection: document.getElementById('modal-context-section'),
    modalContext: document.getElementById('modal-context'),
    modalHealth: document.getElementById('modal-health'),
    modalHorizon: document.getElementById('modal-horizon'),
    modalCreated: document.getElementById('modal-created'),
    modalUpdated: document.getElementById('modal-updated'),
    modalId: document.getElementById('modal-id'),
    modalCopyId: document.getElementById('modal-copy-id'),
    modalIdeateBtn: document.getElementById('modal-ideate-btn'),
    refreshBtn: document.getElementById('refresh-btn'),
    // Markdown modal elements
    markdownModal: document.getElementById('markdown-modal'),
    markdownModalBackdrop: document.querySelector('#markdown-modal .modal-backdrop'),
    markdownModalClose: document.getElementById('markdown-modal-close'),
    markdownModalTitle: document.getElementById('markdown-modal-title'),
    markdownModalBody: document.getElementById('markdown-modal-body'),
    markdownTypeIcon: document.querySelector('.markdown-type-icon')
  };

  // Current modal item ID
  let currentModalItemId = null;

  // Auto-refresh interval (2 minutes)
  const AUTO_REFRESH_INTERVAL = 2 * 60 * 1000;
  let autoRefreshTimer = null;

  // Fetch roadmap data with cache-busting
  async function fetchRoadmapData() {
    // Add timestamp to prevent caching
    const cacheBuster = `?_=${Date.now()}`;
    const response = await fetch(`roadmap.json${cacheBuster}`, {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    if (!response.ok) throw new Error('Failed to load roadmap.json');
    return response.json();
  }

  // Refresh data and re-render
  async function refreshData(notify = false) {
    // Add loading state to refresh button
    if (elements.refreshBtn) {
      elements.refreshBtn.classList.add('loading');
      elements.refreshBtn.disabled = true;
    }

    try {
      roadmapData = await fetchRoadmapData();

      renderHeader();
      renderHealthDashboard();
      renderRoadmap();
      refreshIcons();

      // If modal is open, refresh its content
      if (currentModalItemId && !elements.modal.classList.contains('hidden')) {
        openModal(currentModalItemId);
      }

      if (notify) {
        showToast('Data refreshed!');
      }
    } catch (error) {
      console.error('Error refreshing roadmap:', error);
      if (notify) {
        showToast('Failed to refresh data');
      }
    } finally {
      // Remove loading state
      if (elements.refreshBtn) {
        elements.refreshBtn.classList.remove('loading');
        elements.refreshBtn.disabled = false;
      }
    }
  }

  // Start auto-refresh timer
  function startAutoRefresh() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
    }
    autoRefreshTimer = setInterval(() => refreshData(false), AUTO_REFRESH_INTERVAL);
  }

  // Initialize
  async function init() {
    // Initialize theme before rendering to prevent flash
    initTheme();
    // Initialize hide completed preference
    initHideCompleted();

    try {
      roadmapData = await fetchRoadmapData();

      renderHeader();
      renderHealthDashboard();
      renderRoadmap();
      setupEventListeners();
      refreshIcons();

      // Start auto-refresh
      startAutoRefresh();
    } catch (error) {
      console.error('Error loading roadmap:', error);
      elements.projectName.textContent = 'Error Loading Roadmap';
      elements.projectSummary.textContent = error.message;
    }
  }

  // Render header
  function renderHeader() {
    elements.projectName.textContent = roadmapData.projectName;
    elements.projectSummary.textContent = roadmapData.projectSummary;

    const date = new Date(roadmapData.lastUpdated);
    elements.lastUpdated.textContent = `Last updated: ${date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })}`;
  }

  // Render health dashboard
  function renderHealthDashboard() {
    const items = roadmapData.items;

    // Calculate Must-Have percentage
    const totalEffort = items.reduce((sum, item) => sum + (item.effort || 0), 0);
    const mustHaveEffort = items
      .filter(item => item.moscow === 'must-have')
      .reduce((sum, item) => sum + (item.effort || 0), 0);

    const mustHavePercent = totalEffort > 0
      ? Math.round((mustHaveEffort / totalEffort) * 100)
      : 0;

    elements.mustHavePercent.textContent = `${mustHavePercent}%`;

    // Show warning if > 60%
    if (mustHavePercent > 60) {
      elements.mustHaveWarning.classList.remove('hidden');
      elements.mustHavePercent.style.color = 'var(--destructive)';
    } else {
      elements.mustHaveWarning.classList.add('hidden');
      elements.mustHavePercent.style.color = '';
    }

    // Other stats
    elements.totalItems.textContent = items.length;
    elements.inProgressCount.textContent = items.filter(i => i.status === 'in-progress').length;
    elements.atRiskCount.textContent = items.filter(i =>
      i.health === 'at-risk' || i.health === 'off-track' || i.health === 'blocked'
    ).length;
  }

  // Get filtered items
  function getFilteredItems() {
    return roadmapData.items.filter(item => {
      if (filters.type && item.type !== filters.type) return false;
      if (filters.moscow && item.moscow !== filters.moscow) return false;
      if (filters.status && item.status !== filters.status) return false;
      if (filters.hideCompleted && item.status === 'completed') return false;
      return true;
    });
  }

  // Create item card HTML
  function createItemCard(item) {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.dataset.id = item.id;

    const hasDependencies = item.dependencies && item.dependencies.length > 0;

    card.innerHTML = `
      <div class="item-header">
        <span class="item-title">${escapeHtml(item.title)}</span>
        <div class="item-badges">
          <span class="badge status ${item.status}">${formatStatus(item.status)}</span>
        </div>
      </div>
      ${item.description ? `
        <div class="description-wrapper">
          <p class="item-description collapsed">${escapeHtml(item.description)}</p>
          <button class="description-toggle" onclick="event.stopPropagation(); toggleDescription(this)">Show more</button>
        </div>
      ` : ''}
      <div class="item-meta">
        <span class="badge moscow ${item.moscow}">${formatMoscow(item.moscow)}</span>
        <span class="badge type">${formatType(item.type)}</span>
        ${item.effort ? `<span class="meta-item">Effort: ${item.effort}</span>` : ''}
      </div>
      ${hasDependencies ? renderDependencyPills(item.dependencies) : ''}
      ${item.labels && item.labels.length > 0 ? `
        <div class="item-labels">
          ${item.labels.map(label => `<span class="label-tag">${escapeHtml(label)}</span>`).join('')}
        </div>
      ` : ''}
      ${renderSpecLinks(item)}
      <div class="item-actions">
        <button class="command-btn" onclick="copyIdeationCommand('${item.id}')" title="Copy ideation command to clipboard">
          <span class="command-text">/ideate</span>
          <i data-lucide="copy" class="icon"></i>
        </button>
      </div>
    `;

    return card;
  }

  // Render dependency pills with status dots
  function renderDependencyPills(dependencyIds) {
    const pills = dependencyIds.map(depId => {
      const depItem = roadmapData.items.find(i => i.id === depId);
      if (!depItem) return '';

      const title = depItem.title;
      const status = depItem.status;

      return `<span class="dependency-pill" title="${escapeHtml(title)} (${formatStatus(status)})">
        <span class="status-dot ${status}"></span>
        <span class="dependency-title">${escapeHtml(title)}</span>
      </span>`;
    }).filter(Boolean).join('');

    return pills ? `<div class="item-dependencies">${pills}</div>` : '';
  }

  // Render roadmap based on current view
  function renderRoadmap() {
    const filteredItems = getFilteredItems();

    // Show/hide empty state
    if (filteredItems.length === 0) {
      elements.emptyState.classList.remove('hidden');
    } else {
      elements.emptyState.classList.add('hidden');
    }

    if (currentView === 'timeline') {
      renderTimelineView(filteredItems);
    } else if (currentView === 'status') {
      renderStatusView(filteredItems);
    } else {
      renderPriorityView(filteredItems);
    }

    // Refresh icons after dynamic content render
    refreshIcons();

    // Check which descriptions need expand/collapse toggle
    // Use requestAnimationFrame to ensure DOM is fully rendered
    requestAnimationFrame(() => {
      checkDescriptionOverflows();
    });
  }

  // Render Timeline view (by time horizon)
  function renderTimelineView(items) {
    // Clear columns
    elements.nowItems.innerHTML = '';
    elements.nextItems.innerHTML = '';
    elements.laterItems.innerHTML = '';

    // Group by time horizon
    const grouped = {
      now: items.filter(i => i.timeHorizon === 'now'),
      next: items.filter(i => i.timeHorizon === 'next'),
      later: items.filter(i => i.timeHorizon === 'later')
    };

    // Render each group
    grouped.now.forEach(item => elements.nowItems.appendChild(createItemCard(item)));
    grouped.next.forEach(item => elements.nextItems.appendChild(createItemCard(item)));
    grouped.later.forEach(item => elements.laterItems.appendChild(createItemCard(item)));

    // Update column headers with counts
    document.querySelector('[data-horizon="now"] .column-header').textContent =
      `${roadmapData.timeHorizons.now.label} (${grouped.now.length})`;
    document.querySelector('[data-horizon="next"] .column-header').textContent =
      `${roadmapData.timeHorizons.next.label} (${grouped.next.length})`;
    document.querySelector('[data-horizon="later"] .column-header').textContent =
      `${roadmapData.timeHorizons.later.label} (${grouped.later.length})`;
  }

  // Render Status view (by status)
  function renderStatusView(items) {
    // Clear columns
    elements.notStartedItems.innerHTML = '';
    elements.inProgressItems.innerHTML = '';
    elements.completedItems.innerHTML = '';
    elements.onHoldItems.innerHTML = '';

    // Group by status
    const grouped = {
      'not-started': items.filter(i => i.status === 'not-started'),
      'in-progress': items.filter(i => i.status === 'in-progress'),
      'completed': items.filter(i => i.status === 'completed'),
      'on-hold': items.filter(i => i.status === 'on-hold')
    };

    // Render each group
    grouped['not-started'].forEach(item => elements.notStartedItems.appendChild(createItemCard(item)));
    grouped['in-progress'].forEach(item => elements.inProgressItems.appendChild(createItemCard(item)));
    grouped['completed'].forEach(item => elements.completedItems.appendChild(createItemCard(item)));
    grouped['on-hold'].forEach(item => elements.onHoldItems.appendChild(createItemCard(item)));

    // Update column headers with counts
    document.querySelector('[data-status="not-started"] .column-header').textContent =
      `Not Started (${grouped['not-started'].length})`;
    document.querySelector('[data-status="in-progress"] .column-header').textContent =
      `In Progress (${grouped['in-progress'].length})`;
    document.querySelector('[data-status="completed"] .column-header').textContent =
      `Completed (${grouped['completed'].length})`;
    document.querySelector('[data-status="on-hold"] .column-header').textContent =
      `On Hold (${grouped['on-hold'].length})`;

    // Hide/show completed column based on filter
    const completedColumn = document.querySelector('#status-view [data-status="completed"]');
    if (completedColumn) {
      if (filters.hideCompleted) {
        completedColumn.classList.add('hidden');
      } else {
        completedColumn.classList.remove('hidden');
      }
    }
  }

  // Render Priority view (by MoSCoW)
  function renderPriorityView(items) {
    // Clear groups
    elements.mustHaveItems.innerHTML = '';
    elements.shouldHaveItems.innerHTML = '';
    elements.couldHaveItems.innerHTML = '';
    elements.wontHaveItems.innerHTML = '';

    // Group by MoSCoW
    const grouped = {
      'must-have': items.filter(i => i.moscow === 'must-have'),
      'should-have': items.filter(i => i.moscow === 'should-have'),
      'could-have': items.filter(i => i.moscow === 'could-have'),
      'wont-have': items.filter(i => i.moscow === 'wont-have')
    };

    // Render each group
    grouped['must-have'].forEach(item => elements.mustHaveItems.appendChild(createItemCard(item)));
    grouped['should-have'].forEach(item => elements.shouldHaveItems.appendChild(createItemCard(item)));
    grouped['could-have'].forEach(item => elements.couldHaveItems.appendChild(createItemCard(item)));
    grouped['wont-have'].forEach(item => elements.wontHaveItems.appendChild(createItemCard(item)));
  }

  // Setup event listeners
  function setupEventListeners() {
    // View toggle
    elements.timelineBtn.addEventListener('click', () => {
      currentView = 'timeline';
      elements.timelineBtn.classList.add('active');
      elements.statusBtn.classList.remove('active');
      elements.priorityBtn.classList.remove('active');
      elements.timelineView.classList.remove('hidden');
      elements.statusView.classList.add('hidden');
      elements.priorityView.classList.add('hidden');
      renderRoadmap();
    });

    elements.statusBtn.addEventListener('click', () => {
      currentView = 'status';
      elements.statusBtn.classList.add('active');
      elements.timelineBtn.classList.remove('active');
      elements.priorityBtn.classList.remove('active');
      elements.statusView.classList.remove('hidden');
      elements.timelineView.classList.add('hidden');
      elements.priorityView.classList.add('hidden');
      renderRoadmap();
    });

    elements.priorityBtn.addEventListener('click', () => {
      currentView = 'priority';
      elements.priorityBtn.classList.add('active');
      elements.timelineBtn.classList.remove('active');
      elements.statusBtn.classList.remove('active');
      elements.priorityView.classList.remove('hidden');
      elements.timelineView.classList.add('hidden');
      elements.statusView.classList.add('hidden');
      renderRoadmap();
    });

    // Filters
    elements.filterType.addEventListener('change', (e) => {
      filters.type = e.target.value;
      renderRoadmap();
    });

    elements.filterMoscow.addEventListener('change', (e) => {
      filters.moscow = e.target.value;
      renderRoadmap();
    });

    elements.filterStatus.addEventListener('change', (e) => {
      filters.status = e.target.value;
      renderRoadmap();
    });

    // Hide completed toggle
    if (elements.hideCompleted) {
      elements.hideCompleted.addEventListener('change', (e) => {
        filters.hideCompleted = e.target.checked;
        localStorage.setItem('roadmap-hide-completed', e.target.checked);
        renderRoadmap();
      });
    }

    // Theme toggle
    elements.themeToggle.addEventListener('click', toggleTheme);

    // Refresh button
    if (elements.refreshBtn) {
      elements.refreshBtn.addEventListener('click', () => refreshData(true));
    }

    // Modal events
    elements.modalClose.addEventListener('click', closeModal);
    elements.modalBackdrop.addEventListener('click', closeModal);
    elements.modalCopyId.addEventListener('click', copyModalId);
    elements.modalIdeateBtn.addEventListener('click', () => {
      if (currentModalItemId) {
        copyIdeationCommand(currentModalItemId);
      }
    });

    // Close modals on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // Close markdown modal first if open (it's on top)
        if (!elements.markdownModal.classList.contains('hidden')) {
          closeMarkdownModal();
        } else if (!elements.modal.classList.contains('hidden')) {
          closeModal();
        }
      }
    });

    // Event delegation for card clicks
    document.addEventListener('click', (e) => {
      const card = e.target.closest('.item-card');
      if (card && !e.target.closest('.command-btn') && !e.target.closest('.spec-link')) {
        const itemId = card.dataset.id;
        if (itemId) {
          openModal(itemId);
        }
      }
    });

    // Markdown modal events
    if (elements.markdownModalClose) {
      elements.markdownModalClose.addEventListener('click', closeMarkdownModal);
    }
    if (elements.markdownModalBackdrop) {
      elements.markdownModalBackdrop.addEventListener('click', closeMarkdownModal);
    }

    // Event delegation for spec links (markdown files)
    document.addEventListener('click', (e) => {
      const specLink = e.target.closest('.spec-link');
      if (specLink) {
        const href = specLink.getAttribute('href');
        // Only intercept .md files
        if (href && href.endsWith('.md')) {
          e.preventDefault();
          openMarkdownModal(href);
        }
        // Let non-.md links open normally
      }
    });
  }

  // Generate ideation prompt command from roadmap item data
  function generateIdeationPrompt(item) {
    const parts = [item.title];

    if (item.description) {
      parts.push(item.description);
    }

    if (item.ideationContext) {
      const ctx = item.ideationContext;

      if (ctx.targetUsers?.length) {
        parts.push(`Target users: ${ctx.targetUsers.join(', ')}.`);
      }
      if (ctx.painPoints?.length) {
        parts.push(`Pain points: ${ctx.painPoints.join('; ')}.`);
      }
      if (ctx.successCriteria?.length) {
        parts.push(`Success criteria: ${ctx.successCriteria.join('; ')}.`);
      }
      if (ctx.constraints?.length) {
        parts.push(`Constraints: ${ctx.constraints.join('; ')}.`);
      }
    }

    return `/ideate --roadmap-id ${item.id} ${parts.join(' ')}`;
  }

  // Copy ideation command to clipboard
  async function copyIdeationCommand(itemId) {
    const item = roadmapData.items.find(i => i.id === itemId);
    if (!item) {
      console.error('Item not found:', itemId);
      return;
    }

    const command = generateIdeationPrompt(item);

    try {
      await navigator.clipboard.writeText(command);
      showToast('Copied to clipboard!');
    } catch {
      // Fallback for older browsers or non-secure contexts
      const textarea = document.createElement('textarea');
      textarea.value = command;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        showToast('Copied to clipboard!');
      } catch (e) {
        console.error('Copy failed:', e);
        showToast('Copy failed - please copy manually');
      }
      document.body.removeChild(textarea);
    }
  }

  // Show a toast notification
  function showToast(message, duration = 2000) {
    const toast = document.getElementById('toast');
    const messageEl = toast.querySelector('.toast-message');

    if (messageEl) {
      messageEl.textContent = message;
    }

    toast.classList.remove('hidden');

    setTimeout(() => {
      toast.classList.add('hidden');
    }, duration);
  }

  // Render spec links for a roadmap item
  function renderSpecLinks(item) {
    if (!item.linkedArtifacts) return '';

    const links = [];
    const artifacts = item.linkedArtifacts;

    // Use relative paths - served via HTTP server at same origin
    if (artifacts.ideationPath) {
      links.push(`<a href="../${artifacts.ideationPath}" class="spec-link" target="_blank"><i data-lucide="lightbulb" class="icon"></i> Ideation</a>`);
    }
    if (artifacts.specPath) {
      links.push(`<a href="../${artifacts.specPath}" class="spec-link" target="_blank"><i data-lucide="file-text" class="icon"></i> Spec</a>`);
    }
    if (artifacts.tasksPath) {
      links.push(`<a href="../${artifacts.tasksPath}" class="spec-link" target="_blank"><i data-lucide="list-checks" class="icon"></i> Tasks</a>`);
    }
    if (artifacts.implementationPath) {
      links.push(`<a href="../${artifacts.implementationPath}" class="spec-link" target="_blank"><i data-lucide="check-circle" class="icon"></i> Done</a>`);
    }

    // If no path links but specSlug exists, show it as a reference badge
    if (links.length === 0 && artifacts.specSlug) {
      return `<div class="spec-links"><span class="spec-slug-badge"><i data-lucide="bookmark" class="icon"></i> ${escapeHtml(artifacts.specSlug)}</span></div>`;
    }

    return links.length > 0
      ? `<div class="spec-links">${links.join('')}</div>`
      : '';
  }

  // Initialize Lucide icons
  function refreshIcons() {
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  }

  // Theme management
  function initTheme() {
    const saved = localStorage.getItem('roadmap-theme');
    if (saved) {
      document.documentElement.setAttribute('data-theme', saved);
    }
    // If no saved preference, let CSS media query handle it
  }

  // Hide completed preference
  function initHideCompleted() {
    const saved = localStorage.getItem('roadmap-hide-completed');
    if (saved === 'true') {
      filters.hideCompleted = true;
      if (elements.hideCompleted) {
        elements.hideCompleted.checked = true;
      }
    }
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    let newTheme;
    if (current === 'dark') {
      newTheme = 'light';
    } else if (current === 'light') {
      newTheme = 'dark';
    } else {
      // No explicit theme set, toggle from system preference
      newTheme = prefersDark ? 'light' : 'dark';
    }

    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('roadmap-theme', newTheme);
    refreshIcons();
  }

  // Open modal with item details
  function openModal(itemId) {
    const item = roadmapData.items.find(i => i.id === itemId);
    if (!item) return;

    currentModalItemId = itemId;

    // Card-style header: title + status badge
    elements.modalTitle.textContent = item.title;
    elements.modalStatusBadge.className = `badge status ${item.status}`;
    elements.modalStatusBadge.textContent = formatStatus(item.status);

    // Description
    elements.modalDescription.textContent = item.description || '';

    // Meta row (same as card): moscow badge, type badge, effort, dependencies indicator
    const hasDependencies = item.dependencies && item.dependencies.length > 0;
    elements.modalMeta.innerHTML = `
      <span class="badge moscow ${item.moscow}">${formatMoscow(item.moscow)}</span>
      <span class="badge type">${formatType(item.type)}</span>
      ${item.effort ? `<span class="meta-item">Effort: ${item.effort}</span>` : ''}
      ${hasDependencies ? `<span class="dependencies-indicator">Depends on ${item.dependencies.length} item(s)</span>` : ''}
    `;

    // Labels (same as card)
    if (item.labels && item.labels.length > 0) {
      elements.modalLabels.innerHTML = item.labels
        .map(label => `<span class="label-tag">${escapeHtml(label)}</span>`)
        .join('');
      elements.modalLabels.style.display = '';
    } else {
      elements.modalLabels.innerHTML = '';
      elements.modalLabels.style.display = 'none';
    }

    // Spec links (same as card)
    if (item.linkedArtifacts && Object.keys(item.linkedArtifacts).length > 0) {
      const artifacts = item.linkedArtifacts;
      const links = [];

      if (artifacts.ideationPath) {
        links.push(`<a href="../${artifacts.ideationPath}" class="spec-link" target="_blank"><i data-lucide="lightbulb" class="icon"></i> Ideation</a>`);
      }
      if (artifacts.specPath) {
        links.push(`<a href="../${artifacts.specPath}" class="spec-link" target="_blank"><i data-lucide="file-text" class="icon"></i> Spec</a>`);
      }
      if (artifacts.tasksPath) {
        links.push(`<a href="../${artifacts.tasksPath}" class="spec-link" target="_blank"><i data-lucide="list-checks" class="icon"></i> Tasks</a>`);
      }
      if (artifacts.implementationPath) {
        links.push(`<a href="../${artifacts.implementationPath}" class="spec-link" target="_blank"><i data-lucide="check-circle" class="icon"></i> Done</a>`);
      }

      // If no path links but specSlug exists, show it as a reference badge
      if (links.length === 0 && artifacts.specSlug) {
        elements.modalSpecLinks.innerHTML = `<span class="spec-slug-badge"><i data-lucide="bookmark" class="icon"></i> ${escapeHtml(artifacts.specSlug)}</span>`;
        elements.modalSpecLinks.style.display = '';
      } else if (links.length > 0) {
        elements.modalSpecLinks.innerHTML = links.join('');
        elements.modalSpecLinks.style.display = '';
      } else {
        elements.modalSpecLinks.innerHTML = '';
        elements.modalSpecLinks.style.display = 'none';
      }
    } else {
      elements.modalSpecLinks.innerHTML = '';
      elements.modalSpecLinks.style.display = 'none';
    }

    // Dependencies section (modal-only, clickable with status dots)
    if (hasDependencies) {
      elements.modalDependenciesSection.classList.remove('hidden');
      elements.modalDependencies.innerHTML = item.dependencies
        .map(depId => {
          const depItem = roadmapData.items.find(i => i.id === depId);
          const title = depItem ? depItem.title : depId;
          const status = depItem ? depItem.status : 'not-started';
          return `<li class="modal-dependency-pill" data-id="${depId}" title="${escapeHtml(title)} (${formatStatus(status)})">
            <span class="status-dot ${status}"></span>
            <span class="dependency-title">${escapeHtml(title)}</span>
          </li>`;
        })
        .join('');

      // Add click handlers to dependencies
      elements.modalDependencies.querySelectorAll('li').forEach(li => {
        li.addEventListener('click', () => {
          const depId = li.dataset.id;
          if (depId) {
            openModal(depId);
          }
        });
      });
    } else {
      elements.modalDependenciesSection.classList.add('hidden');
    }

    // Ideation context section (modal-only)
    if (item.ideationContext && Object.keys(item.ideationContext).length > 0) {
      elements.modalContextSection.classList.remove('hidden');
      const ctx = item.ideationContext;
      let html = '';

      if (ctx.targetUsers && ctx.targetUsers.length > 0) {
        html += `<div class="context-group">
          <h4>Target Users</h4>
          <ul>${ctx.targetUsers.map(u => `<li>${escapeHtml(u)}</li>`).join('')}</ul>
        </div>`;
      }
      if (ctx.painPoints && ctx.painPoints.length > 0) {
        html += `<div class="context-group">
          <h4>Pain Points</h4>
          <ul>${ctx.painPoints.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
        </div>`;
      }
      if (ctx.successCriteria && ctx.successCriteria.length > 0) {
        html += `<div class="context-group">
          <h4>Success Criteria</h4>
          <ul>${ctx.successCriteria.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
        </div>`;
      }
      if (ctx.constraints && ctx.constraints.length > 0) {
        html += `<div class="context-group">
          <h4>Constraints</h4>
          <ul>${ctx.constraints.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
        </div>`;
      }

      elements.modalContext.innerHTML = html;
    } else {
      elements.modalContextSection.classList.add('hidden');
    }

    // Metadata section (modal-only)
    elements.modalHealth.textContent = formatHealth(item.health);
    elements.modalHorizon.textContent = formatHorizon(item.timeHorizon);
    elements.modalCreated.textContent = formatDateTime(item.createdAt);
    elements.modalUpdated.textContent = formatDateTime(item.updatedAt);

    // Item ID
    elements.modalId.textContent = item.id;

    // Show modal
    elements.modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    // Refresh icons
    refreshIcons();
  }

  // Close modal
  function closeModal() {
    elements.modal.classList.add('hidden');
    document.body.style.overflow = '';
    currentModalItemId = null;
  }

  // Copy modal ID to clipboard
  async function copyModalId() {
    if (!currentModalItemId) return;

    try {
      await navigator.clipboard.writeText(currentModalItemId);
      showToast('ID copied to clipboard!');
    } catch (err) {
      console.error('Copy failed:', err);
    }
  }

  // Format helpers for modal
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function formatMoscowFull(moscow) {
    const map = {
      'must-have': 'Must Have',
      'should-have': 'Should Have',
      'could-have': 'Could Have',
      'wont-have': "Won't Have"
    };
    return map[moscow] || moscow;
  }

  function formatHealth(health) {
    const map = {
      'on-track': 'On Track',
      'at-risk': 'At Risk',
      'off-track': 'Off Track',
      'blocked': 'Blocked'
    };
    return map[health] || health || 'Unknown';
  }

  function formatHorizon(horizon) {
    if (!roadmapData || !roadmapData.timeHorizons) {
      return horizon;
    }
    const horizonData = roadmapData.timeHorizons[horizon];
    return horizonData ? horizonData.label : horizon;
  }

  function formatDateTime(isoString) {
    if (!isoString) return 'Unknown';
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // Toggle description expand/collapse
  function toggleDescription(button) {
    const wrapper = button.closest('.description-wrapper');
    const description = wrapper.querySelector('.item-description');

    if (description.classList.contains('collapsed')) {
      description.classList.remove('collapsed');
      description.classList.add('expanded');
      button.textContent = 'Show less';
    } else {
      description.classList.remove('expanded');
      description.classList.add('collapsed');
      button.textContent = 'Show more';
    }
  }

  // Check which descriptions overflow and show their toggle buttons
  function checkDescriptionOverflows() {
    const descriptions = document.querySelectorAll('.item-description.collapsed');

    descriptions.forEach(desc => {
      const wrapper = desc.closest('.description-wrapper');
      if (!wrapper) return;

      const toggle = wrapper.querySelector('.description-toggle');
      if (!toggle) return;

      // Check if content overflows (scrollHeight > clientHeight means truncated)
      if (desc.scrollHeight > desc.clientHeight) {
        toggle.classList.add('visible');
      } else {
        toggle.classList.remove('visible');
      }
    });
  }

  // Make functions available globally
  window.copyIdeationCommand = copyIdeationCommand;
  window.toggleDescription = toggleDescription;

  // Helper functions
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatMoscow(moscow) {
    const map = {
      'must-have': 'Must',
      'should-have': 'Should',
      'could-have': 'Could',
      'wont-have': "Won't"
    };
    return map[moscow] || moscow;
  }

  function formatType(type) {
    return type.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  function formatStatus(status) {
    const map = {
      'not-started': 'Not Started',
      'in-progress': 'In Progress',
      'completed': 'Completed',
      'on-hold': 'On Hold'
    };
    return map[status] || status;
  }

  // ==========================================================================
  // Markdown Modal Functions
  // ==========================================================================

  // Get icon name based on document type
  function getDocumentIcon(path) {
    if (path.includes('ideation') || path.includes('01-ideation')) {
      return 'lightbulb';
    } else if (path.includes('spec') || path.includes('02-spec')) {
      return 'file-text';
    } else if (path.includes('tasks') || path.includes('03-tasks')) {
      return 'list-checks';
    } else if (path.includes('done') || path.includes('04-done')) {
      return 'check-circle';
    }
    return 'file-text';
  }

  // Get document title from path
  function getDocumentTitle(path) {
    const filename = path.split('/').pop();
    // Remove file extension and format nicely
    const name = filename.replace(/\.md$/, '');

    // Map common names
    const titleMap = {
      '01-ideation': 'Ideation',
      '02-spec': 'Specification',
      '03-tasks': 'Tasks',
      '04-done': 'Implementation Complete'
    };

    return titleMap[name] || name.split('-').map(w =>
      w.charAt(0).toUpperCase() + w.slice(1)
    ).join(' ');
  }

  // Open markdown modal
  async function openMarkdownModal(url) {
    // Show modal with loading state
    elements.markdownModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    // Set title and icon based on URL
    const icon = getDocumentIcon(url);
    const title = getDocumentTitle(url);

    elements.markdownModalTitle.textContent = title;

    // Update icon
    if (elements.markdownTypeIcon) {
      elements.markdownTypeIcon.setAttribute('data-lucide', icon);
    }

    // Show loading
    elements.markdownModalBody.innerHTML = `
      <div class="markdown-loading">
        <i data-lucide="loader-2" class="icon spin"></i>
        <span>Loading...</span>
      </div>
    `;
    refreshIcons();

    try {
      // Fetch the markdown file
      const cacheBuster = `?_=${Date.now()}`;
      const response = await fetch(`${url}${cacheBuster}`, {
        cache: 'no-store'
      });

      if (!response.ok) {
        throw new Error(`Failed to load document (${response.status})`);
      }

      const markdown = await response.text();

      // Parse markdown to HTML using marked
      const html = marked.parse(markdown, {
        gfm: true,
        breaks: true
      });

      // Render the content
      elements.markdownModalBody.innerHTML = `<div class="markdown-content">${html}</div>`;

    } catch (error) {
      console.error('Error loading markdown:', error);
      elements.markdownModalBody.innerHTML = `
        <div class="markdown-error">
          <i data-lucide="alert-circle" class="icon"></i>
          <p>Failed to load document</p>
          <p style="font-size: 0.875rem; color: var(--muted-foreground);">${escapeHtml(error.message)}</p>
        </div>
      `;
    }

    refreshIcons();
  }

  // Close markdown modal
  function closeMarkdownModal() {
    elements.markdownModal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
