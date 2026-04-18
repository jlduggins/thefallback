/**
 * The Fallback v2 - State Management
 * Centralized app state and event system
 */

const State = {
  // ═══════════════════════════════════════════════════════════════════════════
  // DATA
  // ═══════════════════════════════════════════════════════════════════════════
  
  entries: [],
  journeys: [],
  
  // ═══════════════════════════════════════════════════════════════════════════
  // UI STATE
  // ═══════════════════════════════════════════════════════════════════════════
  
  currentView: 'explore', // explore, saved, trips, settings
  selectedEntryId: null,
  editingEntryId: null,
  activeJourneyId: null,
  currentJourneyId: null, // The user's designated "current" journey
  
  // Form state
  pendingLat: null,
  pendingLng: null,
  pendingPhotos: [],
  currentRating: 0,
  
  // Map state
  mapReady: false,
  isSatellite: false,
  showPublicLands: false,
  
  // User location
  userLat: null,
  userLng: null,
  watchId: null,
  
  // ═══════════════════════════════════════════════════════════════════════════
  // USER PREFERENCES
  // ═══════════════════════════════════════════════════════════════════════════
  
  fuelSettings: {
    fuelType: 'Diesel',
    mpg: 18,
    pricePerGal: 3.89,
    priceUnit: 'gal',
    backupRadius: 30
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // CONSTANTS
  // ═══════════════════════════════════════════════════════════════════════════
  
  STATUS_LABELS: {
    visited: 'Visited',
    planned: 'Planned',
    saved: 'Saved for Later'
  },
  
  AMENITY_MAP: {
    'a-water': 'hasPotableWater',
    'a-dump': 'hasDumpStation',
    'a-hookups': 'hasHookups',
    'a-trash': 'hasTrash',
    'a-fill': 'hasWaterFill',
    'a-seasonal': 'isSeasonal',
    'a-pets': 'hasPets',
    'a-4x4': 'needs4x4',
    'a-reservations': 'needsReservations'
  },
  
  AMENITY_META: [
    { id: 'hasPotableWater', label: 'Potable Water', icon: '💧', group: 'amenity' },
    { id: 'hasDumpStation', label: 'Dump Station', icon: '🚽', group: 'amenity' },
    { id: 'hasHookups', label: 'Hookups', icon: '⚡', group: 'amenity' },
    { id: 'hasTrash', label: 'Trash', icon: '🗑️', group: 'amenity' },
    { id: 'hasWaterFill', label: 'Water Fill', icon: '🚰', group: 'amenity' },
    { id: 'isSeasonal', label: 'Seasonal', icon: '📅', group: 'tag' },
    { id: 'hasPets', label: 'Pets Allowed', icon: '🐾', group: 'tag' },
    { id: 'needs4x4', label: '4x4 Required', icon: '🚙', group: 'tag' },
    { id: 'needsReservations', label: 'Reservations', icon: '🎫', group: 'tag' }
  ],
  
  LITERS_PER_GALLON: 3.78541,
  
  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════
  
  _listeners: {},
  
  on(event, callback) {
    if (!this._listeners[event]) {
      this._listeners[event] = [];
    }
    this._listeners[event].push(callback);
    return () => this.off(event, callback);
  },
  
  off(event, callback) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
  },
  
  emit(event, data) {
    if (!this._listeners[event]) return;
    this._listeners[event].forEach(callback => {
      try {
        callback(data);
      } catch (err) {
        console.error(`Error in ${event} listener:`, err);
      }
    });
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // ENTRIES
  // ═══════════════════════════════════════════════════════════════════════════
  
  setEntries(entries) {
    this.entries = entries;
    this.emit('entries:changed', entries);
  },
  
  getEntry(id) {
    return this.entries.find(e => e.id === id);
  },
  
  getEntriesByType(type) {
    return this.entries.filter(e => e.type === type);
  },
  
  getEntriesByStatus(status) {
    return this.entries.filter(e => e.status === status);
  },
  
  getNearbyEntries(lat, lng, radiusMiles = 50) {
    return this.entries
      .map(e => ({
        ...e,
        distance: this.getDistanceMiles(lat, lng, e.lat, e.lng)
      }))
      .filter(e => e.distance <= radiusMiles)
      .sort((a, b) => a.distance - b.distance);
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // JOURNEYS
  // ═══════════════════════════════════════════════════════════════════════════
  
  setJourneys(journeys) {
    this.journeys = journeys;
    this.emit('journeys:changed', journeys);
  },
  
  getJourney(id) {
    return this.journeys.find(j => j.id === id);
  },
  
  getCurrentJourney() {
    if (!this.currentJourneyId) return null;
    return this.getJourney(this.currentJourneyId);
  },
  
  setCurrentJourney(id) {
    this.currentJourneyId = id;
    this.emit('journey:current-changed', id);
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // VIEW NAVIGATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  setView(view) {
    const oldView = this.currentView;
    this.currentView = view;
    this.emit('view:changed', { from: oldView, to: view });
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // SELECTION
  // ═══════════════════════════════════════════════════════════════════════════
  
  selectEntry(id) {
    this.selectedEntryId = id;
    this.emit('entry:selected', id);
  },
  
  clearSelection() {
    this.selectedEntryId = null;
    this.emit('entry:selected', null);
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // USER LOCATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  setUserLocation(lat, lng) {
    this.userLat = lat;
    this.userLng = lng;
    this.emit('location:updated', { lat, lng });
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // FUEL SETTINGS
  // ═══════════════════════════════════════════════════════════════════════════
  
  setFuelSettings(settings) {
    this.fuelSettings = { ...this.fuelSettings, ...settings };
    localStorage.setItem('fuelSettings', JSON.stringify(this.fuelSettings));
    this.emit('fuel:changed', this.fuelSettings);
  },
  
  loadFuelSettings() {
    const saved = localStorage.getItem('fuelSettings');
    if (saved) {
      try {
        this.fuelSettings = { ...this.fuelSettings, ...JSON.parse(saved) };
      } catch (e) {
        console.warn('Failed to parse fuel settings:', e);
      }
    }
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════
  
  genId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  },
  
  today() {
    return new Date().toISOString().split('T')[0];
  },
  
  tomorrow() {
    return new Date(Date.now() + 86400000).toISOString().split('T')[0];
  },
  
  getDistanceMiles(lat1, lng1, lat2, lng2) {
    const R = 3958.8; // Earth's radius in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },
  
  costLabel(c) {
    if (c === null || c === undefined) return '?';
    if (c === 0) return 'Free!';
    if (c < 10) return '$';
    if (c < 100) return '$$';
    if (c < 500) return '$$$';
    return '$$$$';
  },
  
  costColor(c) {
    if (c === null || c === undefined) return '#94a3b8';
    if (c === 0) return '#2d5a47';
    if (c < 10) return '#5aab8a';
    if (c < 100) return '#d97706';
    return '#dc2626';
  },
  
  formatDistance(miles) {
    if (miles < 0.1) return '< 0.1 mi';
    if (miles < 10) return miles.toFixed(1) + ' mi';
    return Math.round(miles) + ' mi';
  },
  
  formatDuration(minutes) {
    if (minutes < 60) return `${Math.round(minutes)} min`;
    const hrs = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  }
};

// Load saved settings on init
State.loadFuelSettings();

// Export for use in other modules
window.State = State;
