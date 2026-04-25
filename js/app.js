/**
 * The Fallback v2 - App Module
 * Main initialization and orchestration
 */

const App = {
  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  init() {
    console.log('[App] Initializing The Fallback v2...');
    
    // Initialize modules in order
    Firebase.init();
    UI.init();
    Entries.init();
    Trips.init();
    if (window.Discover && Discover.init) Discover.init();
    
    // Register service worker
    this.registerServiceWorker();
    
    console.log('[App] Initialization complete');
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // SERVICE WORKER
  // ═══════════════════════════════════════════════════════════════════════════
  
  async registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      console.log('[App] Service workers not supported');
      return;
    }
    
    try {
      const registration = await navigator.serviceWorker.register('./sw.js');
      console.log('[App] Service worker registered:', registration.scope);
      
      // Check for updates
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New version available
            this.showUpdateNotification();
          }
        });
      });
    } catch (err) {
      console.error('[App] Service worker registration failed:', err);
    }
  },
  
  showUpdateNotification() {
    UI.showToast('Update available! Refresh to get the latest version.', 'info', 5000);
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // GLOBAL HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════
  
  handleSignIn() {
    Firebase.signInWithGoogle();
  },
  
  handleSignOut() {
    Firebase.signOut();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL FUNCTIONS (for onclick handlers in HTML)
// ═══════════════════════════════════════════════════════════════════════════

window.signIn = () => App.handleSignIn();
window.signOut = () => App.handleSignOut();

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}

// Export
window.App = App;
