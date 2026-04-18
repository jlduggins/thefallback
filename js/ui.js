/**
 * The Fallback v2 - UI Module
 * Navigation, modals, toasts, and UI helpers
 */

const UI = {
  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  init() {
    // Navigation event listeners
    this.initNavigation();
    
    // Subscribe to state changes
    State.on('view:changed', ({ from, to }) => {
      this.showView(to);
      // Initialize mobile drawer snap behavior on every view change (in case drawers render late)
      setTimeout(() => this.initMobileDrawers(), 60);
      // Leaving Saved with a selected entry: deselect so the map isn't stuck zoomed in
      if (from === 'saved' && to !== 'saved' && State.selectedEntryId) {
        State.selectEntry(null);
        if (MapModule.map) setTimeout(() => MapModule.fitAllMarkers(), 80);
      }
    });
    State.on('auth:signed-in', user => this.handleSignIn(user));
    State.on('auth:signed-out', () => this.handleSignOut());
    State.on('auth:error', msg => this.showLoginError(msg));
    
    // Offline banner
    window.addEventListener('online', () => this.hideOfflineBanner());
    window.addEventListener('offline', () => this.showOfflineBanner());
    if (!navigator.onLine) this.showOfflineBanner();
    
    // Close modals on escape
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') this.closeAllModals();
    });
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // NAVIGATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  initNavigation() {
    // Bottom nav items
    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.addEventListener('click', () => {
        const view = item.dataset.view;
        State.setView(view);
      });
    });
    
    // Sidebar nav items (desktop)
    document.querySelectorAll('.sidebar-nav-item[data-view]').forEach(item => {
      item.addEventListener('click', () => {
        const view = item.dataset.view;
        State.setView(view);
      });
    });
    
    // Dynamic + button based on current view/context
    const addBtn = document.getElementById('nav-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const view = State.currentView;
        if (view === 'trips') {
          // If a journey detail is open, add a destination; otherwise new journey
          if (window.Trips?._defaultPanelContent && State.currentJourneyId) {
            Trips.openAddLegModal(State.currentJourneyId);
          } else if (window.Trips?.openNewJourneyModal) {
            Trips.openNewJourneyModal();
          } else {
            this.openAddModal();
          }
        } else {
          // Explore / Saved / elsewhere → add a location
          this.openAddModal();
        }
      });
    }
  },
  
  showView(viewName) {
    // Hide all views
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    
    // Show requested view
    const view = document.getElementById(`view-${viewName}`);
    if (view) {
      view.classList.add('active');
    }

    // Set body attribute so CSS can target view-specific map visibility
    document.body.setAttribute('data-view', viewName);
    
    // Update nav items
    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.classList.toggle('active', item.dataset.view === viewName);
    });
    document.querySelectorAll('.sidebar-nav-item[data-view]').forEach(item => {
      item.classList.toggle('active', item.dataset.view === viewName);
    });

    // Move #map between the global container and the explore preview container
    // so a single Leaflet instance can serve all three views.
    // On mobile (<768px), the explore pane hides the map entirely, so keep it in
    // the global container instead (user taps Map view to see it).
    const mapEl = document.getElementById('map');
    const exploreSlot = document.getElementById('explore-map-container');
    const globalSlot = document.getElementById('map-global');
    const isDesktop = window.matchMedia('(min-width: 768px)').matches;
    if (mapEl && globalSlot) {
      if (viewName === 'explore' && isDesktop && exploreSlot && mapEl.parentElement !== exploreSlot) {
        exploreSlot.appendChild(mapEl);
      } else if ((viewName !== 'explore' || !isDesktop) && mapEl.parentElement !== globalSlot) {
        globalSlot.insertBefore(mapEl, globalSlot.firstChild);
      }
    }

    // Invalidate map when the container size may have changed
    if (viewName === 'saved' || viewName === 'trips' || viewName === 'explore') {
      setTimeout(() => { if (MapModule.map) MapModule.map.invalidateSize(); }, 50);
    }

    // Entering Saved view: restore entry markers if a prior journey overlay wiped them,
    // and clear any lingering entry selection / zoom so the map shows all markers.
    if (viewName === 'saved' && MapModule.map) {
      MapModule.renderMarkers();
      if (State.selectedEntryId) State.selectEntry(null);
      setTimeout(() => MapModule.fitAllMarkers(), 80);
    }

    // Entering Explore: if a current journey is set, draw its route on the map
    if (viewName === 'explore' && MapModule.map && State.currentJourneyId && window.Trips) {
      setTimeout(() => Trips.viewJourneyOnMap(State.currentJourneyId, false), 100);
    }
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // AUTH UI
  // ═══════════════════════════════════════════════════════════════════════════
  
  handleSignIn(user) {
    // Hide loading and login screens
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('login-screen').classList.remove('visible');
    
    // Show app
    document.getElementById('app').classList.add('authenticated');
    
    // Update user info in settings
    this.updateUserInfo(user);
    
    // Show default view
    State.setView('explore');
    
    // Initialize map immediately so it's ready for saved + trips views
    if (!State.mapReady) {
      setTimeout(() => { MapModule.init('map'); MapModule.renderMarkers(); }, 50);
    }
    // Start location tracking
    MapModule.startWatchingLocation();
  },
  
  handleSignOut() {
    // Hide app
    document.getElementById('app').classList.remove('authenticated');
    
    // Show login screen
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('login-screen').classList.add('visible');
    
    // Stop location tracking
    MapModule.stopWatchingLocation();
  },
  
  updateUserInfo(user) {
    const avatar = document.getElementById('user-avatar');
    const name = document.getElementById('user-display-name');
    const email = document.getElementById('user-email');
    
    if (avatar) {
      avatar.textContent = (user.displayName || 'U')[0].toUpperCase();
    }
    if (name) {
      name.textContent = user.displayName || 'User';
    }
    if (email) {
      email.textContent = user.email || '';
    }
  },
  
  showLoginError(message) {
    const errorEl = document.querySelector('#login-screen .login-error');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = 'block';
    }
  },
  
  hideLoginError() {
    const errorEl = document.querySelector('#login-screen .login-error');
    if (errorEl) {
      errorEl.style.display = 'none';
    }
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // MODALS
  // ═══════════════════════════════════════════════════════════════════════════
  
  openModal(modalId) {
    const backdrop = document.getElementById('modal-backdrop');
    const modal = document.getElementById(modalId);
    
    if (backdrop) backdrop.classList.add('visible');
    if (modal) modal.classList.add('visible');
    
    // Prevent body scroll
    document.body.style.overflow = 'hidden';
  },
  
  closeModal(modalId) {
    const backdrop = document.getElementById('modal-backdrop');
    const modal = document.getElementById(modalId);
    
    if (modal) modal.classList.remove('visible');
    
    // Check if any modals are still open
    const openModals = document.querySelectorAll('.modal.visible');
    if (openModals.length === 0 && backdrop) {
      backdrop.classList.remove('visible');
      document.body.style.overflow = '';
    }
  },
  
  closeAllModals() {
    document.querySelectorAll('.modal.visible').forEach(modal => {
      modal.classList.remove('visible');
    });
    
    const backdrop = document.getElementById('modal-backdrop');
    if (backdrop) backdrop.classList.remove('visible');
    
    document.body.style.overflow = '';
  },
  
  openAddModal() {
    this.openModal('modal-add-location');
    
    // Reset form
    Entries.resetForm();
    
    // Show pin hint if we have user location
    if (State.userLat && State.userLng) {
      MapModule.showDragPin(State.userLat, State.userLng);
      State.pendingLat = State.userLat;
      State.pendingLng = State.userLng;
    }
  },
  
  closeAddModal() {
    this.closeModal('modal-add-location');
    MapModule.hideDragPin();
  },
  
  openDeleteConfirm(id, name) {
    State._deleteTargetId = id;
    
    const nameEl = document.getElementById('delete-location-name');
    if (nameEl) nameEl.textContent = name;
    
    this.openModal('modal-delete-confirm');
  },
  
  closeDeleteConfirm() {
    this.closeModal('modal-delete-confirm');
    State._deleteTargetId = null;
  },
  
  async confirmDelete() {
    const id = State._deleteTargetId;
    if (!id) return;
    
    try {
      await Firebase.deleteEntry(id);
      this.showToast('Location deleted', 'success');
      State.clearSelection();
    } catch (err) {
      this.showToast('Failed to delete', 'error');
    }
    
    this.closeDeleteConfirm();
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TOASTS
  // ═══════════════════════════════════════════════════════════════════════════
  
  showToast(message, type = 'default', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    
    container.appendChild(toast);
    
    // Auto remove
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // OFFLINE BANNER
  // ═══════════════════════════════════════════════════════════════════════════
  
  showOfflineBanner() {
    const banner = document.getElementById('offline-banner');
    if (banner) banner.style.display = 'block';
  },
  
  hideOfflineBanner() {
    const banner = document.getElementById('offline-banner');
    if (banner) banner.style.display = 'none';
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════
  
  $(selector) {
    return document.querySelector(selector);
  },
  
  $$(selector) {
    return document.querySelectorAll(selector);
  },
  
  show(el) {
    if (typeof el === 'string') el = this.$(el);
    if (el) el.style.display = '';
  },
  
  hide(el) {
    if (typeof el === 'string') el = this.$(el);
    if (el) el.style.display = 'none';
  },
  
  toggle(el, show) {
    if (typeof el === 'string') el = this.$(el);
    if (el) el.style.display = show ? '' : 'none';
  },
  
  // Format helpers
  formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  },
  
  formatDateShort(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // MOBILE DRAWER SNAP SYSTEM
  // Adds a grabber handle to each mobile drawer and supports drag-to-snap
  // between three positions: peek, half, full.
  // ═══════════════════════════════════════════════════════════════════════════

  _drawerIds: ['locations-panel', 'trips-list-panel', 'location-detail-panel', 'explore-backup-panel', 'explore-left-drawer'],

  _snapToHeight(snap) {
    const vh = window.innerHeight;
    if (snap === 'peek') return 92;
    if (snap === 'full') return Math.round(vh * 0.92);
    return Math.round(vh * 0.55);
  },

  _heightToSnap(h) {
    const vh = window.innerHeight;
    if (h < vh * 0.28) return 'peek';
    if (h < vh * 0.72) return 'half';
    return 'full';
  },

  _setDrawerHeightPx(px) {
    document.documentElement.style.setProperty('--drawer-height', px + 'px');
  },

  _applySnap(snap) {
    document.body.setAttribute('data-drawer-snap', snap);
    this._setDrawerHeightPx(this._snapToHeight(snap));
  },

  initMobileDrawers() {
    if (!window.matchMedia('(max-width: 767px)').matches) return;
    const exploreLeft = document.querySelector('#view-explore .explore-left');
    if (exploreLeft && !exploreLeft.id) exploreLeft.id = 'explore-left-drawer';

    this._drawerIds.forEach(id => {
      const panel = document.getElementById(id);
      if (!panel) return;
      if (panel.dataset.drawerInit) return;
      panel.dataset.drawerInit = '1';
      if (!panel.querySelector('.drawer-grabber')) {
        const grabber = document.createElement('div');
        grabber.className = 'drawer-grabber';
        panel.insertBefore(grabber, panel.firstChild);
        this._bindDrawerDrag(panel, grabber);
      }
    });
    // Every view entrance resets to half
    this._applySnap('half');
  },

  _bindDrawerDrag(panel, grabber) {
    let startY = 0, startH = 0, dragging = false, moved = false;
    const tray = () => document.getElementById('map-controls');

    const onMove = e => {
      if (!dragging) return;
      const y = (e.touches ? e.touches[0].clientY : e.clientY);
      const delta = startY - y;
      if (Math.abs(delta) > 3) moved = true;
      const newH = Math.max(60, Math.min(window.innerHeight * 0.95, startH + delta));
      // Update CSS var directly — drives drawer height AND tray offset smoothly
      this._setDrawerHeightPx(newH);
      if (e.cancelable) e.preventDefault();
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      panel.removeAttribute('data-dragging');
      const t = tray();
      if (t) t.removeAttribute('data-dragging');
      const currH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--drawer-height')) || this._snapToHeight('half');
      const snap = this._heightToSnap(currH);
      // Let CSS transition animate to the snap height
      this._applySnap(snap);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
    const onMoveBound = e => onMove.call(this, e);
    const onEndBound = () => onEnd.call(this);
    const onStart = e => {
      dragging = true;
      moved = false;
      startY = (e.touches ? e.touches[0].clientY : e.clientY);
      startH = panel.getBoundingClientRect().height;
      panel.setAttribute('data-dragging', '1');
      const t = tray();
      if (t) t.setAttribute('data-dragging', '1');
      document.addEventListener('mousemove', onMoveBound);
      document.addEventListener('mouseup', onEndBound);
      document.addEventListener('touchmove', onMoveBound, { passive: false });
      document.addEventListener('touchend', onEndBound);
      document.addEventListener('touchcancel', onEndBound);
    };
    grabber.addEventListener('mousedown', onStart);
    grabber.addEventListener('touchstart', onStart, { passive: true });
    // Tap (no drag) to cycle: peek → half → full → peek
    grabber.addEventListener('click', () => {
      if (moved) { moved = false; return; }
      const s = document.body.getAttribute('data-drawer-snap') || 'half';
      const next = s === 'peek' ? 'half' : s === 'half' ? 'full' : 'peek';
      this._applySnap(next);
    });
  }
};

// Export
window.UI = UI;
