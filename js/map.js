/**
 * The Fallback v2 - Map Module
 * Leaflet map, markers, layers, and routing
 */

const MapModule = {
  // Map instance
  map: null,
  
  // Layers
  streetLayer: null,
  satelliteLayer: null,
  publicLandsLayer: null,
  routeLayer: null,
  
  // Markers
  markers: [],
  userMarker: null,
  userCircle: null,
  dragPin: null,
  discoverMarker: null,            // single gold pin for the active POI detail
  discoverResultMarkers: [],       // teal pins for every POI in the current Discover results
  discoverClusterGroup: null,      // L.markerClusterGroup wrapping the markers when clustering is on
  
  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  init(containerId) {
    if (this.map) return; // Already initialized
    
    const container = document.getElementById(containerId);
    if (!container) {
      console.error('Map container not found:', containerId);
      return;
    }
    
    // Create map
    this.map = L.map(containerId, {
      center: [39.5, -98.35],
      zoom: 4,
      zoomControl: false,
      attributionControl: true
    });
    
    // Street layer (default)
    this.streetLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      maxZoom: 19
    }).addTo(this.map);
    
    // Satellite layer
    this.satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '&copy; Esri',
      maxZoom: 19
    });
    
    // Public lands overlay — BLM Surface Management Agency (Federal: BLM, USFS, NPS, FWS)
    this.publicLandsLayer = L.tileLayer('https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Surface Management &copy; BLM',
      maxZoom: 14,
      opacity: 0.6
    });
    
    if (State.showPublicLands) {
      this.publicLandsLayer.addTo(this.map);
    }
    
    // Route layer group
    this.routeLayer = L.layerGroup().addTo(this.map);
    
    // Subscribe to state changes
    State.on('entries:changed', () => this.renderMarkers());
    State.on('entry:selected', id => this.highlightMarker(id));
    State.on('location:updated', ({ lat, lng }) => this.updateUserLocation(lat, lng));
    
    // Map events
    this.map.on('click', e => this.handleMapClick(e));
    
    State.mapReady = true;
    State.emit('map:ready');
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // MARKERS
  // ═══════════════════════════════════════════════════════════════════════════
  
  renderMarkers() {
    // Clear existing markers
    this.markers.forEach(m => m.remove());
    this.markers = [];
    
    // Add markers for all entries
    State.entries.forEach(entry => {
      if (!entry.lat || !entry.lng) return;
      
      const marker = this.createMarker(entry);
      marker.addTo(this.map);
      this.markers.push(marker);
    });
    
    // Update count display
    this.updateMarkerCount();
  },
  
  createMarker(entry) {
    const isSelected = State.selectedEntryId === entry.id;
    
    // Create custom icon
    const icon = L.divIcon({
      className: 'custom-marker',
      html: `<div class="marker-pin ${isSelected ? 'selected' : ''}" style="background: ${this.getMarkerColor(entry)}"></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
    
    const marker = L.marker([entry.lat, entry.lng], { icon });
    
    // Store entry reference
    marker._entryId = entry.id;
    
    // Create popup content
    const costText = entry.cost === 0 ? 'Free!' : entry.cost ? `$${entry.cost}/night` : '';
    const statusText = entry.status ? State.STATUS_LABELS[entry.status] || entry.status : '';
    const popupContent = `
      <div class="marker-popup">
        <div class="marker-popup-name">${this.escapeHtml(entry.name)}</div>
        ${statusText ? `<div class="marker-popup-status">· ${statusText}</div>` : ''}
        ${costText ? `<div class="marker-popup-cost">${costText}</div>` : ''}
        <button class="marker-popup-btn" onclick="Entries.openEditForm(State.getEntry('${entry.id}'))">Edit / View Details</button>
      </div>
    `;
    
    marker.bindPopup(popupContent, {
      className: 'custom-popup',
      closeButton: true,
      maxWidth: 280
    });
    
    // Click handler
    marker.on('click', () => {
      State.selectEntry(entry.id);
    });
    
    return marker;
  },
  
  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
  
  getMarkerColor(entry) {
    // Color based on type
    // Blue = State, Red = Dispersed, Green = Federal (NP/NF/BLM), Grey = Other
    const colors = {
      'National Park': '#2d5a47',      // Green (Federal)
      'National Forest': '#2d5a47',    // Green (Federal)
      'BLM': '#2d5a47',                // Green (Federal)
      'State Park': '#3b82f6',         // Blue (State)
      'Dispersed': '#dc2626',          // Red (Dispersed)
      'Private': '#6b7280',            // Grey (Other)
      'Other': '#6b7280'               // Grey (Other)
    };
    return colors[entry.type] || '#6b7280';
  },
  
  highlightMarker(id) {
    this.markers.forEach(marker => {
      const entry = State.getEntry(marker._entryId);
      if (!entry) return;
      
      const isSelected = marker._entryId === id;
      const icon = L.divIcon({
        className: 'custom-marker',
        html: `<div class="marker-pin ${isSelected ? 'selected' : ''}" style="background: ${this.getMarkerColor(entry)}"></div>`,
        iconSize: isSelected ? [36, 36] : [28, 28],
        iconAnchor: isSelected ? [18, 18] : [14, 14]
      });
      marker.setIcon(icon);
    });
  },
  
  updateMarkerCount() {
    const countEl = document.getElementById('marker-count');
    if (countEl) {
      countEl.innerHTML = `<strong>${State.entries.length}</strong> <span>locations</span>`;
    }
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // USER LOCATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  startWatchingLocation() {
    if (!navigator.geolocation) return;
    
    // Get initial position
    navigator.geolocation.getCurrentPosition(
      pos => {
        State.setUserLocation(pos.coords.latitude, pos.coords.longitude);
      },
      err => console.warn('Geolocation error:', err),
      { enableHighAccuracy: true, timeout: 10000 }
    );
    
    // Watch for updates (less frequent to save battery)
    State.watchId = navigator.geolocation.watchPosition(
      pos => {
        State.setUserLocation(pos.coords.latitude, pos.coords.longitude);
      },
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
  
  updateUserLocation(lat, lng) {
    if (!this.map) return;
    
    // Remove existing user marker
    if (this.userMarker) this.userMarker.remove();
    if (this.userCircle) this.userCircle.remove();
    
    // Add blue dot for user location
    this.userMarker = L.circleMarker([lat, lng], {
      radius: 8,
      fillColor: '#3498db',
      fillOpacity: 1,
      color: 'white',
      weight: 3
    }).addTo(this.map);
    
    // Accuracy circle
    this.userCircle = L.circle([lat, lng], {
      radius: 100, // meters
      fillColor: '#3498db',
      fillOpacity: 0.1,
      color: '#3498db',
      weight: 1
    }).addTo(this.map);
  },
  
  centerOnUser() {
    // If we already have a GPS fix, use it immediately
    if (State.userLat && State.userLng) {
      this.flyTo(State.userLat, State.userLng, 14);
      return;
    }
    // Otherwise, request a fresh position (GPS may have been denied previously or
    // simply never succeeded). Prompt the user again and provide feedback.
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
          : 'Couldn\'t get your location';
        if (window.UI?.showToast) UI.showToast(msg, 'error');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // MAP CONTROLS
  // ═══════════════════════════════════════════════════════════════════════════
  
  flyTo(lat, lng, zoom = 12) {
    if (!this.map) return;
    this.map.flyTo([lat, lng], zoom, { duration: 0.5 });
  },
  
  fitBounds(bounds, padding = 50) {
    if (!this.map) return;
    this.map.fitBounds(bounds, { padding: [padding, padding] });
  },
  
  fitAllMarkers() {
    if (!this.markers.length) return;
    
    const group = L.featureGroup(this.markers);
    this.fitBounds(group.getBounds());
  },
  
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
    if (!this.map) return;
    if (type === 'satellite') {
      if (this.map.hasLayer(this.streetLayer)) this.map.removeLayer(this.streetLayer);
      if (!this.map.hasLayer(this.satelliteLayer)) this.satelliteLayer.addTo(this.map);
      this.satelliteLayer.bringToBack();
      State.isSatellite = true;
    } else {
      if (this.map.hasLayer(this.satelliteLayer)) this.map.removeLayer(this.satelliteLayer);
      if (!this.map.hasLayer(this.streetLayer)) this.streetLayer.addTo(this.map);
      this.streetLayer.bringToBack();
      State.isSatellite = false;
    }
    if (this.map.hasLayer(this.publicLandsLayer)) this.publicLandsLayer.bringToFront();
    if (this.stateParksLayer && this.map.hasLayer(this.stateParksLayer)) this.stateParksLayer.bringToFront();
  },

  toggleSatellite() {
    this.setBasemap(State.isSatellite ? 'street' : 'satellite');
    return State.isSatellite;
  },

  togglePublicLands() {
    State.showPublicLands = !State.showPublicLands;
    const legend = document.getElementById('sma-legend');
    if (!this.map) return State.showPublicLands;
    if (State.showPublicLands) {
      this.publicLandsLayer.addTo(this.map);
      if (legend) legend.style.display = 'block';
    } else {
      this.map.removeLayer(this.publicLandsLayer);
      if (legend) legend.style.display = 'none';
    }
    return State.showPublicLands;
  },

  // ─── State Parks overlay (PAD-US) ──────────────────────────────────────────
  stateParksLayer: null,
  _stateParksCache: {},
  _stateParksBound: false,

  toggleStateParks() {
    const cb = document.getElementById('layer-stateparks');
    const legend = document.getElementById('stateparks-legend');
    if (cb?.checked) {
      if (legend) legend.style.display = 'block';
      if (this.stateParksLayer) {
        this.stateParksLayer.addTo(this.map);
      } else {
        this.loadStateParksInView();
        if (!this._stateParksBound) {
          this.map.on('moveend', () => this.loadStateParksInView());
          this._stateParksBound = true;
        }
      }
    } else {
      if (this.stateParksLayer) this.map.removeLayer(this.stateParksLayer);
      if (legend) legend.style.display = 'none';
    }
  },

  async loadStateParksInView() {
    const cb = document.getElementById('layer-stateparks');
    if (!cb?.checked) return;
    const loading = document.getElementById('stateparks-loading');
    const bounds = this.map.getBounds();
    const zoom = this.map.getZoom();
    if (zoom < 8) {
      if (this.stateParksLayer) { this.map.removeLayer(this.stateParksLayer); this.stateParksLayer = null; }
      return;
    }
    const cacheKey = `${bounds.toBBoxString()}-${zoom}`;
    if (this._stateParksCache[cacheKey]) return;
    if (loading) loading.style.display = 'inline';
    try {
      const bbox = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`;
      const where = encodeURIComponent("Mang_Name='SPR' OR Des_Tp='SP'");
      const url = `https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Manager_Name/FeatureServer/0/query?where=${where}&geometry=${encodeURIComponent(bbox)}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&outFields=Unit_Nm,Mang_Name,Des_Tp&returnGeometry=true&f=geojson`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (data.features?.length > 0) {
        this._stateParksCache[cacheKey] = true;
        const style = { color: 'rgba(37,99,235,0.3)', fillColor: '#3b82f6', fillOpacity: 0.05, weight: 1.5 };
        if (this.stateParksLayer) {
          L.geoJSON(data, { style }).eachLayer(l => this.stateParksLayer.addLayer(l));
        } else {
          this.stateParksLayer = L.geoJSON(data, {
            style,
            onEachFeature: (f, l) => {
              if (f.properties?.Unit_Nm) l.bindPopup(`<b>${f.properties.Unit_Nm}</b><br>State Park`);
            }
          }).addTo(this.map);
        }
      }
    } catch (e) {
      console.error('[MapModule] Error loading state parks:', e);
    }
    if (loading) loading.style.display = 'none';
  },
  
  zoomIn() {
    if (this.map) this.map.zoomIn();
  },
  
  zoomOut() {
    if (this.map) this.map.zoomOut();
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // ROUTING
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
        distance: route.summary.distance / 1609.34, // meters to miles
        duration: route.summary.duration / 60, // seconds to minutes
        geometry: route.geometry
      };
    } catch (err) {
      console.error('Routing error:', err);
      return null;
    }
  },
  
  drawRoute(geometry, options = {}) {
    // Clear existing routes
    this.routeLayer.clearLayers();
    
    if (!geometry) return;
    
    // Decode polyline if needed
    const coords = typeof geometry === 'string'
      ? this.decodePolyline(geometry)
      : geometry;
    
    // Draw route line
    const routeLine = L.polyline(coords, {
      color: options.color || '#B855D3',
      weight: options.weight || 4,
      opacity: options.opacity || 0.8
    });
    
    this.routeLayer.addLayer(routeLine);
    
    return routeLine;
  },
  
  clearRoutes() {
    this.routeLayer.clearLayers();
  },
  
  decodePolyline(encoded) {
    // Decode Google-style encoded polyline
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
  // DRAG PIN (for form)
  // ═══════════════════════════════════════════════════════════════════════════
  
  showDragPin(lat, lng) {
    if (this.dragPin) this.dragPin.remove();
    
    const icon = L.divIcon({
      className: 'custom-marker',
      html: '<div class="marker-pin" style="background: #c9a45c; border-color: #c9a45c;"></div>',
      iconSize: [36, 36],
      iconAnchor: [18, 18]
    });
    
    this.dragPin = L.marker([lat, lng], {
      icon,
      draggable: true,
      autoPan: true
    }).addTo(this.map);
    
    this.dragPin.on('dragend', () => {
      const pos = this.dragPin.getLatLng();
      State.pendingLat = pos.lat;
      State.pendingLng = pos.lng;
      State.emit('dragpin:moved', { lat: pos.lat, lng: pos.lng });
    });
    
    this.flyTo(lat, lng, 14);
  },
  
  hideDragPin() {
    if (this.dragPin) {
      this.dragPin.remove();
      this.dragPin = null;
    }
  },

  // ─── Discover POI marker (transient, while detail panel is open) ────────
  // Same gold accent + white border as the rest of v2's pin styling. Not
  // draggable; the user clicks the marker → popup with the POI name. Removed
  // when the detail panel closes so it doesn't pollute other views.
  showDiscoverMarker(lat, lng, name) {
    if (this.discoverMarker) this.discoverMarker.remove();
    if (!this.map) return;

    const icon = L.divIcon({
      className: 'custom-marker',
      html: '<div class="marker-pin discover"></div>',
      iconSize: [36, 36],
      iconAnchor: [18, 18]
    });
    this.discoverMarker = L.marker([lat, lng], { icon, zIndexOffset: 1500 }).addTo(this.map);
    if (name) this.discoverMarker.bindPopup(this.escapeHtml(name));
  },

  hideDiscoverMarker() {
    if (this.discoverMarker) {
      this.discoverMarker.remove();
      this.discoverMarker = null;
    }
  },

  // ── Teal result markers for every POI in the current Discover results ──
  // Gives the user spatial context for the list panel: each card has a pin
  // on the map, and clicking the pin opens that POI's detail panel.
  // Existing `discoverMarker` (gold) still shows on top when a detail panel
  // is open — the teal layer is the "all results" backdrop.
  showDiscoverResultMarkers(results, onMarkerClick, opts = {}) {
    this.hideDiscoverResultMarkers();
    if (!this.map || !results?.length) return;

    const icon = L.divIcon({
      className: 'custom-marker',
      html: '<div class="marker-pin discover-result"></div>',
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    // Cluster mode: build a markerClusterGroup and add markers to it instead
    // of directly to the map. Used by the Hiking category, where the broader
    // OSM query can return ~30 trail/trailhead pins clustered tightly around
    // a state park. Other categories (Camping, Top Picks) stay flat — their
    // result counts are low and clustering would just hide a single pin.
    const useCluster = opts.cluster === true && typeof L.markerClusterGroup === 'function';
    let clusterGroup = null;
    if (useCluster) {
      clusterGroup = L.markerClusterGroup({
        showCoverageOnHover: false,
        maxClusterRadius: 50,
        spiderfyOnMaxZoom: true,
        iconCreateFunction: (cluster) => L.divIcon({
          html: `<div class="discover-cluster"><span>${cluster.getChildCount()}</span></div>`,
          className: 'discover-cluster-wrap',
          iconSize: [36, 36]
        })
      });
      this.discoverClusterGroup = clusterGroup;
    }

    results.forEach(p => {
      if (p.lat == null || p.lng == null) return;
      const m = L.marker([p.lat, p.lng], { icon, zIndexOffset: 800 });
      if (p.name) m.bindTooltip(this.escapeHtml(p.name), { direction: 'top', offset: [0, -8] });
      if (typeof onMarkerClick === 'function') {
        m.on('click', (e) => {
          // Stop the map click handler from also firing (which clears selection).
          if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
          onMarkerClick(p.xid);
        });
      }
      if (clusterGroup) clusterGroup.addLayer(m);
      else m.addTo(this.map);
      this.discoverResultMarkers.push(m);
    });

    if (clusterGroup) clusterGroup.addTo(this.map);
  },

  hideDiscoverResultMarkers() {
    if (this.discoverClusterGroup) {
      this.discoverClusterGroup.clearLayers();
      this.discoverClusterGroup.removeFrom(this.map);
      this.discoverClusterGroup = null;
    }
    this.discoverResultMarkers.forEach(m => { try { m.remove(); } catch (e) { /* in cluster group */ } });
    this.discoverResultMarkers = [];
  },

  // Fit the map to show all current Discover result markers.
  // Called once when results first land for an anchor change so the user
  // immediately sees where everything is.
  fitDiscoverResultsBounds(padding = 60) {
    if (!this.map || !this.discoverResultMarkers.length) return;
    const group = L.featureGroup(this.discoverResultMarkers);
    const bounds = group.getBounds();
    if (bounds.isValid()) {
      this.map.fitBounds(bounds, { padding: [padding, padding], maxZoom: 13 });
    }
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // MAP EVENTS
  // ═══════════════════════════════════════════════════════════════════════════
  
  handleMapClick(e) {
    // If drag pin is active, move it
    if (this.dragPin) {
      this.dragPin.setLatLng(e.latlng);
      State.pendingLat = e.latlng.lat;
      State.pendingLng = e.latlng.lng;
      State.emit('dragpin:moved', { lat: e.latlng.lat, lng: e.latlng.lng });
      return;
    }
    // Clicking the map background on Saved view deselects the current entry
    // and zooms back out to show all markers.
    if (State.currentView === 'saved' && State.selectedEntryId) {
      State.selectEntry(null);
      this.fitAllMarkers();
    }
  }
};

// Export
window.MapModule = MapModule;
