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
  // True once Firebase has delivered its first entries snapshot. Lets the
  // Explore/Saved views distinguish "no spots yet" (legit empty) from "still
  // loading from Firestore" (don't render the empty state).
  entriesLoaded: false,
  
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
    { id: 'hasDumpStation', label: 'Dump Station', icon: '<svg width="16" height="16" viewBox="-12 -12 24 24" style="vertical-align:middle"><rect x="-10" y="-10" width="14" height="9" rx="3" fill="#1f2937"/><rect x="-8" y="-8" width="3" height="3" rx="0.5" fill="white"/><rect x="-3" y="-8" width="3" height="3" rx="0.5" fill="white"/><circle cx="3" cy="-3" r="3" fill="#1f2937"/><circle cx="3" cy="-3" r="1.5" fill="white"/><rect x="5" y="-4" width="3" height="2" fill="#1f2937"/><rect x="-10" y="2" width="18" height="8" rx="1" fill="#1f2937"/><path d="M-5 4 L-5 6 L-7 6 L-3 9 L1 6 L-1 6 L-1 4 Z" fill="white"/></svg>', group: 'amenity' },
    { id: 'hasHookups', label: 'Hookups', icon: '⚡', group: 'amenity' },
    { id: 'hasTrash', label: 'Trash', icon: '🗑️', group: 'amenity' },
    { id: 'hasWaterFill', label: 'Water Fill', icon: '<svg width="16" height="16" viewBox="-8 -14 16 28" style="vertical-align:middle"><rect x="-4" y="-12" width="8" height="3" rx="1" fill="#0ea5e9"/><rect x="-6" y="-9" width="12" height="17" rx="2" fill="#0ea5e9"/><path d="M0 -4 Q-3 1 0 5 Q3 1 0 -4 Z" fill="white"/></svg>', group: 'amenity' },
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
  // JOURNEY CONTEXT
  // ═══════════════════════════════════════════════════════════════════════════
  // SINGLE SOURCE OF TRUTH for "where is the user relative to the current
  // journey?". Both the trip-status card ("Currently at / En route to") and
  // the Explore "Nearby Spots" anchor derive from this function so the two
  // views can never disagree.
  //
  // Returns:
  //   {
  //     journey, legs,
  //     currentLegIndex,    // index of leg whose stop the user is at, or -1
  //     currentLegRole,     // 'dest' | 'start' | null
  //     atStartingPoint,    // true iff user is at journey's starting point
  //     currentLocationId,  // entry id of current stop (or null)
  //     currentLocationName,
  //     currentLocationLat, currentLocationLng,
  //     nextLegIndex,       // index of the upcoming leg, or -1 if none
  //     nextLocationId, nextLocationName,
  //     nextLocationLat, nextLocationLng
  //   }
  //
  // Prefers CURRENT entry coords over leg snapshots — if the user later edits
  // a pin, the leg's snapshot coords go stale and would report a phantom
  // distance. PROX=3mi is the "currently at" radius (tight enough that two
  // adjacent stops rarely both qualify; the closest-stop tie-breaker handles
  // the overlap case).
  getJourneyContext(journey) {
    const empty = {
      journey: null, legs: [],
      currentLegIndex: -1, currentLegRole: null, atStartingPoint: false,
      currentLocationId: null, currentLocationName: null,
      currentLocationLat: null, currentLocationLng: null,
      nextLegIndex: -1,
      nextLocationId: null, nextLocationName: null,
      nextLocationLat: null, nextLocationLng: null
    };
    if (!journey || !Array.isArray(journey.legs) || !journey.legs.length) return empty;

    const legs = journey.legs;
    const uLat = this.userLat, uLng = this.userLng;
    const PROX = 3;

    let currentLegIndex = -1;
    let currentLegRole = null;
    let atStartingPoint = false;
    let currentLocationId = null;
    let currentLocationName = null;
    let currentLocationLat = null;
    let currentLocationLng = null;
    let nextLegIndex = -1;

    if (uLat != null && uLng != null) {
      let closestDist = Infinity;

      // Starting point of leg 0
      const firstLeg = legs[0];
      const fromE = firstLeg.fromId ? this.getEntry(firstLeg.fromId) : null;
      const fromLat = fromE?.lat ?? firstLeg.fromLat;
      const fromLng = fromE?.lng ?? firstLeg.fromLng;
      if (fromLat != null && fromLng != null) {
        const d = this.getDistanceMiles(uLat, uLng, fromLat, fromLng);
        if (d <= PROX) {
          closestDist = d;
          atStartingPoint = true;
          currentLegIndex = 0;
          currentLegRole = 'start';
          currentLocationId = firstLeg.fromId || null;
          currentLocationName = firstLeg.fromName || fromE?.name || null;
          currentLocationLat = fromLat;
          currentLocationLng = fromLng;
          nextLegIndex = 0;
        }
      }

      // Each destination — tie-breaker picks the CLOSER stop
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        const destE = this.getEntry(l.destId);
        const destLat = destE?.lat ?? l.destLat;
        const destLng = destE?.lng ?? l.destLng;
        if (destLat == null || destLng == null) continue;
        const d = this.getDistanceMiles(uLat, uLng, destLat, destLng);
        if (d <= PROX && d < closestDist) {
          closestDist = d;
          atStartingPoint = false;
          currentLegIndex = i;
          currentLegRole = 'dest';
          currentLocationId = l.destId;
          currentLocationName = l.destName || destE?.name || null;
          currentLocationLat = destLat;
          currentLocationLng = destLng;
          nextLegIndex = i + 1;
        }
      }
    }

    // Fallback: if not at any stop, "next" = destination whose coords are
    // closest to the user. If we have no GPS, default to leg 0.
    if (currentLegIndex === -1) {
      if (uLat != null && uLng != null) {
        let closestDist = Infinity;
        let closestIdx = -1;
        for (let i = 0; i < legs.length; i++) {
          const l = legs[i];
          const destE = this.getEntry(l.destId);
          const destLat = destE?.lat ?? l.destLat;
          const destLng = destE?.lng ?? l.destLng;
          if (destLat == null) continue;
          const d = this.getDistanceMiles(uLat, uLng, destLat, destLng);
          if (d < closestDist) { closestDist = d; closestIdx = i; }
        }
        nextLegIndex = closestIdx >= 0 ? closestIdx : 0;
      } else {
        nextLegIndex = 0;
      }
    }

    // Clamp next to valid range
    if (nextLegIndex >= legs.length) nextLegIndex = -1;

    // Resolve next-destination fields
    let nextLocationId = null, nextLocationName = null;
    let nextLocationLat = null, nextLocationLng = null;
    if (nextLegIndex >= 0 && nextLegIndex < legs.length) {
      const nl = legs[nextLegIndex];
      const ne = this.getEntry(nl.destId);
      nextLocationId = nl.destId;
      nextLocationName = nl.destName || ne?.name || null;
      nextLocationLat = ne?.lat ?? nl.destLat;
      nextLocationLng = ne?.lng ?? nl.destLng;
    }

    return {
      journey, legs,
      currentLegIndex, currentLegRole, atStartingPoint,
      currentLocationId, currentLocationName,
      currentLocationLat, currentLocationLng,
      nextLegIndex,
      nextLocationId, nextLocationName,
      nextLocationLat, nextLocationLng
    };
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
