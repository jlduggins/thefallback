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
    State.on('view:changed', ({ to }) => this.showView(to));
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
    
    // Add button
    const addBtn = document.getElementById('nav-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', () => this.openAddModal());
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
    
    // Update nav items
    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.classList.toggle('active', item.dataset.view === viewName);
    });
    document.querySelectorAll('.sidebar-nav-item[data-view]').forEach(item => {
      item.classList.toggle('active', item.dataset.view === viewName);
    });
    
    // Initialize map if showing saved view
    if (viewName === 'saved' && !State.mapReady) {
      setTimeout(() => MapModule.init('map'), 100);
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
  }
};

// Export
window.UI = UI;
