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
    
    // Public lands overlay
    this.publicLandsLayer = L.tileLayer('https://tiles.arcgis.com/tiles/v01gqwM5QqNysAAi/arcgis/rest/services/PADUS3_0_VA_OverlaySmall/MapServer/tile/{z}/{y}/{x}', {
      opacity: 0.15,
      maxZoom: 16
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
    if (State.userLat && State.userLng) {
      this.flyTo(State.userLat, State.userLng, 14);
    }
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
  
  toggleSatellite() {
    State.isSatellite = !State.isSatellite;
    
    if (State.isSatellite) {
      this.map.removeLayer(this.streetLayer);
      this.satelliteLayer.addTo(this.map);
    } else {
      this.map.removeLayer(this.satelliteLayer);
      this.streetLayer.addTo(this.map);
    }
    
    // Keep public lands on top
    if (State.showPublicLands) {
      this.publicLandsLayer.bringToFront();
    }
    
    return State.isSatellite;
  },
  
  togglePublicLands() {
    State.showPublicLands = !State.showPublicLands;
    
    if (State.showPublicLands) {
      this.publicLandsLayer.addTo(this.map);
    } else {
      this.map.removeLayer(this.publicLandsLayer);
    }
    
    return State.showPublicLands;
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
    }
  }
};

// Export
window.MapModule = MapModule;
