/**
 * The Fallback v2 - Map Module
 * Mapbox GL JS renderer with 3-way style picker.
 *
 * STAGE 1 of the Leaflet → Mapbox GL migration:
 *   - Basemap + 3-way style picker (Streets / Outdoors / Satellite Streets) working.
 *   - BLM federal-lands raster overlay working (auto-skipped on Outdoors,
 *     which already shades NF/NP/Wilderness natively).
 *   - State Parks overlay deferred to Stage 2 (was Leaflet GeoJSON-based).
 *   - All marker/drag/discover/route code stubbed so consumers don't crash.
 *
 * Public facade (callers across the app rely on these names being stable):
 *   init, invalidateSize, flyTo, fitBounds, fitAllMarkers, zoomIn, zoomOut,
 *   setBasemap, toggleSatellite, toggleLayersPanel, closeLayersPanel,
 *   togglePublicLands, toggleStateParks,
 *   startWatchingLocation, stopWatchingLocation, centerOnUser, updateUserLocation,
 *   renderMarkers, highlightMarker, updateMarkerCount, escapeHtml, getMarkerColor,
 *   showDragPin, hideDragPin,
 *   showDiscoverMarker, hideDiscoverMarker,
 *   showDiscoverResultMarkers, hideDiscoverResultMarkers, fitDiscoverResultsBounds,
 *   drawRoute, clearRoutes, getRoute, decodePolyline,
 *   handleMapClick.
 */

