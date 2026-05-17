/**
 * The Fallback v2 - Map Module
 * Mapbox GL JS renderer with 3-way style picker.
 *
 * Migration status (Leaflet → Mapbox GL JS):
 *   STAGE 1 ✅ basemap + 3-way style picker + BLM federal-lands overlay
 *   STAGE 2 ✅ saved markers, popups, highlight, drag pin, user-location dot,
 *               State Parks overlay (GeoJSON source + fill/line layers)
 *   STAGE 3 ✅ Discover single gold marker + result markers + Hiking clustering
 *               (native Mapbox GL cluster source — replaces Leaflet.markercluster)
 *   STAGE 4 ⏳ Trips journey markers + polylines + backup markers
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

  // Markers
  markers: [],
  userMarker: null,
  dragPin: null,

  // Discover
  discoverMarker: null,
  discoverResultMarkers: [],         // non-cluster mode: mapboxgl.Marker[]
  _discoverResultsCluster: false,    // true if Hiking-style clustering is active
  _discoverResultsData: null,        // cached FeatureCollection for cluster re-attach
  _discoverResultsOnClick: null,     // cached callback for cluster re-attach
  _discoverClusterHandlersBound: false,

  // Overlays
  _publicLandsAdded: false,
  _stateParksFeatures: {}, // keyed by Unit_Nm to dedupe
  _stateParksBound: false,
  _stateParksCache: {},    // bbox-zoom keys we've already fetched

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
    // Re-attach overlays + (in Stage 3+) routes + Discover layers on every swap.
    this.map.on('style.load', () => {
      this._publicLandsAdded = false;
      if (State.showPublicLands) this._addPublicLandsLayer();
      this._addStateParksLayerIfEnabled();
      // Cluster source/layers/handlers all get blown away by setStyle.
      // Element-based mapboxgl.Marker instances (single gold marker, flat
      // non-cluster result markers) persist automatically.
      if (this._discoverResultsCluster && this._discoverResultsData) {
        this._discoverClusterHandlersBound = false;
        this._addDiscoverClusterLayers();
      }
    });

    // Subscriptions
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
    if (Array.isArray(bounds) && bounds.length === 2 && Array.isArray(bounds[0])) {
      const [sw, ne] = bounds;
      this.map.fitBounds([[sw[1], sw[0]], [ne[1], ne[0]]], { padding });
      return;
    }
    this.map.fitBounds(bounds, { padding });
  },

  fitAllMarkers() {
    if (!this.map || !this.markers.length) return;
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    this.markers.forEach(m => {
      const ll = m.getLngLat();
      if (ll.lng < minLng) minLng = ll.lng;
      if (ll.lat < minLat) minLat = ll.lat;
      if (ll.lng > maxLng) maxLng = ll.lng;
      if (ll.lat > maxLat) maxLat = ll.lat;
    });
    if (!isFinite(minLng)) return;
    this.map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 50, maxZoom: 13 });
  },

  zoomIn()  { if (this.map) this.map.zoomIn(); },
  zoomOut() { if (this.map) this.map.zoomOut(); },

  toggleLayersPanel() {
    const panel = document.getElementById('map-layers-panel');
    if (!panel) return;
    const isOpen = panel.style.display && panel.style.display !== 'none';
    // layout.css has `body[data-view="explore"] .map-layers-panel { display:none !important }`
    // under the mobile media query, so we need !important on the inline style
    // to win when the user explicitly taps the layers button.
    if (isOpen) {
      panel.style.setProperty('display', 'none', 'important');
    } else {
      panel.style.setProperty('display', 'flex', 'important');
    }
  },

  closeLayersPanel() {
    const panel = document.getElementById('map-layers-panel');
    if (panel) panel.style.setProperty('display', 'none', 'important');
  },

  setBasemap(type) {
    if (!this.map || !this.STYLES[type]) return;
    if (State.currentStyle === type) return;
    State.currentStyle = type;
    State.isSatellite = type === 'satellite';
    this.map.setStyle(this.STYLES[type]);
    // style.load handler re-applies overlays.
  },

  toggleSatellite() {
    this.setBasemap(State.isSatellite ? 'street' : 'satellite');
    return State.isSatellite;
  },

  // ─── Public-lands overlay (BLM SMA raster — Federal: BLM/USFS/NPS/FWS) ────
  // Attaches on every style: Outdoors v12 doesn't draw BLM/SMA boundaries.

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

  // ─── State Parks overlay (PAD-US via ArcGIS FeatureServer) ────────────────
  // Same source as the Leaflet version. Polygons render as a translucent
  // blue fill + outline; popups bind to the click-events of the fill layer.

  toggleStateParks() {
    const cb = document.getElementById('layer-stateparks');
    const legend = document.getElementById('stateparks-legend');
    if (cb?.checked) {
      if (legend) legend.style.display = 'block';
      this._ensureStateParksLayer();
      this.loadStateParksInView();
      if (!this._stateParksBound) {
        // Use moveend — state parks aren't tied to Discover's dragend-only rule
        // (which exists because of Overpass rate limits). PAD-US tolerates pans.
        this.map.on('moveend', () => this.loadStateParksInView());
        this._stateParksBound = true;
      }
    } else {
      if (legend) legend.style.display = 'none';
      if (this.map?.getLayer('state-parks-fill'))    this.map.removeLayer('state-parks-fill');
      if (this.map?.getLayer('state-parks-outline')) this.map.removeLayer('state-parks-outline');
      if (this.map?.getSource('state-parks'))        this.map.removeSource('state-parks');
    }
  },

  _ensureStateParksLayer() {
    if (!this.map) return;
    if (this.map.getSource('state-parks')) return;
    this.map.addSource('state-parks', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: Object.values(this._stateParksFeatures) }
    });
    // fill-opacity bumped from 0.05 (Leaflet) to 0.12 because Leaflet's SVG
    // path rendering alpha-stacked overlapping polygons, while Mapbox GL
    // renders a single-pass fill layer with no per-feature compositing.
    this.map.addLayer({
      id: 'state-parks-fill',
      type: 'fill',
      source: 'state-parks',
      paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.12 }
    });
    this.map.addLayer({
      id: 'state-parks-outline',
      type: 'line',
      source: 'state-parks',
      paint: { 'line-color': 'rgba(37,99,235,0.55)', 'line-width': 1.5 }
    });
    this.map.on('click', 'state-parks-fill', (e) => {
      const f = e.features?.[0];
      const name = f?.properties?.Unit_Nm;
      if (!name) return;
      new mapboxgl.Popup({ offset: 4 })
        .setLngLat(e.lngLat)
        .setHTML(`<b>${this.escapeHtml(name)}</b><br>State Park`)
        .addTo(this.map);
    });
  },

  _addStateParksLayerIfEnabled() {
    const cb = document.getElementById('layer-stateparks');
    if (!cb?.checked) return;
    this._ensureStateParksLayer();
  },

  async loadStateParksInView() {
    const cb = document.getElementById('layer-stateparks');
    if (!cb?.checked) return;
    const loading = document.getElementById('stateparks-loading');
    const bounds = this.map.getBounds();
    const zoom = this.map.getZoom();
    if (zoom < 8) {
      if (this.map.getLayer('state-parks-fill'))    this.map.removeLayer('state-parks-fill');
      if (this.map.getLayer('state-parks-outline')) this.map.removeLayer('state-parks-outline');
      if (this.map.getSource('state-parks'))        this.map.removeSource('state-parks');
      return;
    }
    const w = bounds.getWest(), s = bounds.getSouth(), e_ = bounds.getEast(), n = bounds.getNorth();
    const cacheKey = `${w.toFixed(2)},${s.toFixed(2)},${e_.toFixed(2)},${n.toFixed(2)}-${Math.round(zoom)}`;
    if (this._stateParksCache[cacheKey]) return;
    if (loading) loading.style.display = 'inline';
    try {
      const bbox = `${w},${s},${e_},${n}`;
      const where = encodeURIComponent("Mang_Name='SPR' OR Des_Tp='SP'");
      const url = `https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Manager_Name/FeatureServer/0/query?where=${where}&geometry=${encodeURIComponent(bbox)}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&outFields=Unit_Nm,Mang_Name,Des_Tp&returnGeometry=true&f=geojson`;
      const resp = await fetch(url);
      const data = await resp.json();
      this._stateParksCache[cacheKey] = true;
      if (data.features?.length) {
        let added = 0;
        data.features.forEach(f => {
          const key = f.properties?.Unit_Nm || JSON.stringify(f.geometry).slice(0, 64);
          if (!this._stateParksFeatures[key]) {
            this._stateParksFeatures[key] = f;
            added++;
          }
        });
        if (added > 0) {
          this._ensureStateParksLayer();
          const src = this.map.getSource('state-parks');
          if (src) {
            src.setData({ type: 'FeatureCollection', features: Object.values(this._stateParksFeatures) });
          }
        }
      }
    } catch (err) {
      console.error('[MapModule] Error loading state parks:', err);
    }
    if (loading) loading.style.display = 'none';
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

  // Blue dot + translucent ring inside a single element-based Marker.
  // (Leaflet's circleMarker + circle were precise in meters; the ring here
  // is a fixed-pixel visual indicator only.)
  updateUserLocation(lat, lng) {
    if (!this.map) return;
    if (!this.userMarker) {
      const el = document.createElement('div');
      el.className = 'user-location-marker';
      el.innerHTML = `
        <div class="user-location-ring"></div>
        <div class="user-location-dot"></div>
      `;
      this.userMarker = new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat([lng, lat])
        .addTo(this.map);
    } else {
      this.userMarker.setLngLat([lng, lat]);
    }
  },

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
  // ENTRY MARKERS
  // ═══════════════════════════════════════════════════════════════════════════

  renderMarkers() {
    if (!this.map) return;
    this.markers.forEach(m => m.remove());
    this.markers = [];
    State.entries.forEach(entry => {
      if (!entry.lat || !entry.lng) return;
      const marker = this.createMarker(entry);
      marker.addTo(this.map);
      this.markers.push(marker);
    });
    this.updateMarkerCount();
  },

  createMarker(entry) {
    const isSelected = State.selectedEntryId === entry.id;

    const el = document.createElement('div');
    el.className = 'custom-marker';
    el.innerHTML = `<div class="marker-pin ${isSelected ? 'selected' : ''}" style="background: ${this.getMarkerColor(entry)}"></div>`;

    // Mapbox GL toggles a Marker's popup via a click listener on the MAP
    // (not the element), checking whether the click target is inside the
    // marker. stopPropagation kills that path, so we have to toggle the popup
    // ourselves. We still need stopPropagation here — otherwise the map's own
    // click handler runs and the Saved-view deselect path clears the selection
    // we just made.
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      State.selectEntry(entry.id);
      marker.togglePopup();
    });

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
    const popup = new mapboxgl.Popup({
      className: 'custom-popup',
      offset: 18,
      closeButton: true,
      maxWidth: '280px'
    }).setHTML(popupContent);

    const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
      .setLngLat([entry.lng, entry.lat])
      .setPopup(popup);

    marker._entryId = entry.id;
    return marker;
  },

  highlightMarker(id) {
    this.markers.forEach(marker => {
      const entry = State.getEntry(marker._entryId);
      if (!entry) return;
      const pin = marker.getElement().querySelector('.marker-pin');
      if (!pin) return;
      const isSelected = marker._entryId === id;
      pin.classList.toggle('selected', isSelected);
      pin.style.background = this.getMarkerColor(entry);
    });
  },

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
  // DRAG PIN (for Add / Edit form)
  // ═══════════════════════════════════════════════════════════════════════════

  showDragPin(lat, lng, opts = {}) {
    if (this.dragPin) this.dragPin.remove();
    const el = document.createElement('div');
    el.className = 'custom-marker drag-pin';
    el.innerHTML = '<div class="marker-pin" style="background:#c9a45c;border-color:white;width:36px;height:36px"></div>';

    this.dragPin = new mapboxgl.Marker({ element: el, anchor: 'center', draggable: true })
      .setLngLat([lng, lat])
      .addTo(this.map);

    this.dragPin.on('dragend', () => {
      const ll = this.dragPin.getLngLat();
      State.pendingLat = ll.lat;
      State.pendingLng = ll.lng;
      State.emit('dragpin:moved', { lat: ll.lat, lng: ll.lng });
    });

    // Default flyTo for the +Add FAB path (centers the user-location pin in
    // view). The tap-to-add path passes { flyTo: false } so we don't yank the
    // camera away from the spot the user just tapped.
    if (opts.flyTo !== false) this.flyTo(lat, lng, 14);
  },

  hideDragPin() {
    if (this.dragPin) {
      this.dragPin.remove();
      this.dragPin = null;
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DISCOVER MARKERS
  //
  // Two parallel marker layers:
  //   1. discoverMarker  — single gold pin for the active POI detail panel.
  //                        Element-based mapboxgl.Marker; survives setStyle.
  //   2. discoverResultMarkers / discover-results source — the teal "every POI
  //                        in the current results" backdrop. Two render modes:
  //        - cluster=false (Camping, Top Picks, Natural, etc.): flat array of
  //          element-based mapboxgl.Marker.
  //        - cluster=true  (Hiking): native Mapbox GL clustered GeoJSON source
  //          with 3 layers (cluster circles, count text, unclustered points).
  //          Replaces Leaflet.markercluster.
  //
  // Per project_discover_decisions.md, openDetail must NOT recenter the map,
  // so showDiscoverMarker drops a pin but never pans/flies.
  // ═══════════════════════════════════════════════════════════════════════════

  showDiscoverMarker(lat, lng, name) {
    if (this.discoverMarker) this.discoverMarker.remove();
    if (!this.map) return;
    const el = document.createElement('div');
    el.className = 'custom-marker';
    el.innerHTML = '<div class="marker-pin discover"></div>';
    const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
      .setLngLat([lng, lat])
      .addTo(this.map);
    if (name) {
      el.title = name;
      marker.setPopup(new mapboxgl.Popup({ offset: 18, closeButton: true })
        .setHTML(this.escapeHtml(name)));
    }
    this.discoverMarker = marker;
  },

  hideDiscoverMarker() {
    if (this.discoverMarker) {
      this.discoverMarker.remove();
      this.discoverMarker = null;
    }
  },

  showDiscoverResultMarkers(results, onMarkerClick, opts = {}) {
    this.hideDiscoverResultMarkers();
    if (!this.map || !results?.length) return;

    const useCluster = opts.cluster === true;
    this._discoverResultsCluster = useCluster;

    if (useCluster) {
      const fc = {
        type: 'FeatureCollection',
        features: results
          .filter(p => p.lat != null && p.lng != null)
          .map(p => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
            properties: { xid: p.xid, name: p.name || '' }
          }))
      };
      this._discoverResultsData = fc;
      this._discoverResultsOnClick = onMarkerClick;
      this._addDiscoverClusterLayers();
      return;
    }

    // Flat (non-cluster) mode — one mapboxgl.Marker per result.
    results.forEach(p => {
      if (p.lat == null || p.lng == null) return;
      const el = document.createElement('div');
      el.className = 'custom-marker';
      el.innerHTML = '<div class="marker-pin discover-result"></div>';
      if (p.name) el.title = p.name;
      el.addEventListener('click', (e) => {
        // stopPropagation to keep the map's general click handler from
        // running; we still trigger detail-open ourselves below.
        e.stopPropagation();
        if (typeof onMarkerClick === 'function') onMarkerClick(p.xid);
      });
      const m = new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat([p.lng, p.lat])
        .addTo(this.map);
      this.discoverResultMarkers.push(m);
    });
  },

  _addDiscoverClusterLayers() {
    if (!this.map || !this._discoverResultsData) return;
    if (!this.map.getSource('discover-results')) {
      this.map.addSource('discover-results', {
        type: 'geojson',
        data: this._discoverResultsData,
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 50
      });
    } else {
      this.map.getSource('discover-results').setData(this._discoverResultsData);
    }
    if (!this.map.getLayer('discover-clusters')) {
      this.map.addLayer({
        id: 'discover-clusters',
        type: 'circle',
        source: 'discover-results',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#7FC3A5',
          'circle-radius': 18,
          'circle-stroke-width': 2,
          'circle-stroke-color': 'white'
        }
      });
    }
    if (!this.map.getLayer('discover-cluster-count')) {
      this.map.addLayer({
        id: 'discover-cluster-count',
        type: 'symbol',
        source: 'discover-results',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
          'text-size': 12,
          'text-allow-overlap': true
        },
        paint: { 'text-color': 'white' }
      });
    }
    if (!this.map.getLayer('discover-unclustered')) {
      this.map.addLayer({
        id: 'discover-unclustered',
        type: 'circle',
        source: 'discover-results',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': '#7FC3A5',
          'circle-radius': 9,
          'circle-stroke-width': 2,
          'circle-stroke-color': 'white'
        }
      });
    }
    if (!this._discoverClusterHandlersBound) this._bindDiscoverClusterHandlers();
  },

  _bindDiscoverClusterHandlers() {
    const map = this.map;
    if (!map) return;
    map.on('click', 'discover-clusters', (e) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ['discover-clusters'] });
      const clusterId = features[0]?.properties?.cluster_id;
      const src = map.getSource('discover-results');
      if (clusterId == null || !src) return;
      src.getClusterExpansionZoom(clusterId, (err, zoom) => {
        if (err) return;
        map.easeTo({ center: features[0].geometry.coordinates, zoom });
      });
    });
    map.on('click', 'discover-unclustered', (e) => {
      const xid = e.features?.[0]?.properties?.xid;
      if (xid && typeof this._discoverResultsOnClick === 'function') {
        this._discoverResultsOnClick(xid);
      }
    });
    ['discover-clusters', 'discover-unclustered'].forEach(layer => {
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    });
    this._discoverClusterHandlersBound = true;
  },

  hideDiscoverResultMarkers() {
    // Flat mode markers
    this.discoverResultMarkers.forEach(m => { try { m.remove(); } catch (e) {} });
    this.discoverResultMarkers = [];
    // Cluster mode source + layers
    if (this.map) {
      ['discover-unclustered', 'discover-cluster-count', 'discover-clusters'].forEach(id => {
        if (this.map.getLayer(id)) this.map.removeLayer(id);
      });
      if (this.map.getSource('discover-results')) this.map.removeSource('discover-results');
    }
    this._discoverResultsCluster = false;
    this._discoverResultsData = null;
    this._discoverResultsOnClick = null;
    // Layer-scoped click handlers are auto-removed when their layer is gone;
    // we'll re-bind via _bindDiscoverClusterHandlers on the next show.
    this._discoverClusterHandlersBound = false;
  },

  fitDiscoverResultsBounds(padding = 60) {
    if (!this.map) return;
    // Collect coords from whichever mode is active.
    const coords = [];
    if (this._discoverResultsCluster && this._discoverResultsData) {
      this._discoverResultsData.features.forEach(f => coords.push(f.geometry.coordinates));
    } else {
      this.discoverResultMarkers.forEach(m => {
        const ll = m.getLngLat();
        coords.push([ll.lng, ll.lat]);
      });
    }
    if (!coords.length) return;
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    coords.forEach(([lng, lat]) => {
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    });
    this.map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding, maxZoom: 13 });
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ROUTING (REST API preserved; map drawing stubbed until Stage 4)
  // ═══════════════════════════════════════════════════════════════════════════

  async getRoute(from, to) {
    const ORS_API_KEY = (typeof CONFIG !== 'undefined' && CONFIG.ORS_API_KEY)
      || (window.CONFIG && window.CONFIG.ORS_API_KEY)
      || '';
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
    // Drag pin active (Add/Edit form is open): move it to the tapped point.
    if (this.dragPin) {
      this.dragPin.setLngLat(e.lngLat);
      State.pendingLat = e.lngLat.lat;
      State.pendingLng = e.lngLat.lng;
      State.emit('dragpin:moved', { lat: e.lngLat.lat, lng: e.lngLat.lng });
      return;
    }
    // Saved view with an active selection: tap-to-deselect (preserves the
    // v2 behavior; second tap then triggers tap-to-add below).
    if (State.currentView === 'saved' && State.selectedEntryId) {
      State.selectEntry(null);
      this.fitAllMarkers();
      return;
    }
    // Tap-to-add — restored from index_v1.html:1325. Clicking an empty map
    // opens the Add Location modal with the drag pin pre-placed at the tap.
    // Gate on the body-level "drawer open" classes so taps inside Discover or
    // an already-open Add drawer don't trigger a second Add modal.
    const body = document.body;
    if (body.classList.contains('add-location-drawer-open') ||
        body.classList.contains('discover-list-open') ||
        body.classList.contains('discover-detail-open')) return;
    // Only on views where adding makes sense.
    if (State.currentView !== 'saved' && State.currentView !== 'explore') return;
    State.pendingLat = e.lngLat.lat;
    State.pendingLng = e.lngLat.lng;
    if (window.UI?.openAddModal) {
      UI.openAddModal();
      // openAddModal calls showDragPin at the user's GPS location; override
      // here to place the pin where the user actually tapped, and suppress
      // the recenter so the camera stays put.
      this.showDragPin(e.lngLat.lat, e.lngLat.lng, { flyTo: false });
    }
  }
};

window.MapModule = MapModule;