const MapModule = {
  map: null,

  // State carried across the migration
  markers: [],
  userMarker: null,
  userCircle: null,
  dragPin: null,
  discoverMarker: null,
  discoverResultMarkers: [],
  discoverClusterGroup: null,
  _publicLandsAdded: false,

  STYLES: {
    street:    'mapbox://styles/mapbox/streets-v12',
    outdoors:  'mapbox://styles/mapbox/outdoors-v12',
    satellite: 'mapbox://styles/mapbox/satellite-streets-v12'
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  init(containerId) {
    if (this.map) return;

    const container = document.getElementById(containerId);
    if (!container) {
      console.error('Map container not found:', containerId);
      return;
    }
    if (typeof mapboxgl === 'undefined') {
      console.error('Mapbox GL JS not loaded');
      return;
    }
    const token = (typeof CONFIG !== 'undefined' && CONFIG.MAPBOX_TOKEN)
      || (window.CONFIG && window.CONFIG.MAPBOX_TOKEN)
      || '';
    if (!token) {
      console.error('CONFIG.MAPBOX_TOKEN is missing');
      return;
    }

    mapboxgl.accessToken = token;

    const initialStyle = (State.currentStyle && this.STYLES[State.currentStyle])
      ? State.currentStyle
      : 'street';
    State.currentStyle = initialStyle;
    State.isSatellite = initialStyle === 'satellite';

    this.map = new mapboxgl.Map({
      container: containerId,
      style: this.STYLES[initialStyle],
      center: [-98.35, 39.5], // [lng, lat] — Mapbox GL flips coord order vs Leaflet
      zoom: 4,
      attributionControl: true
    });

    // setStyle() preserves mapboxgl.Marker instances but blows away sources/layers.
    // Re-attach overlays + (in later stages) routes + Discover layers on every
    // style swap.
    this.map.on('style.load', () => {
      this._publicLandsAdded = false;
      if (State.showPublicLands) this._addPublicLandsLayer();
    });

    // Subscriptions used by Stage 2+; markers are stubbed today.
    State.on('entries:changed', () => this.renderMarkers());
    State.on('entry:selected', id => this.highlightMarker(id));
    State.on('location:updated', ({ lat, lng }) => this.updateUserLocation(lat, lng));

    this.map.on('click', e => this.handleMapClick(e));

    this.map.once('load', () => {
      State.mapReady = true;
      State.emit('map:ready');
    });
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // MAP CONTROLS
  // ═══════════════════════════════════════════════════════════════════════════

  invalidateSize() {
    if (this.map) this.map.resize();
  },

  flyTo(lat, lng, zoom = 12) {
    if (!this.map) return;
    this.map.flyTo({ center: [lng, lat], zoom, duration: 500 });
  },

  fitBounds(bounds, padding = 50) {
    if (!this.map || !bounds) return;
    // Accept [[lat,lng],[lat,lng]]; convert to [[lng,lat],[lng,lat]] for Mapbox.
    if (Array.isArray(bounds) && bounds.length === 2 && Array.isArray(bounds[0])) {
      const [sw, ne] = bounds;
      this.map.fitBounds([[sw[1], sw[0]], [ne[1], ne[0]]], { padding });
      return;
    }
    // Already a LngLatBoundsLike (e.g. [west, south, east, north] or LngLatBounds).
    this.map.fitBounds(bounds, { padding });
  },

  fitAllMarkers() {
    // Stage 2: rebuild from marker LngLats.
  },

  zoomIn()  { if (this.map) this.map.zoomIn(); },
  zoomOut() { if (this.map) this.map.zoomOut(); },

  toggleLayersPanel() {
    const panel = document.getElementById('map-layers-panel');
    if (!panel) return;
    const isOpen = panel.style.display && panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
  },

  closeLayersPanel() {
    const panel = document.getElementById('map-layers-panel');
    if (panel) panel.style.display = 'none';
  },

  setBasemap(type) {
    if (!this.map || !this.STYLES[type]) return;
    if (State.currentStyle === type) return;
    State.currentStyle = type;
    State.isSatellite = type === 'satellite';
    this.map.setStyle(this.STYLES[type]);
    // style.load handler re-applies the public-lands overlay.
  },

  toggleSatellite() {
    this.setBasemap(State.isSatellite ? 'street' : 'satellite');
    return State.isSatellite;
  },

  // ─── Public-lands overlay (BLM SMA raster — Federal: BLM/USFS/NPS/FWS) ────
  // Skipped on Outdoors style: that style already shades NF/NP/Wilderness.

  togglePublicLands() {
    State.showPublicLands = !State.showPublicLands;
    const legend = document.getElementById('sma-legend');
    if (!this.map) return State.showPublicLands;
    if (State.showPublicLands) {
      this._addPublicLandsLayer();
      if (legend) legend.style.display = 'block';
    } else {
      this._removePublicLandsLayer();
      if (legend) legend.style.display = 'none';
    }
    return State.showPublicLands;
  },

  _addPublicLandsLayer() {
    if (!this.map || this._publicLandsAdded) return;
    if (State.currentStyle === 'outdoors') return;
    if (!this.map.isStyleLoaded()) return; // style.load handler will retry
    if (this.map.getSource('blm-sma')) return;
    this.map.addSource('blm-sma', {
      type: 'raster',
      tiles: ['https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 14,
      attribution: 'Surface Management &copy; BLM'
    });
    this.map.addLayer({
      id: 'blm-sma',
      type: 'raster',
      source: 'blm-sma',
      paint: { 'raster-opacity': 0.6 }
    });
    this._publicLandsAdded = true;
  },

  _removePublicLandsLayer() {
    if (!this.map) return;
    if (this.map.getLayer('blm-sma'))  this.map.removeLayer('blm-sma');
    if (this.map.getSource('blm-sma')) this.map.removeSource('blm-sma');
    this._publicLandsAdded = false;
  },

  // ─── State parks (Stage 2) ────────────────────────────────────────────────
  // PAD-US GeoJSON layer; needs a port to a Mapbox GL geojson source + fill layer.
  toggleStateParks() {
    const cb = document.getElementById('layer-stateparks');
    if (cb) cb.checked = false;
    const legend = document.getElementById('stateparks-legend');
    if (legend) legend.style.display = 'none';
    if (window.UI?.showToast) UI.showToast('State Parks overlay returns in the next migration step', 'info');
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // USER LOCATION
  // ═══════════════════════════════════════════════════════════════════════════

  startWatchingLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      pos => State.setUserLocation(pos.coords.latitude, pos.coords.longitude),
      err => console.warn('Geolocation error:', err),
      { enableHighAccuracy: true, timeout: 10000 }
    );
    State.watchId = navigator.geolocation.watchPosition(
      pos => State.setUserLocation(pos.coords.latitude, pos.coords.longitude),
      err => console.warn('Watch position error:', err),
      { enableHighAccuracy: false, timeout: 30000, maximumAge: 60000 }
    );
  },

  stopWatchingLocation() {
    if (State.watchId) {
      navigator.geolocation.clearWatch(State.watchId);
      State.watchId = null;
    }
  },

  // Stage 2: render the blue user-location dot + accuracy ring as an element-based Marker.
  updateUserLocation(_lat, _lng) {},

  centerOnUser() {
    if (State.userLat && State.userLng) {
      this.flyTo(State.userLat, State.userLng, 14);
      return;
    }
    if (!navigator.geolocation) {
      if (window.UI?.showToast) UI.showToast('Location not available in this browser', 'error');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => {
        State.setUserLocation(pos.coords.latitude, pos.coords.longitude);
        this.flyTo(pos.coords.latitude, pos.coords.longitude, 14);
      },
      err => {
        console.warn('[Map] centerOnUser geolocation error:', err);
        const msg = err.code === 1
          ? 'Location permission denied. Enable it in your browser settings.'
          : "Couldn't get your location";
        if (window.UI?.showToast) UI.showToast(msg, 'error');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // MARKERS (Stage 2 — currently stubs so consumers don't crash)
  // ═══════════════════════════════════════════════════════════════════════════

  renderMarkers() {
    this.updateMarkerCount();
  },

  highlightMarker(_id) {},

  updateMarkerCount() {
    const countEl = document.getElementById('marker-count');
    if (countEl) {
      countEl.innerHTML = `<strong>${State.entries.length}</strong> <span>locations</span>`;
    }
  },

  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  getMarkerColor(entry) {
    const colors = {
      'National Park':   '#2d5a47',
      'National Forest': '#2d5a47',
      'BLM':             '#2d5a47',
      'State Park':      '#3b82f6',
      'Dispersed':       '#dc2626',
      'Private':         '#6b7280',
      'Other':           '#6b7280'
    };
    return colors[entry.type] || '#6b7280';
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DRAG PIN / DISCOVER MARKERS (Stage 2 + Stage 3 — stubs)
  // ═══════════════════════════════════════════════════════════════════════════

  showDragPin(_lat, _lng) {},
  hideDragPin() {},

  showDiscoverMarker(_lat, _lng, _name) {},
  hideDiscoverMarker() {},

  showDiscoverResultMarkers(_results, _onMarkerClick, _opts = {}) {},
  hideDiscoverResultMarkers() {},
  fitDiscoverResultsBounds(_padding = 60) {},

  // ═══════════════════════════════════════════════════════════════════════════
  // ROUTING (REST API preserved; map drawing stubbed until Stage 4)
  // ═══════════════════════════════════════════════════════════════════════════

  async getRoute(from, to) {
    const ORS_API_KEY = window.CONFIG?.ORS_API_KEY;
    if (!ORS_API_KEY) {
      console.error('ORS API key not configured');
      return null;
    }
    try {
      const response = await fetch('https://api.openrouteservice.org/v2/directions/driving-car', {
        method: 'POST',
        headers: {
          'Authorization': ORS_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          coordinates: [[from.lng, from.lat], [to.lng, to.lat]],
          instructions: false
        })
      });
      if (!response.ok) throw new Error('Routing request failed');
      const data = await response.json();
      const route = data.routes?.[0];
      if (!route) return null;
      return {
        distance: route.summary.distance / 1609.34,
        duration: route.summary.duration / 60,
        geometry: route.geometry
      };
    } catch (err) {
      console.error('Routing error:', err);
      return null;
    }
  },

  drawRoute(_geometry, _options = {}) {},
  clearRoutes() {},

  decodePolyline(encoded) {
    const coords = [];
    let index = 0, lat = 0, lng = 0;
    while (index < encoded.length) {
      let b, shift = 0, result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0;
      result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      coords.push([lat / 1e5, lng / 1e5]);
    }
    return coords;
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // MAP EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  handleMapClick(e) {
    // Drag pin returns in Stage 2.
    if (State.currentView === 'saved' && State.selectedEntryId) {
      State.selectEntry(null);
      this.fitAllMarkers();
    }
  }
};

window.MapModule = MapModule;
