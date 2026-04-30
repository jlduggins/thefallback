/**
 * The Fallback v2 - Discover Module (Phase 1)
 *
 * Surfaces OSM points-of-interest in two modes:
 *   1) Along the active journey's route polyline (when a journey is active
 *      and at least one leg has routeGeometry).
 *   2) Around the user's GPS location (when no journey is active, or no
 *      route geometry yet).
 *
 * Data source: Overpass API (public OpenStreetMap endpoint, no key required).
 * Why Overpass over OpenTripMap: same OSM data underneath, but no signup,
 * we get the *raw* OSM tags so amenity flags (dump_station, drinking_water,
 * hookups, fee, pets, reservation) come along for free and auto-populate the
 * Entry fields when the user saves.
 *
 * One HTTP request per refresh, unioning every tag selector × every sample
 * point. Overpass dedupes within a union so we don't fan-out concurrency.
 *
 * Phase 2 (NOT implemented here): POI detail panel, reverse-lookup of
 * saved entries near a POI, "Plan around this" leg-injection.
 */
const Discover = {
  // ── State ──────────────────────────────────────────────────────────────
  category: 'all',        // 'all' | 'quirky' | 'historic' | 'natural' | 'cultural' | 'camping'
  results: [],
  expanded: false,
  loading: false,
  error: null,
  mode: null,             // 'route' | 'near' | null  (resolved mode actually used)
  modeChoice: 'auto',     // 'auto' | 'route' | 'near'  (user preference)
  anchorLabel: null,
  _cache: {},             // keyed by `${mode}:${signature}:${category}`
  _inflight: {},

  // OSM tag selectors per chip. Each selector is [key] (presence-only) or
  // [key, value] (exact match). Overpass supports both via the same syntax.
  // Only Camping and Hiking go to Overpass now — Natural/Cultural/Quirky/
  // Historical/Top Picks are served by OpenTripMap (see OTM_KIND_MAP).
  CATEGORY_TAGS: {
    camping: [
      ['tourism','camp_site'],
      ['tourism','caravan_site'],
      ['amenity','sanitary_dump_station'],
      ['amenity','drinking_water']
    ],
    hiking: [
      ['route','hiking'],
      ['route','foot'],
      ['information','trailhead'],
      ['highway','trailhead']
    ]
  },

  // Categories served by OpenTripMap → kinds-string + minimum rate filter.
  // 'top' (Top Picks) cross-cuts; we curate after fetch with a 4★ floor.
  OTM_KIND_MAP: {
    natural:    { kinds: 'natural',                                       rate: 2 },
    cultural:   { kinds: 'cultural,museums,theatres_and_entertainments',  rate: 2 },
    quirky:     { kinds: 'amusements,unclassified_objects,interesting_places', rate: 1 },
    historical: { kinds: 'historic,archaeology',                          rate: 2 },
    top:        { kinds: 'interesting_places,natural,cultural,historic',  rate: 3 }
  },
  OTM_BASE: 'https://api.opentripmap.com/0.1/en',

  // OTM rate string → display 1–5 stars.
  OTM_RATE_TO_STARS: { '1': 1, '2': 2, '2h': 3, '3': 4, '3h': 5, '7': 5 },

  // Categories that come from OTM (used to branch fetch + render style).
  OTM_CATEGORIES: ['natural', 'cultural', 'quirky', 'historical', 'top'],

  // Tile grid order on the Explore page.
  TILE_ORDER: [
    { key: 'top',        label: 'Top Picks',  icon: 'top-picks' },
    { key: 'camping',    label: 'Camping',    icon: 'camping' },
    { key: 'hiking',     label: 'Hiking',     icon: 'hiking' },
    { key: 'natural',    label: 'Natural',    icon: 'natural' },
    { key: 'cultural',   label: 'Cultural',   icon: 'cultural' },
    { key: 'quirky',     label: 'Quirky',     icon: 'quirky' },
    { key: 'historical', label: 'Historical', icon: 'historical' }
  ],

  // Approx point sampling along a route. Smaller = denser sampling = more
  // POIs found along windy roads, but bigger query payload.
  SAMPLE_EVERY_MI: 12,
  ROUTE_RADIUS_M: 8000,    // ~5 mi window around each sample point
  NEAR_RADIUS_M: 48000,    // ~30 mi around user GPS in "near" mode
  MAX_SAMPLES: 12,         // cap for the union to keep query body sane
  MAX_SAMPLES_HIKING: 6,   // tighter cap for hiking (was the slowest path)
  OVERPASS_TIMEOUT_HIKING: 30, // seconds, was 60 — fail fast for trails
  OTM_RADIUS_M: 80000,     // ~50 mi for OTM searches (radius API)
  OTM_LIMIT: 30,           // OTM list-endpoint result cap before curation
  TOP_PICKS_LIMIT: 6,      // hero cards shown on Top Picks
  MAX_RESULTS: 30,         // hard cap from Overpass-side dedupe
  INITIAL_COUNT: 10,       // visible on first render
  PAGE_INCREMENT: 10,      // added per "Show more" click
  _visibleCount: 10,       // current display window; reset on category/mode change
  _wikiCache: {},          // wiki tag → { extract, thumbnail, url } | null
  _wikidataCache: {},      // qid → { image, officialWebsite, description, inception } | null
  _otmDetailCache: {},     // OTM xid → detail-endpoint payload | null

  // Overpass mirrors tried in order — each has independent rate limits, so
  // when the main endpoint returns 429/504 we silently fall through to the
  // next. All three accept the same Overpass-QL syntax.
  OVERPASS_MIRRORS: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ],

  // localStorage TTL for cached results. POIs barely change, so a week is
  // comfortable. Keyed by `${modeChoice}:${mode}:${signature}:${cat}`.
  CACHE_TTL_MS: 7 * 86400 * 1000,
  // Prefix is versioned — bump it (v2 → v3) any time the POI shape changes
  // in a way that would make old cached results wrong. Init() cleans up keys
  // with older prefixes so they don't sit in localStorage forever.
  CACHE_PREFIX: 'fb-disc-v3-',
  CACHE_OLD_PREFIXES: ['fb-disc-', 'fb-disc-v2-'],
  // Separate prefix for OTM cache — different shape than Overpass results.
  OTM_CACHE_PREFIX: 'fb-disc-otm-v1-',
  // localStorage key for the user-picked manual search anchor.
  MANUAL_ANCHOR_KEY: 'fb-disc-manual-anchor',

  // ── Init ───────────────────────────────────────────────────────────────
  init() {
    // One-shot cleanup of localStorage keys written by older cache schemas.
    // Cheap (string scan, no parsing). Runs once on app boot per session.
    try {
      const drop = [];
      const keep = [this.CACHE_PREFIX, this.OTM_CACHE_PREFIX, this.MANUAL_ANCHOR_KEY];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && this.CACHE_OLD_PREFIXES.some(p => k.startsWith(p) && !keep.some(kp => k.startsWith(kp)))) {
          drop.push(k);
        }
      }
      drop.forEach(k => localStorage.removeItem(k));
    } catch (e) { /* localStorage unavailable; skip silently */ }

    // Restore the user-picked manual search anchor (if any) before first render.
    this._loadManualAnchor();

    // Discover does NOT auto-fire any more. The Explore page just shows the
    // category tile grid; results are only fetched when the user opens the
    // modal via Discover.openModal(category). Keep render() listeners so the
    // saved-badge state on cards stays current, but never call refresh() from
    // a state event.
    State.on('entries:changed',  () => this.render());
    State.on('journeys:changed', () => this.render());
    State.on('view:changed', ({ from, to }) => {
      // Close the detail panel when the user navigates away from Explore so it
      // doesn't sit on top of unrelated views.
      if (from === 'explore' && to !== 'explore') this.closeDetail();
    });
    this.render();
  },

  setCategory(cat) {
    if (this.category === cat) return;
    this.category = cat;
    this.expanded = false;
    this._visibleCount = this.INITIAL_COUNT;
    this.refresh();
  },

  // User-controlled mode toggle: 'auto' | 'route' | 'near'.
  // 'auto'  → route if a future leg with geometry exists, else nearby
  // 'route' → force along-route (future legs only); falls back to nearby if none
  // 'near'  → force user GPS within backupRadius
  setModeChoice(choice) {
    if (!['auto', 'route', 'near'].includes(choice)) return;
    if (this.modeChoice === choice) return;
    this.modeChoice = choice;
    this.expanded = false;
    this._visibleCount = this.INITIAL_COUNT;
    this.refresh();
  },

  retry() {
    // Wipe the error so render() doesn't bounce into the error state again,
    // and clear any in-memory cache for the failed key (the persistent cache
    // wasn't written on failure). Then re-trigger the fetch.
    if (this._lastFailedKey) delete this._cache[this._lastFailedKey];
    this.error = null;
    this.errorType = null;
    this._lastFailedKey = null;
    this.refresh();
  },

  toggleExpanded() {
    this.expanded = !this.expanded;
    this.render();
  },

  // Fold/unfold the entire Discover section to give Nearby the full column.
  toggleCollapsed() {
    this.collapsed = !this.collapsed;
    const wrap = document.getElementById('discover-wrap');
    if (wrap) wrap.classList.toggle('collapsed', !!this.collapsed);
  },

  // ── Anchor selection: manual > route > near > none ─────────────────────
  // Honors `modeChoice`, but a manual anchor (user picked a city or dropped
  // a pin) overrides everything below — that's the "always available" option
  // for trip planning from elsewhere. Route mode samples ONLY future legs
  // (using jctx.nextLegIndex) so finishing your last stop doesn't drag in
  // POIs 100+ mi behind you.
  _resolveAnchor() {
    // 1. Manual anchor wins.
    if (this._manualAnchor && this._manualAnchor.lat != null && this._manualAnchor.lng != null) {
      const radiusMi = (State.fuelSettings && State.fuelSettings.backupRadius) || 30;
      const radiusM = Math.round(radiusMi * 1609);
      const sig = `M:${this._manualAnchor.lat.toFixed(2)},${this._manualAnchor.lng.toFixed(2)}:${radiusMi}`;
      return {
        mode: 'manual',
        samples: [{ lat: this._manualAnchor.lat, lng: this._manualAnchor.lng }],
        radiusM,
        signature: sig,
        label: this._manualAnchor.label
          ? `From ${this._manualAnchor.label}`
          : 'Custom area',
        journey: null
      };
    }

    const journey = State.currentJourneyId ? State.getJourney(State.currentJourneyId) : null;
    const legs = journey?.legs || [];
    const jctx = (journey && State.getJourneyContext)
      ? State.getJourneyContext(journey)
      : { nextLegIndex: -1 };

    // Future legs only — past route is irrelevant for discovery.
    const futureLegs = (jctx.nextLegIndex >= 0)
      ? legs.slice(jctx.nextLegIndex)
      : [];
    const futureWithGeom = futureLegs.filter(l => !!l.routeGeometry);

    const wantRoute = this.modeChoice === 'route'
      || (this.modeChoice === 'auto' && futureWithGeom.length > 0);

    if (wantRoute && futureWithGeom.length) {
      let samples = [];
      let routeSig = '';
      for (const l of futureWithGeom) {
        let coords = null;
        try { coords = JSON.parse(l.routeGeometry); } catch { coords = null; }
        if (!Array.isArray(coords) || coords.length < 2) continue;
        const pts = this._sampleAlong(coords, this.SAMPLE_EVERY_MI);
        samples = samples.concat(pts);
        routeSig += `${l.fromId || ''}>${l.destId || ''}|`;
      }
      if (samples.length) {
        const jName = journey?.name ? `Along trip "${journey.name}"` : 'Along your trip';
        return {
          mode: 'route',
          samples: samples.slice(0, this.MAX_SAMPLES),
          radiusM: this.ROUTE_RADIUS_M,
          signature: routeSig + samples.length,
          label: jName,
          journey
        };
      }
    }

    // Nearby mode: anchor at user GPS, use backupRadius (same setting as
    // Nearby Spots) so the two sections cover the same search range.
    const radiusMi = (State.fuelSettings && State.fuelSettings.backupRadius) || 30;
    const radiusM = Math.round(radiusMi * 1609);
    if (State.userLat != null && State.userLng != null) {
      const sig = `${State.userLat.toFixed(2)},${State.userLng.toFixed(2)}:${radiusMi}`;
      return {
        mode: 'near',
        samples: [{ lat: State.userLat, lng: State.userLng }],
        radiusM,
        signature: sig,
        label: `nearby (${radiusMi} mi)`,
        journey: null
      };
    }

    return { mode: null, samples: [], signature: '', label: null, journey: null };
  },

  // ── Manual search anchor (always-available override) ──────────────────
  // Set by the user from the Discover modal anchor picker — either by
  // dropping a pin on the map or entering a city. Wins over GPS / route in
  // _resolveAnchor(). Persisted to localStorage so it survives reload.
  _manualAnchor: null,

  _setManualAnchor(lat, lng, label) {
    if (lat == null || lng == null) return;
    this._manualAnchor = { lat, lng, label: label || null };
    State._discoverManualAnchor = this._manualAnchor;
    this._persistManualAnchor();
    if (this._modalOpen) this.refresh();
    else this.render();
  },

  _clearManualAnchor() {
    this._manualAnchor = null;
    State._discoverManualAnchor = null;
    try { localStorage.removeItem(this.MANUAL_ANCHOR_KEY); }
    catch (e) { /* ignore */ }
    if (this._modalOpen) this.refresh();
    else this.render();
  },

  _persistManualAnchor() {
    if (!this._manualAnchor) return;
    try {
      localStorage.setItem(this.MANUAL_ANCHOR_KEY, JSON.stringify(this._manualAnchor));
    } catch (e) { /* ignore quota */ }
  },

  _loadManualAnchor() {
    try {
      const raw = localStorage.getItem(this.MANUAL_ANCHOR_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (obj && obj.lat != null && obj.lng != null) {
        this._manualAnchor = obj;
        State._discoverManualAnchor = obj;
      }
    } catch (e) { /* ignore */ }
  },

  // routeGeometry is GeoJSON [[lng,lat], ...]. Sample one point every
  // ~stepMi miles so the API search blanket covers the route uniformly.
  _sampleAlong(coords, stepMi) {
    if (!coords?.length) return [];
    const out = [{ lat: coords[0][1], lng: coords[0][0] }];
    let acc = 0;
    for (let i = 1; i < coords.length; i++) {
      const [lng1, lat1] = coords[i - 1];
      const [lng2, lat2] = coords[i];
      acc += this._haversine(lat1, lng1, lat2, lng2);
      if (acc >= stepMi) {
        out.push({ lat: lat2, lng: lng2 });
        acc = 0;
      }
    }
    const last = coords[coords.length - 1];
    out.push({ lat: last[1], lng: last[0] });
    return out;
  },

  _haversine(lat1, lng1, lat2, lng2) {
    const R = 3958.8;
    const dl = (lat2 - lat1) * Math.PI / 180;
    const dn = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dl / 2) ** 2
            + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
            * Math.sin(dn / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  // ── Refresh: pull from cache or call Overpass / OpenTripMap ────────────
  // Only fetches when the modal is open OR being opened. The Explore tile
  // grid never triggers a fetch — the user has to tap a tile first. This
  // is the linchpin of the auto-fetch removal: every `refresh()` call from
  // the old wiring is now a no-op as long as the modal is closed.
  async refresh() {
    const a = this._resolveAnchor();
    this.mode = a.mode;
    this.anchorLabel = a.label;

    // Always re-render so the modal header and tile-grid badges reflect the
    // current anchor — even if we're not going to fetch.
    if (!this._modalOpen) {
      this.render();
      return;
    }

    if (!a.mode) {
      this.results = [];
      this.error = null;
      this.loading = false;
      this.render();
      return;
    }

    const cacheNs = this.OTM_CATEGORIES.includes(this.category) ? 'otm' : 'osm';
    const key = `${cacheNs}:${a.mode}:${a.signature}:${this.category}`;

    // In-memory cache (fastest) → localStorage cache (survives reload).
    if (this._cache[key]) {
      this.results = this._cache[key];
      this.loading = false;
      this.error = null;
      this.render();
      if (this.results.some(p => p._approx)) this._refreshDrivingDistances(a, this.results);
      return;
    }
    const persisted = this._persistRead(key);
    if (persisted) {
      this._cache[key] = persisted;
      this.results = persisted;
      this.loading = false;
      this.error = null;
      this.render();
      if (this.results.some(p => p._approx)) this._refreshDrivingDistances(a, this.results);
      return;
    }

    if (this._inflight[key]) return;
    this._inflight[key] = true;
    this.loading = true;
    this.error = null;
    this.errorType = null;
    this._lastFailedKey = null;
    this.render();

    try {
      const pois = await this._fetchPOIs(a);
      this._cache[key] = pois;
      this._persistWrite(key, pois);
      this.results = pois;
      this.error = null;
      this.errorType = null;
      this._refreshDrivingDistances(a, pois);
    } catch (e) {
      console.error('[Discover] fetch failed:', e);
      // Typed errors from _overpassQuery — render() shows different UI per type.
      this.errorType = e.type || 'network';
      this.error = e.message || 'Fetch failed';
      this._lastFailedKey = key;
      this.results = [];
    } finally {
      this.loading = false;
      delete this._inflight[key];
      this.render();
    }
  },

  // Top-level dispatcher: routes Camping/Hiking to Overpass and the rest to
  // OpenTripMap. Both paths return the same normalized POI shape so the rest
  // of the module (cache, render, detail panel, save flow) doesn't care.
  async _fetchPOIs(anchor) {
    if (this.OTM_CATEGORIES.includes(this.category)) {
      return this._fetchOTM(anchor);
    }
    return this._fetchOverpass(anchor);
  },

  // Build one Overpass QL query that unions every tag selector × every
  // sample point. Single POST, no concurrency fan-out. Returns deduped POIs.
  async _fetchOverpass(anchor) {
    const tagSelectors = this.CATEGORY_TAGS[this.category];
    if (!tagSelectors) return [];
    // Hiking gets a tighter sample cap — most users were waiting 30s+ on
    // route-mode hiking before this. 6 samples × 4 selectors = 24 nwr lines,
    // well under Overpass's payload limits.
    const sampleCap = this.category === 'hiking' ? this.MAX_SAMPLES_HIKING : this.MAX_SAMPLES;
    const samples = anchor.samples.slice(0, sampleCap);
    const timeout = this.category === 'hiking' ? this.OVERPASS_TIMEOUT_HIKING : 60;

    let body = `[out:json][timeout:${timeout}];(\n`;
    for (const s of samples) {
      for (const sel of tagSelectors) {
        // sel can be: raw Overpass string (e.g. '["highway"="path"]["name"]'),
        // 1-tuple ['key'] (presence), or 2-tuple ['key','value'] (exact).
        const filter = typeof sel === 'string' ? sel
          : sel.length === 1 ? `["${sel[0]}"]`
          : `["${sel[0]}"="${sel[1]}"]`;
        // `nwr` = node + way + relation in one go.
        body += `nwr${filter}(around:${anchor.radiusM},${s.lat},${s.lng});\n`;
      }
    }
    body += ');\nout center tags 250;';

    const data = await this._overpassQuery(body);

    const seen = new Map();
    const refLat = State.userLat ?? anchor.samples[0].lat;
    const refLng = State.userLng ?? anchor.samples[0].lng;
    for (const el of data.elements) {
      // Nodes carry lat/lon directly; ways and relations carry center.lat/lon
      // because we asked for `out center`.
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (lat == null || lng == null) continue;
      const tags = el.tags || {};
      // Names: prefer the OSM name, then operator. For unnamed utility POIs
      // (dump/water), only synthesize a generic label when there's an explicit
      // public-access signal — otherwise we surface random outdoor spigots on
      // private residences (the "Water Fill-up" junk problem).
      let name = tags.name || tags.operator;
      if (!name) {
        const looksPublic = tags.access === 'yes'
          || tags.access === 'public'
          || tags.access === 'permissive'
          || tags.fee === 'no'
          || tags.tourism === 'camp_site'
          || tags.tourism === 'caravan_site';
        if (looksPublic) {
          if (tags.amenity === 'sanitary_dump_station') name = 'Dump Station';
          else if (tags.amenity === 'drinking_water') name = 'Water Fill-up';
        }
      }
      if (!name) continue;
      const xid = `${el.type}/${el.id}`;
      if (seen.has(xid)) continue;
      seen.set(xid, {
        xid,
        name,
        tags,
        category: this._classify(tags),
        badges: this._badges(tags),
        lat,
        lng,
        distance: this._haversine(refLat, refLng, lat, lng),
        // Distance starts as straight-line; _refreshDrivingDistances replaces
        // with real driving miles from ORS Matrix and flips _approx → false.
        _approx: true
      });
    }
    // Second-pass dedupe by normalized name. A single trail like "Watson Falls
    // Trail #1496" can come back as a relation (route=hiking) AND multiple way
    // segments (highway=path with the same name) — different xids, so the
    // first-pass dedupe keeps them all. Collapse those, keeping the entry
    // closest to the user.
    const byName = new Map();
    for (const p of seen.values()) {
      const key = (p.name || '').toLowerCase().trim();
      if (!key) continue;
      const existing = byName.get(key);
      if (!existing || p.distance < existing.distance) byName.set(key, p);
    }
    return [...byName.values()]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, this.MAX_RESULTS);
  },

  // ── Overpass with mirror fallback + typed errors ───────────────────────
  // Tries each mirror in order. 429/504 → next mirror (rate-limited). Network
  // errors → next mirror. If all mirrors fail, throws an error tagged with
  // .type so render() can show appropriate UI ('busy' vs 'network').
  async _overpassQuery(body) {
    let lastErr;
    for (const url of this.OVERPASS_MIRRORS) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(body)
        });
        if (r.status === 429 || r.status === 504) {
          lastErr = Object.assign(new Error('Overpass busy ' + r.status), { type: 'busy' });
          continue;
        }
        if (!r.ok) {
          lastErr = Object.assign(new Error('Overpass HTTP ' + r.status), { type: 'network' });
          continue;
        }
        const data = await r.json();
        if (!Array.isArray(data.elements)) {
          lastErr = Object.assign(new Error('Overpass: unexpected response'), { type: 'network' });
          continue;
        }
        return data;
      } catch (e) {
        lastErr = e;
        if (!lastErr.type) lastErr.type = navigator.onLine ? 'network' : 'offline';
      }
    }
    throw lastErr || Object.assign(new Error('All Overpass mirrors failed'), { type: 'network' });
  },

  // ── OpenTripMap fetch + normalization ──────────────────────────────────
  // For Natural / Cultural / Quirky / Historical / Top Picks. One radius call
  // per sample point (route mode) or one call total (near/manual). OTM has
  // cleaner data than Overpass for tourist-style POIs and ships back popularity
  // ratings, Wikidata/Wikipedia IDs, preview images, and structured addresses.
  async _fetchOTM(anchor) {
    const apiKey = (typeof CONFIG !== 'undefined' && CONFIG.OPENTRIPMAP_KEY)
      || window.CONFIG?.OPENTRIPMAP_KEY;
    if (!apiKey || apiKey === 'YOUR_OPENTRIPMAP_KEY') {
      throw Object.assign(new Error('OpenTripMap API key not configured'), { type: 'network' });
    }
    const cfg = this.OTM_KIND_MAP[this.category];
    if (!cfg) return [];

    // Cap samples to keep request count reasonable. Top Picks always uses a
    // single anchor (broader radius) so we sweep the area uniformly.
    const samples = this.category === 'top'
      ? anchor.samples.slice(0, 1)
      : anchor.samples.slice(0, 4);
    const radius = anchor.mode === 'route' ? this.ROUTE_RADIUS_M : this.OTM_RADIUS_M;
    const limit = this.category === 'top' ? this.OTM_LIMIT : this.OTM_LIMIT;

    // One list call per sample, run in parallel.
    const lists = await Promise.all(samples.map(async (s) => {
      const url = `${this.OTM_BASE}/places/radius`
        + `?radius=${radius}`
        + `&lon=${s.lng}&lat=${s.lat}`
        + `&kinds=${encodeURIComponent(cfg.kinds)}`
        + `&rate=${cfg.rate}`
        + `&format=json&limit=${limit}`
        + `&apikey=${encodeURIComponent(apiKey)}`;
      try {
        const r = await fetch(url);
        if (r.status === 401 || r.status === 403) {
          throw Object.assign(new Error('OTM auth failed'), { type: 'network' });
        }
        if (r.status === 429) {
          throw Object.assign(new Error('OTM rate-limited'), { type: 'busy' });
        }
        if (!r.ok) {
          throw Object.assign(new Error('OTM HTTP ' + r.status), { type: 'network' });
        }
        const data = await r.json();
        return Array.isArray(data) ? data : [];
      } catch (e) {
        if (!e.type) e.type = navigator.onLine ? 'network' : 'offline';
        throw e;
      }
    }));

    // Flatten + dedupe by xid.
    const seen = new Map();
    const refLat = State.userLat ?? anchor.samples[0].lat;
    const refLng = State.userLng ?? anchor.samples[0].lng;
    for (const list of lists) {
      for (const raw of list) {
        if (!raw.xid || !raw.name) continue;
        const xid = 'otm:' + raw.xid;
        if (seen.has(xid)) continue;
        const lat = raw.point?.lat;
        const lng = raw.point?.lon;
        if (lat == null || lng == null) continue;
        seen.set(xid, this._normalizeOTM(raw, refLat, refLng));
      }
    }

    let results = [...seen.values()];

    // Top Picks: keep only 4★ or 5★ (display scale), sort by stars desc then
    // distance asc, take top N.
    if (this.category === 'top') {
      results = results
        .filter(p => (p.stars || 0) >= 4)
        .sort((a, b) => (b.stars || 0) - (a.stars || 0) || a.distance - b.distance)
        .slice(0, this.TOP_PICKS_LIMIT);
    } else {
      // Other OTM categories: sort by stars desc, distance asc.
      results.sort((a, b) => (b.stars || 0) - (a.stars || 0) || a.distance - b.distance);
      results = results.slice(0, this.MAX_RESULTS);
    }

    return results;
  },

  // Normalize an OTM list-endpoint POI into the same internal shape as
  // Overpass POIs, so the rest of the module is source-agnostic.
  _normalizeOTM(raw, refLat, refLng) {
    const lat = raw.point.lat;
    const lng = raw.point.lon;
    const kindsCsv = raw.kinds || '';
    const stars = this._otmRateToStars(raw.rate);
    return {
      xid: 'otm:' + raw.xid,
      name: raw.name,
      lat, lng,
      // Internal display category derived from OTM kinds — used for the
      // category badge on hero cards.
      category: this._otmCategoryFromKinds(kindsCsv),
      // Synthetic tags so existing badge / classify logic finds nothing
      // OSM-shaped to read but won't crash. Real OTM detail is loaded on
      // openDetail() and merged in.
      tags: { otm_kinds: kindsCsv, otm_rate: raw.rate || '' },
      badges: [],
      distance: this._haversine(refLat, refLng, lat, lng),
      _approx: true,
      _otm: true,
      stars,
      // Filled in by detail-endpoint fetch on openDetail():
      images: [],
      wikidata: null,
      wikipedia: null,
      address: null,
      description: null
    };
  },

  // OTM rate strings include the half-tier "h" suffix ("2h", "3h") and a
  // special 7 for UNESCO heritage. Map all → 1–5 display stars.
  _otmRateToStars(rate) {
    if (rate == null) return 0;
    const key = String(rate);
    return this.OTM_RATE_TO_STARS[key] != null ? this.OTM_RATE_TO_STARS[key] : 0;
  },

  // Map OTM `kinds` CSV → human-readable category label for the badge.
  // OTM tags POIs with multiple kinds; pick the first family that matches.
  _otmCategoryFromKinds(csv) {
    if (!csv) return 'Place';
    const tokens = csv.split(',');
    const has = (t) => tokens.includes(t);
    if (has('historic') || has('archaeology') || has('history')) return 'Historic';
    if (has('museums') || has('cultural') || has('theatres_and_entertainments')) return 'Cultural';
    if (has('amusements') || has('unclassified_objects')) return 'Quirky';
    if (has('natural') || has('geological_formations') || has('mountain_peaks')
        || has('waterfalls') || has('caves') || has('glaciers')
        || has('nature_reserves')) return 'Natural';
    if (has('interesting_places')) return 'Place';
    return 'Place';
  },

  // Lazy detail enrichment for an OTM POI — calls /xid/{xid} and merges the
  // returned image, wikidata, wikipedia, description, and address fields back
  // into the POI object. Cached in _otmDetailCache so reopens are free.
  async _loadOTMDetail(poi) {
    if (!poi || !poi._otm) return null;
    const rawXid = poi.xid.replace(/^otm:/, '');
    if (this._otmDetailCache[rawXid] !== undefined) return this._otmDetailCache[rawXid];
    const apiKey = (typeof CONFIG !== 'undefined' && CONFIG.OPENTRIPMAP_KEY)
      || window.CONFIG?.OPENTRIPMAP_KEY;
    if (!apiKey || apiKey === 'YOUR_OPENTRIPMAP_KEY') {
      this._otmDetailCache[rawXid] = null;
      return null;
    }
    try {
      const url = `${this.OTM_BASE}/places/xid/${encodeURIComponent(rawXid)}?apikey=${encodeURIComponent(apiKey)}`;
      const r = await fetch(url);
      if (!r.ok) { this._otmDetailCache[rawXid] = null; return null; }
      const d = await r.json();
      // Build images array: preview thumbnail first, then full-size if distinct.
      const imgs = [];
      const preview = d.preview?.source;
      const full = d.image;
      if (preview) imgs.push(preview);
      if (full && full !== preview) imgs.push(full);
      // Merge structured fields onto the POI so downstream rendering finds them.
      poi.images = imgs;
      poi.wikidata = d.wikidata || null;
      poi.wikipedia = d.wikipedia || null;
      poi.description = d.wikipedia_extracts?.text || d.info?.descr || null;
      poi.address = d.address || null;
      this._otmDetailCache[rawXid] = d;
      return d;
    } catch (e) {
      console.warn('[Discover] OTM detail fetch failed:', e);
      this._otmDetailCache[rawXid] = null;
      return null;
    }
  },

  // ── Persistent cache (localStorage with TTL) ──────────────────────────
  // Survives page reloads. Same key shape as the in-memory _cache. The cache
  // namespace prefix differs by source (Overpass vs OTM) since the POI shape
  // differs slightly. On write, if the quota is exceeded, prunes expired +
  // oldest half and retries.
  _cachePrefixFor(key) {
    return key.startsWith('otm:') ? this.OTM_CACHE_PREFIX : this.CACHE_PREFIX;
  },
  _persistRead(key) {
    try {
      const prefix = this._cachePrefixFor(key);
      const raw = localStorage.getItem(prefix + key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj.expires || obj.expires < Date.now()) {
        localStorage.removeItem(prefix + key);
        return null;
      }
      return obj.data;
    } catch (e) {
      return null;
    }
  },
  _persistWrite(key, data) {
    const obj = { expires: Date.now() + this.CACHE_TTL_MS, data };
    let json;
    try { json = JSON.stringify(obj); } catch { return; }
    const prefix = this._cachePrefixFor(key);
    try {
      localStorage.setItem(prefix + key, json);
    } catch (e) {
      this._prunePersisted();
      try { localStorage.setItem(prefix + key, json); }
      catch (e2) { console.warn('[Discover] persist failed after prune:', e2); }
    }
  },
  _prunePersisted() {
    const now = Date.now();
    const ours = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(this.CACHE_PREFIX) || k.startsWith(this.OTM_CACHE_PREFIX))) ours.push(k);
    }
    // Drop expired first.
    let removed = 0;
    const survivors = [];
    ours.forEach(k => {
      try {
        const obj = JSON.parse(localStorage.getItem(k) || '{}');
        if (!obj.expires || obj.expires < now) {
          localStorage.removeItem(k);
          removed++;
        } else {
          survivors.push({ k, expires: obj.expires });
        }
      } catch { localStorage.removeItem(k); removed++; }
    });
    // If still tight, evict oldest half of survivors.
    if (removed < 3 && survivors.length) {
      survivors.sort((a, b) => a.expires - b.expires);
      survivors.slice(0, Math.ceil(survivors.length / 2)).forEach(({ k }) => localStorage.removeItem(k));
    }
  },

  // ── Wikidata enrichment ───────────────────────────────────────────────
  // Many OSM POIs carry a `wikidata=Q12345` tag. Wikidata returns structured
  // facts the OSM tags don't: image (Commons), official website, inception
  // date, and a short English description. Free, anonymous CORS via origin=*.
  async _loadWikidata(qid) {
    if (!qid) return null;
    if (this._wikidataCache[qid] !== undefined) return this._wikidataCache[qid];
    try {
      const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(qid)}&props=claims%7Cdescriptions&languages=en&format=json&origin=*`;
      const r = await fetch(url);
      if (!r.ok) { this._wikidataCache[qid] = null; return null; }
      const data = await r.json();
      const ent = data.entities?.[qid];
      if (!ent) { this._wikidataCache[qid] = null; return null; }
      const claim = (prop) => ent.claims?.[prop]?.[0]?.mainsnak?.datavalue?.value;
      const imageFile = claim('P18');
      const officialSite = claim('P856');
      const inceptionRaw = claim('P571')?.time;
      const out = {
        description: ent.descriptions?.en?.value || null,
        // Commons file URL — Special:FilePath redirects to the actual image
        // at the requested width. No filename URL-encoding edge cases.
        image: imageFile ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(imageFile)}?width=600` : null,
        officialWebsite: officialSite || null,
        // Inception times look like "+1856-01-01T00:00:00Z" — extract year.
        inception: inceptionRaw ? inceptionRaw.replace(/^\+/, '').slice(0, 4) : null
      };
      this._wikidataCache[qid] = out;
      return out;
    } catch (e) {
      console.warn('[Discover] wikidata fetch failed:', e);
      this._wikidataCache[qid] = null;
      return null;
    }
  },

  // ── Reverse geocode (lazy, on detail open) ─────────────────────────────
  // Many OSM POIs only carry coords — no addr:city / addr:state tags. To make
  // the Google "Look up" query useful (and the detail subline informative),
  // ask Nominatim for the closest containing city/state. Cached on the POI
  // object so repeat opens skip the network. Nominatim usage policy: 1 req/s
  // and a real User-Agent — fine for personal-app traffic.
  async _reverseGeocode(poi) {
    if (poi._reverseAddr !== undefined) return poi._reverseAddr;
    if (poi.lat == null || poi.lng == null) { poi._reverseAddr = null; return null; }
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${poi.lat}&lon=${poi.lng}&zoom=10&addressdetails=1`;
      const r = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      if (!r.ok) { poi._reverseAddr = null; return null; }
      const data = await r.json();
      const a = data.address || {};
      poi._reverseAddr = {
        city: a.city || a.town || a.village || a.hamlet || a.municipality || null,
        state: a.state || null,
        country: a.country || null
      };
      return poi._reverseAddr;
    } catch (e) {
      console.warn('[Discover] reverse geocode failed:', e);
      poi._reverseAddr = null;
      return null;
    }
  },

  // OSM tag → human-readable type label
  _classify(tags) {
    if (tags.route === 'hiking') return 'Hiking Trail';
    if (tags.route === 'foot') return 'Footpath';
    if (tags.information === 'trailhead' || tags.highway === 'trailhead') return 'Trailhead';
    if (tags.highway === 'path' || tags.highway === 'footway') return 'Trail';
    if (tags.tourism === 'camp_site' || tags.tourism === 'caravan_site') return 'Campground';
    if (tags.amenity === 'sanitary_dump_station') return 'Dump Station';
    if (tags.amenity === 'drinking_water') return 'Water Fill';
    if (tags.tourism === 'museum') return 'Museum';
    if (tags.tourism === 'gallery') return 'Gallery';
    if (tags.tourism === 'viewpoint') return 'Viewpoint';
    if (tags.tourism === 'artwork') return 'Artwork';
    if (tags.tourism === 'attraction') return 'Attraction';
    if (tags.historic === 'memorial') return 'Memorial';
    if (tags.historic === 'monument') return 'Monument';
    if (tags.historic === 'ruins') return 'Ruins';
    if (tags.historic === 'archaeological_site') return 'Archaeological';
    if (tags.historic) return 'Historic';
    if (tags.natural === 'peak') return 'Peak';
    if (tags.natural === 'waterfall') return 'Waterfall';
    if (tags.natural === 'cave_entrance') return 'Cave';
    if (tags.natural === 'spring' || tags.natural === 'hot_spring') return 'Spring';
    if (tags.leisure === 'nature_reserve') return 'Nature Reserve';
    if (tags.boundary === 'national_park') return 'National Park';
    if (tags.amenity === 'theatre') return 'Theatre';
    if (tags.amenity === 'arts_centre') return 'Arts Centre';
    if (tags.amenity === 'planetarium') return 'Planetarium';
    if (tags.amenity === 'fountain') return 'Fountain';
    if (tags.man_made === 'lighthouse') return 'Lighthouse';
    if (tags.man_made === 'tower') return 'Tower';
    return 'Place';
  },

  // Vanlife-relevant amenity badges derived from OSM tags. Drives the small
  // pill row under each card name and (on save) auto-fills Entry fields.
  _badges(tags) {
    const out = [];
    if (tags.fee === 'no') out.push({ label: 'Free', kind: 'good' });
    else if (tags['fee:amount']) out.push({ label: '$' + tags['fee:amount'], kind: 'cost' });
    if (tags.sanitary_dump_station === 'yes' || tags.amenity === 'sanitary_dump_station')
      out.push({ label: 'Dump', kind: 'good' });
    if (tags.drinking_water === 'yes' || tags.amenity === 'drinking_water')
      out.push({ label: 'Water', kind: 'good' });
    if (tags.shower === 'yes') out.push({ label: 'Showers', kind: 'good' });
    if (tags.toilets === 'yes') out.push({ label: 'Restrooms', kind: 'good' });
    if (tags.power_supply === 'yes') out.push({ label: 'Hookups', kind: 'good' });
    if (tags.dog === 'yes') out.push({ label: 'Pets OK', kind: 'good' });
    if (tags.reservation === 'required') out.push({ label: 'Reservation', kind: 'warn' });
    if (tags.wheelchair === 'yes') out.push({ label: 'Accessible', kind: 'neutral' });
    return out;
  },

  // ── Open Add Location form pre-filled with POI data ──────────────────
  savePOI(xid) {
    const poi = this.results.find(p => p.xid === xid);
    if (!poi) return;
    if (!window.Firebase?.getUserId?.()) {
      if (window.UI?.showToast) UI.showToast('Sign in to save locations', 'error');
      return;
    }
    // Close detail panel first (add-location CSS hides it anyway, but clean up
    // the body class so the panel doesn't reappear if the user cancels)
    this.closeDetail();
    Entries.openFromDiscover(poi);
  },

  // Rough match: same xid OR same name AND within ~0.3 mi. Lets the card
  // show "Saved" without needing a perfect coord match.
  _alreadySaved(poi) {
    if (!poi) return null;
    const tol = 0.005;
    return State.entries.find(e =>
      e.lat != null && e.lng != null
      && (e.sourceXid === poi.xid
          || (Math.abs(e.lat - poi.lat) < tol
              && Math.abs(e.lng - poi.lng) < tol
              && (e.name || '').toLowerCase() === (poi.name || '').toLowerCase()))
    ) || null;
  },

  // ── Async upgrade haversine → ORS driving distance ─────────────────────
  // Initial POIs carry straight-line distance flagged `_approx: true`. This
  // calls Trips.getRouteMatrix (one ORS request, up to 48 dests) to replace
  // them with real driving miles, then re-sorts the list and re-renders. The
  // POI objects are mutated in place so cached results keep the upgrade.
  // Concurrent calls for the same anchor signature dedupe.
  async _refreshDrivingDistances(anchor, results) {
    if (!window.Trips?.getRouteMatrix) return;
    if (!results?.length) return;
    const refLat = State.userLat ?? anchor.samples[0]?.lat;
    const refLng = State.userLng ?? anchor.samples[0]?.lng;
    if (refLat == null || refLng == null) return;

    const need = results.filter(p => p._approx && p.lat != null && p.lng != null);
    if (!need.length) return;

    const inflightKey = `${anchor.signature}:${refLat.toFixed(3)},${refLng.toFixed(3)}`;
    this._matrixInflight ||= {};
    if (this._matrixInflight[inflightKey]) return;
    this._matrixInflight[inflightKey] = true;

    try {
      const dests = need.map(p => ({ id: p.xid, lat: p.lat, lng: p.lng }));
      const matrix = await Trips.getRouteMatrix(refLat, refLng, dests);
      let updated = false;
      need.forEach(p => {
        const r = matrix.get(p.xid);
        // Skip the haversine*1.3 fallback that getRouteMatrix returns when ORS
        // is unavailable — it would be misleading to flip _approx → false.
        if (r && !r.approx) {
          p.distance = r.distance;
          p.duration = r.duration;
          p._approx = false;
          updated = true;
        }
      });
      if (updated) {
        // Nearby mode: now that we have real driving miles, drop any POI that
        // exceeds the user's chosen radius. Haversine let them through (a 25mi
        // crow-flies trail can be 41mi by road in mountain terrain), but the
        // user explicitly asked for "within X mi". Route mode uses a per-sample
        // window, not a from-user radius, so we leave those untouched.
        if (anchor.mode === 'near') {
          const radiusMi = anchor.radiusM / 1609;
          for (let i = results.length - 1; i >= 0; i--) {
            if (!results[i]._approx && results[i].distance > radiusMi) {
              results.splice(i, 1);
            }
          }
        }
        // Resort by true driving distance — straight-line order rarely matches
        // road-network order in mountain/forest terrain.
        results.sort((a, b) => a.distance - b.distance);
        this.render();
      }
    } catch (e) {
      console.warn('[Discover] driving distance refresh failed:', e);
    } finally {
      delete this._matrixInflight[inflightKey];
    }
  },

  // ── Open POI in user's chosen maps app ─────────────────────────────────
  // Reuses Trips' Apple/Google picker modal. Sends the POI's NAME alongside
  // coords so Apple Maps shows a labeled pin at the exact spot instead of
  // reverse-geocoding the coords to the nearest containing area (e.g. dropping
  // you at "Umpqua National Forest" instead of "Camel Hump Mountain").
  openInMaps(name, lat, lng) {
    if (!window.Trips || !window.UI) return;
    Trips.pendingMapsAction = { type: 'poi', name, lat, lng };
    Trips.mapsModalJourneyId = null;
    UI.openModal('modal-maps-picker');
  },

  // ── Render ─────────────────────────────────────────────────────────────
  // Renders BOTH the Explore-page tile grid (always) and the Discover modal
  // contents (when open). Either target may be missing from the DOM at the
  // moment render() is called — both branches no-op gracefully.
  render() {
    this._renderTilesIntoExplore();
    if (this._modalOpen) this._renderModalContents();
  },

  // Render the 7-tile category grid that lives in #discover-wrap on the
  // Explore page. Lazy-builds the grid container the first time, then keeps
  // it in sync (saved-badge counts, etc.) on subsequent renders.
  _renderTilesIntoExplore() {
    const wrap = document.getElementById('discover-wrap');
    if (!wrap) return;

    let grid = wrap.querySelector('#discover-tiles');
    if (!grid) {
      grid = document.createElement('div');
      grid.id = 'discover-tiles';
      grid.className = 'discover-tile-grid';
      // Replace any inline list/chip/more-button DOM the old layout left
      // behind — those now live inside #modal-discover.
      const existingList = wrap.querySelector('#discover-list');
      const existingMore = wrap.querySelector('#discover-more-btn');
      const existingChips = wrap.querySelector('#discover-chips');
      const existingMode = wrap.querySelector('#discover-mode');
      [existingList, existingMore, existingChips, existingMode].forEach(el => el?.remove());
      wrap.appendChild(grid);
    }

    grid.innerHTML = this.TILE_ORDER.map(t => {
      const cls = 'discover-tile' + (t.key === 'top' ? ' top-picks' : '');
      return `
        <button type="button" class="${cls}" data-cat="${t.key}" aria-label="${this._esc(t.label)}">
          <img src="icons/categories/${t.icon}.png" alt="" class="discover-tile-icon" loading="lazy" />
          <span class="discover-tile-label">${this._esc(t.label)}</span>
        </button>`;
    }).join('');

    grid.querySelectorAll('.discover-tile').forEach(tile => {
      tile.onclick = () => Discover.openModal(tile.dataset.cat);
    });
  },

  // ── Modal: contents render ─────────────────────────────────────────────
  // Renders chips, anchor header, results list/grid, error/loading states
  // into the #modal-discover body. Called on every refresh() while the modal
  // is open, and once on openModal().
  _renderModalContents() {
    const modal = document.getElementById('modal-discover');
    if (!modal) return;

    // Header bar: title + anchor pill
    const titleEl = modal.querySelector('#modal-discover-title');
    if (titleEl) {
      const tile = this.TILE_ORDER.find(t => t.key === this.category);
      titleEl.textContent = tile ? tile.label : 'Discover';
    }
    const anchorEl = modal.querySelector('#modal-discover-anchor');
    if (anchorEl) {
      const label = this.anchorLabel || 'Pick a search area';
      anchorEl.innerHTML = `<span class="dd-anchor-icon">📍</span><span>${this._esc(label)}</span><span class="dd-anchor-chevron">▾</span>`;
    }

    // Chip row
    const chipBar = modal.querySelector('#discover-chips');
    if (chipBar) {
      const chips = this.TILE_ORDER; // same order as the tile grid
      chipBar.innerHTML = chips.map(t =>
        `<button type="button" class="discover-chip${this.category === t.key ? ' active' : ''}"
                  data-cat="${t.key}">${this._esc(t.label)}</button>`
      ).join('');
      chipBar.querySelectorAll('.discover-chip').forEach(c => {
        c.onclick = () => Discover.setCategory(c.dataset.cat);
      });
    }

    const list = modal.querySelector('#discover-list');
    const moreBtn = modal.querySelector('#discover-more-btn');
    if (!list) return;

    // No anchor at all — first-class CTA to pick a search area.
    if (this.mode == null) {
      list.classList.remove('expanded');
      list.innerHTML = `
        <div class="empty-state" style="padding:28px 20px;text-align:center">
          <div style="font-size:28px;margin-bottom:8px">📍</div>
          <div style="font-size:14px;color:var(--color-text-muted);margin-bottom:14px">
            Pick a search area to start discovering.
          </div>
          <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" onclick="Discover._dropPinFromPicker()">Drop pin on map</button>
            <button class="btn btn-outline btn-sm" onclick="Discover._openAnchorPicker(true)">Enter a city</button>
          </div>
        </div>`;
      if (moreBtn) moreBtn.style.display = 'none';
      return;
    }

    if (this.loading) {
      list.classList.remove('expanded');
      list.innerHTML = `
        <div class="empty-state" style="padding:20px;text-align:center">
          <div style="font-size:13px;color:var(--color-text-muted)">Loading discoveries…</div>
        </div>`;
      if (moreBtn) moreBtn.style.display = 'none';
      return;
    }

    if (this.error) {
      list.classList.remove('expanded');
      const t = this.errorType || 'network';
      const copy = t === 'busy'
        ? { icon: '⏳', msg: 'The discovery service is busy right now.', retry: 'Try again' }
        : t === 'offline'
        ? { icon: '📡', msg: "You're offline. Connect to load discoveries.", retry: null }
        : { icon: '⚠️', msg: "Couldn't reach the discovery service.", retry: 'Try again' };
      list.innerHTML = `
        <div class="empty-state" style="padding:20px;text-align:center">
          <div style="font-size:24px;margin-bottom:6px">${copy.icon}</div>
          <div style="font-size:13px;color:var(--color-text-muted);margin-bottom:${copy.retry ? '12px' : '0'}">${this._esc(copy.msg)}</div>
          ${copy.retry ? `<button class="btn btn-outline btn-sm" onclick="Discover.retry()">${copy.retry}</button>` : ''}
        </div>`;
      if (moreBtn) moreBtn.style.display = 'none';
      return;
    }

    // Top Picks empty: dedicated CTA to switch to Natural (the broadest OTM
    // bucket) without forcing the user back to the tile grid.
    if (!this.results.length && this.category === 'top') {
      list.classList.remove('expanded');
      list.innerHTML = `
        <div class="empty-state" style="padding:28px 20px;text-align:center">
          <div style="font-size:28px;margin-bottom:8px">⭐</div>
          <div style="font-size:14px;color:var(--color-text-muted);margin-bottom:14px">
            No top picks for this area.
          </div>
          <button class="btn btn-primary btn-sm" onclick="Discover.setCategory('natural')">View all nearby places</button>
        </div>`;
      if (moreBtn) moreBtn.style.display = 'none';
      return;
    }

    if (!this.results.length) {
      list.classList.remove('expanded');
      list.innerHTML = `
        <div class="empty-state" style="padding:20px;text-align:center">
          <div style="font-size:24px;margin-bottom:6px">🔭</div>
          <div style="font-size:13px;color:var(--color-text-muted)">
            Nothing found in this category yet.
          </div>
        </div>`;
      if (moreBtn) moreBtn.style.display = 'none';
      return;
    }

    if (this._visibleCount == null) this._visibleCount = this.INITIAL_COUNT;
    const visible = this.results.slice(0, this._visibleCount);

    list.classList.toggle('expanded', this._visibleCount > this.INITIAL_COUNT);
    // Top Picks uses hero cards (image-forward); other categories use the
    // existing compact card.
    if (this.category === 'top') {
      list.classList.add('hero-list');
      list.innerHTML = visible.map(p => this._renderHeroCard(p)).join('');
    } else {
      list.classList.remove('hero-list');
      list.innerHTML = visible.map(p => this._renderCard(p)).join('');
    }

    list.querySelectorAll('.discover-card').forEach(card => {
      card.onclick = () => Discover.openDetail(card.dataset.xid);
    });
    list.querySelectorAll('.discover-card .discover-save').forEach(btn => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        Discover.savePOI(btn.dataset.xid);
      };
    });
    list.querySelectorAll('.discover-card .discover-mapsbtn').forEach(btn => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const lat = +btn.dataset.lat, lng = +btn.dataset.lng;
        const name = btn.dataset.name || '';
        Discover.openInMaps(name, lat, lng);
      };
    });

    this._updateMoreBtn(moreBtn);
  },

  // ── More-button (Show N more / Show less) ──────────────────────────────
  _updateMoreBtn(moreBtn) {
    if (!moreBtn) return;
    const total = this.results.length;
    const showing = Math.min(this._visibleCount, total);
    const hiddenCount = total - showing;
    // Top Picks is intentionally a small curated list; no pagination.
    if (this.category === 'top' || total <= this.INITIAL_COUNT) {
      moreBtn.style.display = 'none';
      return;
    }
    moreBtn.style.display = '';
    if (hiddenCount > 0) {
      const next = Math.min(hiddenCount, this.PAGE_INCREMENT);
      moreBtn.textContent = `Show ${next} more (${hiddenCount} left)`;
      moreBtn.onclick = () => {
        Discover._visibleCount = Math.min(total, Discover._visibleCount + Discover.PAGE_INCREMENT);
        Discover.render();
      };
    } else {
      moreBtn.textContent = 'Show less';
      moreBtn.onclick = () => {
        Discover._visibleCount = Discover.INITIAL_COUNT;
        Discover.render();
      };
    }
  },

  // ── Modal: open / close ────────────────────────────────────────────────
  // Triggered by tapping a tile on the Explore page (or via the "View all
  // nearby" CTA when Top Picks is empty). Sets the active category, marks
  // the modal as open, and kicks off a fetch.
  _modalOpen: false,

  openModal(category) {
    if (!category) return;
    this.category = category;
    this.expanded = false;
    this._visibleCount = this.INITIAL_COUNT;
    this._modalOpen = true;
    if (window.UI?.openModal) UI.openModal('modal-discover');
    // Render the modal scaffolding once before the fetch so the user sees
    // the loading state instead of an empty modal.
    this._renderModalContents();
    this.refresh();
    if (window.matchMedia('(max-width: 767px)').matches && window.UI?.initMobileDrawers) {
      UI.initMobileDrawers();
      UI._applySnap('full');
    }
  },

  closeModal() {
    this._modalOpen = false;
    if (window.UI?.closeModal) UI.closeModal('modal-discover');
    this.closeDetail();
  },

  // ── Anchor picker (sub-panel inside modal) ─────────────────────────────
  // Opens the search-area selector — radio rows for current options + manual
  // pin-drop / city-entry buttons.
  _openAnchorPicker(focusInput = false) {
    const modal = document.getElementById('modal-discover');
    const host = modal?.querySelector('#discover-anchor-picker');
    if (!host) return;
    host.style.display = 'block';
    host.innerHTML = this._renderAnchorPicker();
    if (focusInput) {
      setTimeout(() => host.querySelector('#disc-place-input')?.focus(), 50);
    }
  },

  _closeAnchorPicker() {
    const modal = document.getElementById('modal-discover');
    const host = modal?.querySelector('#discover-anchor-picker');
    if (!host) return;
    host.style.display = 'none';
    host.innerHTML = '';
  },

  _renderAnchorPicker() {
    const hasGps = State.userLat != null && State.userLng != null;
    const hasManual = !!this._manualAnchor;
    const journey = State.currentJourneyId ? State.getJourney(State.currentJourneyId) : null;
    const hasRoute = !!(journey && (journey.legs || []).some(l => l.routeGeometry));
    const mode = this.mode;
    return `
      <div class="dd-anchor-card">
        <div class="dd-anchor-title">Search area</div>
        <div class="dd-anchor-options">
          ${hasGps ? `
            <button type="button" class="dd-anchor-row${(mode === 'near' && !hasManual) ? ' active' : ''}"
                    onclick="Discover._chooseGpsAnchor()">
              <span class="dd-anchor-radio"></span>
              <span class="dd-anchor-row-label">Near you (GPS)</span>
            </button>
          ` : ''}
          ${hasRoute ? `
            <button type="button" class="dd-anchor-row${(mode === 'route' && !hasManual) ? ' active' : ''}"
                    onclick="Discover._chooseRouteAnchor()">
              <span class="dd-anchor-radio"></span>
              <span class="dd-anchor-row-label">Along your trip</span>
            </button>
          ` : ''}
          ${hasManual ? `
            <button type="button" class="dd-anchor-row active"
                    onclick="Discover._closeAnchorPicker()">
              <span class="dd-anchor-radio"></span>
              <span class="dd-anchor-row-label">${this._esc(this._manualAnchor.label || 'Custom area')}</span>
            </button>
            <button type="button" class="dd-anchor-clear" onclick="Discover._clearManualAnchorAndClose()">
              Clear custom area
            </button>
          ` : ''}
        </div>

        <div class="dd-anchor-divider">— or set a custom area —</div>

        <button type="button" class="btn btn-primary btn-sm" style="width:100%;margin-bottom:10px"
                onclick="Discover._dropPinFromPicker()">
          📍 Drop pin on map
        </button>

        <label class="input-label" style="display:block;margin-bottom:4px">Enter a city or address</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="disc-place-input" class="input" style="flex:1"
                 placeholder="e.g. Moab, UT"
                 onkeydown="if(event.key==='Enter'){Discover._submitPlaceAnchor();}" />
          <button type="button" class="btn btn-outline btn-sm" onclick="Discover._submitPlaceAnchor()">Use</button>
        </div>

        <div style="margin-top:12px;text-align:right">
          <button type="button" class="btn btn-outline btn-sm" onclick="Discover._closeAnchorPicker()">Close</button>
        </div>
      </div>
    `;
  },

  _chooseGpsAnchor() {
    if (this._manualAnchor) this._clearManualAnchor();
    this.modeChoice = 'near';
    this._closeAnchorPicker();
    this.refresh();
  },

  _chooseRouteAnchor() {
    if (this._manualAnchor) this._clearManualAnchor();
    this.modeChoice = 'route';
    this._closeAnchorPicker();
    this.refresh();
  },

  _clearManualAnchorAndClose() {
    this._clearManualAnchor();
    this._closeAnchorPicker();
  },

  // Drop-pin flow: collapse the modal to half-snap so the user sees the map,
  // show a draggable pin at the current anchor (or center of the map), and
  // surface a floating "Use this location" confirm.
  _dropPinFromPicker() {
    const map = window.MapModule?.map;
    if (!map || !window.MapModule?.showDragPin) {
      if (window.UI?.showToast) UI.showToast('Map not available', 'error');
      return;
    }
    this._closeAnchorPicker();
    // Drop the pin where we already have an anchor; otherwise the map center.
    let lat, lng;
    if (this._manualAnchor) {
      lat = this._manualAnchor.lat; lng = this._manualAnchor.lng;
    } else if (this.mode === 'near' && State.userLat != null) {
      lat = State.userLat; lng = State.userLng;
    } else {
      const c = map.getCenter();
      lat = c.lat; lng = c.lng;
    }
    MapModule.showDragPin(lat, lng);
    State.pendingLat = lat;
    State.pendingLng = lng;
    State.on('dragpin:moved', this._onPinMoved);
    // Mobile: peek the modal so the map shows behind it.
    if (window.matchMedia('(max-width: 767px)').matches && window.UI) {
      UI._applySnap('peek');
    }
    this._showPinConfirmBar();
  },

  _onPinMoved({ lat, lng } = {}) {
    if (lat != null && lng != null) {
      State.pendingLat = lat;
      State.pendingLng = lng;
    }
  },

  _showPinConfirmBar() {
    let bar = document.getElementById('discover-pin-confirm');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'discover-pin-confirm';
      bar.className = 'discover-pin-confirm';
      document.body.appendChild(bar);
    }
    bar.innerHTML = `
      <div class="discover-pin-confirm-text">Drag the pin to your search area</div>
      <div class="discover-pin-confirm-actions">
        <button class="btn btn-outline btn-sm" onclick="Discover._cancelPinDrop()">Cancel</button>
        <button class="btn btn-primary btn-sm" onclick="Discover._confirmPinDrop()">Use this location</button>
      </div>`;
    bar.style.display = 'flex';
  },

  _hidePinConfirmBar() {
    const bar = document.getElementById('discover-pin-confirm');
    if (bar) bar.style.display = 'none';
  },

  _confirmPinDrop() {
    const lat = State.pendingLat;
    const lng = State.pendingLng;
    State.off('dragpin:moved', this._onPinMoved);
    if (lat == null || lng == null) {
      this._cancelPinDrop();
      return;
    }
    if (window.MapModule?.hideDragPin) MapModule.hideDragPin();
    this._hidePinConfirmBar();
    this._setManualAnchor(lat, lng, 'Custom area');
    if (window.matchMedia('(max-width: 767px)').matches && window.UI) {
      UI._applySnap('full');
    }
  },

  _cancelPinDrop() {
    State.off('dragpin:moved', this._onPinMoved);
    if (window.MapModule?.hideDragPin) MapModule.hideDragPin();
    this._hidePinConfirmBar();
    if (window.matchMedia('(max-width: 767px)').matches && window.UI) {
      UI._applySnap('full');
    }
  },

  // City/address entry flow: reuse Entries.geocodeAddress (Geocodio) so we
  // don't add a new API dependency.
  async _submitPlaceAnchor() {
    const input = document.getElementById('disc-place-input');
    if (!input) return;
    const q = input.value.trim();
    if (!q) return;
    if (!window.Entries?.geocodeAddress) {
      if (window.UI?.showToast) UI.showToast('Geocoding not available', 'error');
      return;
    }
    input.disabled = true;
    try {
      const coords = await Entries.geocodeAddress(q);
      if (!coords) {
        if (window.UI?.showToast) UI.showToast(`Couldn't find "${q}"`, 'error');
        return;
      }
      this._setManualAnchor(coords.lat, coords.lng, q);
      this._closeAnchorPicker();
    } catch (e) {
      console.error('[Discover] geocode failed:', e);
      if (window.UI?.showToast) UI.showToast('Lookup failed', 'error');
    } finally {
      input.disabled = false;
    }
  },

  // ── Detail panel ───────────────────────────────────────────────────────
  // Opens the third-column panel (desktop) / bottom drawer (mobile) showing
  // full info for one POI. Most fields render conditionally — sparse OSM data
  // shows an honest empty-state rather than fake content.

  _detailXid: null,

  openDetail(xid) {
    const poi = this.results.find(p => p.xid === xid);
    if (!poi) return;
    this._detailXid = xid;

    // Body class drives the mobile CSS that hides the other drawers behind
    // this one — without it, dragging the detail drawer down reveals the
    // Discover list instead of the map.
    document.body.classList.add('discover-detail-open');

    // Close the saved-Entry backup panel if it happens to be open — they share
    // the third-column slot on desktop.
    if (window.Entries?.closeBackupPanel) Entries.closeBackupPanel();

    const panel = document.getElementById('discover-detail-panel');
    const content = document.getElementById('discover-detail-content');
    const footer = document.getElementById('discover-detail-footer');
    if (!panel || !content || !footer) return;

    const isOTM = !!poi._otm;
    const wikiTag = poi.tags?.wikipedia || poi.tags?.['wikipedia:en'];
    const qid = poi.tags?.wikidata;
    // For OTM, we always want to call /xid/{xid} the first time the user
    // opens this POI — that's where the image, address, description, and
    // wikidata/wikipedia IDs live (the list endpoint only returns name/coords
    // /rate/kinds). Cached after first call.
    const enriching = isOTM ? true : !!(wikiTag || qid);
    // Need a reverse-geocode if the POI carries no city/state — Overpass POIs
    // sometimes do; OTM detail returns address structured, so we usually skip.
    const t = poi.tags || {};
    const hasCity = !!(t['addr:city'] || t['addr:town'] || t['addr:village']);
    const hasState = !!t['addr:state'];
    const needReverse = !isOTM && (!hasCity || !hasState) && poi._reverseAddr === undefined;

    content.innerHTML = this._renderDetailContent(poi, /*wiki*/ null, /*wd*/ null, /*loading*/ enriching);
    footer.innerHTML = this._renderDetailFooter(poi);
    panel.style.display = 'flex';

    // Mobile: open at full snap so the user sees the description without dragging.
    if (window.matchMedia('(max-width: 767px)').matches && window.UI) {
      UI.initMobileDrawers();
      UI._applySnap('full');
    }

    // The detail panel pushes the map container narrower on desktop. Leaflet
    // needs invalidateSize() to recompute its internal viewport BEFORE flyTo,
    // otherwise the animation runs against the old dimensions and the camera
    // lands at the wrong coords. Wait one frame for CSS layout to settle, then
    // resize, then fly. Zoom 15 = ~1.2 km wide so the user sees the actual
    // POI spot rather than 5 km of context.
    setTimeout(() => {
      if (!MapModule?.map) return;
      MapModule.map.invalidateSize();
      if (poi.lat && poi.lng) {
        MapModule.showDiscoverMarker(poi.lat, poi.lng, poi.name);
        MapModule.flyTo(poi.lat, poi.lng, 15);
      }
    }, 60);

    // Async enrichment: OTM detail (if OTM) → falls through to Wikipedia /
    // Wikidata for fields OTM didn't supply. Reverse-geocode runs only when
    // we have no city/state at all. All cached so repeat opens skip the
    // network.
    if (enriching || needReverse) {
      const enrich = async () => {
        // Step 1: OTM detail (also populates wikidata / wikipedia / images).
        if (isOTM) await this._loadOTMDetail(poi);
        // Step 2: derive wiki/wd lookups. Prefer OTM-supplied IDs; fall back
        // to OSM tags. Skip Wikidata if OTM already has an image AND a
        // description (the only fields we'd render from it).
        const finalWikiTag = wikiTag || poi.wikipedia || null;
        const finalQid = qid || poi.wikidata || null;
        const otmHasEnough = isOTM && (poi.images?.length > 0) && !!poi.description;
        const wikiP = finalWikiTag ? this._loadWikipedia(finalWikiTag) : Promise.resolve(null);
        const wdP = (finalQid && !otmHasEnough) ? this._loadWikidata(finalQid) : Promise.resolve(null);
        const revP = needReverse ? this._reverseGeocode(poi) : Promise.resolve(null);
        const [wiki, wd] = await Promise.all([wikiP, wdP, revP]);
        return { wiki, wd };
      };
      enrich().then(({ wiki, wd }) => {
        if (this._detailXid !== xid) return;
        const c = document.getElementById('discover-detail-content');
        const f = document.getElementById('discover-detail-footer');
        if (c) c.innerHTML = this._renderDetailContent(poi, wiki, wd, false);
        if (f) f.innerHTML = this._renderDetailFooter(poi);
      });
    }
  },

  closeDetail() {
    this._detailXid = null;
    document.body.classList.remove('discover-detail-open');
    const panel = document.getElementById('discover-detail-panel');
    if (panel) panel.style.display = 'none';
    if (window.MapModule?.hideDiscoverMarker) MapModule.hideDiscoverMarker();
    // Mobile: snap the Discover list back to full so the user lands where
    // they were browsing — leaving it at peek/half after dismissing the
    // detail panel is disorienting.
    if (window.matchMedia('(max-width: 767px)').matches && window.UI) {
      UI._applySnap('full');
    }
    setTimeout(() => { if (MapModule?.map) MapModule.map.invalidateSize(); }, 50);
  },

  // Wikipedia REST summary endpoint — free, no API key, no CORS issues.
  // Returns { extract, thumbnail: {source}, content_urls: {desktop: {page}} }
  // or null on miss/failure. Cached per tag for the session.
  async _loadWikipedia(wikiTag) {
    if (this._wikiCache[wikiTag] !== undefined) return this._wikiCache[wikiTag];
    const m = wikiTag.match(/^([a-z-]+):(.+)$/i);
    if (!m) { this._wikiCache[wikiTag] = null; return null; }
    const [, lang, title] = m;
    try {
      const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const r = await fetch(url);
      if (!r.ok) { this._wikiCache[wikiTag] = null; return null; }
      const data = await r.json();
      const out = {
        extract: data.extract || '',
        thumbnail: data.thumbnail?.source || null,
        url: data.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`
      };
      this._wikiCache[wikiTag] = out;
      return out;
    } catch (e) {
      console.warn('[Discover] wiki fetch failed:', e);
      this._wikiCache[wikiTag] = null;
      return null;
    }
  },

  _renderDetailContent(poi, wiki, wd, loading) {
    const esc = s => this._esc(s);
    const tags = poi.tags || {};

    // ── Photo gallery (1–2 images) ─────────────────────────────────────
    // Build a deduped list from up to 4 sources in priority order:
    //   1. OTM preview thumbnail (poi.images[0])
    //   2. OTM full-size image (poi.images[1])
    //   3. Wikipedia thumbnail
    //   4. Wikidata P18 (Commons) image
    // De-dupe by stripping host+path so that resized variants of the same
    // image don't both appear. Render the first 2 unique sources.
    const sourcesRaw = [];
    if (poi.images?.length) {
      poi.images.forEach(u => u && sourcesRaw.push(u));
    }
    if (wiki?.thumbnail) sourcesRaw.push(wiki.thumbnail);
    if (wd?.image) sourcesRaw.push(wd.image);
    if (tags.image) sourcesRaw.push(tags.image);
    const seenKeys = new Set();
    const sources = [];
    for (const u of sourcesRaw) {
      try {
        const k = u.replace(/^https?:\/\//, '').split('?')[0].toLowerCase();
        if (seenKeys.has(k)) continue;
        seenKeys.add(k);
        sources.push(u);
      } catch { /* skip malformed */ }
    }
    const photos = sources.slice(0, 2);

    let hero = '';
    if (photos.length === 0) {
      const heroIcon = this._categoryIcon(poi.category);
      hero = `<div class="dd-hero fallback"><span class="dd-hero-pill">${esc(poi.category)}</span><span>${heroIcon}</span></div>`;
    } else if (photos.length === 1) {
      hero = `<div class="dd-hero" style="background-image:url('${esc(photos[0])}')"><span class="dd-hero-pill">${esc(poi.category)}</span></div>`;
    } else {
      hero = `
        <div class="dd-photo-row">
          <div class="dd-photo" style="background-image:url('${esc(photos[0])}')">
            <span class="dd-hero-pill">${esc(poi.category)}</span>
          </div>
          <div class="dd-photo" style="background-image:url('${esc(photos[1])}')"></div>
        </div>`;
    }

    // Subline: stars (when available) + distance + operator/region.
    const distLabel = (poi._approx ? '~' : '') + State.formatDistance(poi.distance) + ' away';
    const revCity = poi._reverseAddr?.city;
    const revState = poi._reverseAddr?.state;
    // OTM detail address structure → city/state strings.
    const otmAddr = poi.address || null;
    const otmCity = otmAddr?.city || otmAddr?.town || otmAddr?.village || null;
    const otmState = otmAddr?.state || null;
    const region = tags.operator
      || [tags['addr:city'] || otmCity || revCity, tags['addr:state'] || otmState || revState].filter(Boolean).join(', ')
      || '';
    const starsHtml = poi.stars ? `<span class="dd-stars">${this._renderStars(poi.stars)}</span> ` : '';
    const sublineText = region ? `${distLabel} · ${esc(region)}` : distLabel;
    const subline = `${starsHtml}${sublineText}`;

    // Description priority: OTM extract > Wikipedia extract > OSM description
    // > Wikidata description > empty.
    const osmDesc = tags.description || tags['description:en'];
    let descBlock = '';
    if (loading) {
      descBlock = `<div class="dd-loading">Loading description…</div>`;
    } else if (poi.description) {
      // OTM-supplied. Stripped HTML (it's plain text from wikipedia_extracts.text).
      descBlock = `<div class="dd-description">${esc(poi.description)}</div>`;
      if (poi.wikipedia) {
        const m = poi.wikipedia.match(/^([a-z-]+):(.+)$/i);
        const wlink = m ? `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(m[2])}` : null;
        if (wlink) {
          descBlock += `<a href="${esc(wlink)}" target="_blank" rel="noopener" class="dd-wiki-link">Read more on Wikipedia →</a>`;
        }
      }
    } else if (wiki?.extract) {
      descBlock = `
        <div class="dd-description">${esc(wiki.extract)}</div>
        <a href="${esc(wiki.url)}" target="_blank" rel="noopener" class="dd-wiki-link">Read more on Wikipedia →</a>
        <div class="dd-wiki-attribution">Summary from Wikipedia, CC BY-SA 4.0</div>`;
    } else if (osmDesc) {
      descBlock = `<div class="dd-description" style="margin-bottom:18px">${esc(osmDesc)}</div>`;
    } else if (wd?.description) {
      descBlock = `<div class="dd-description" style="margin-bottom:18px">${esc(wd.description)}</div>`;
    } else if (!tags.website && !tags['contact:website'] && !tags.phone && !wd?.officialWebsite) {
      descBlock = `
        <div class="dd-empty-blurb">
          <strong>No description available</strong>
          Use the search buttons below to look this place up online.
        </div>`;
    }

    // Quick facts grid — render only fields that exist
    const facts = [];
    if (tags.distance) {
      const km = parseFloat(tags.distance);
      if (!isNaN(km)) facts.push(['Length', (km * 0.621371).toFixed(1) + ' mi']);
    }
    if (tags.sac_scale) {
      const diffMap = {
        hiking: 'Easy',
        mountain_hiking: 'Moderate',
        demanding_mountain_hiking: 'Hard',
        alpine_hiking: 'Alpine',
        demanding_alpine_hiking: 'Demanding alpine',
        difficult_alpine_hiking: 'Difficult alpine'
      };
      facts.push(['Difficulty', diffMap[tags.sac_scale] || tags.sac_scale.replace(/_/g, ' ')]);
    }
    if (tags.ele) {
      const m = parseFloat(tags.ele);
      if (!isNaN(m)) facts.push(['Elevation', Math.round(m * 3.28084).toLocaleString() + ' ft']);
    }
    if (tags.operator && !facts.length) {
      // Skip — already shown in subline. But include if facts grid would otherwise be near-empty.
    }
    if (tags.ref) facts.push(['Trail #', tags.ref]);
    if (tags.surface) facts.push(['Surface', tags.surface.replace(/_/g, ' ')]);
    if (wd?.inception) facts.push(['Established', wd.inception]);
    const factsHtml = facts.length
      ? `<div class="dd-facts">${facts.map(([l, v]) => `<div class="dd-fact"><div class="dd-fact-label">${esc(l)}</div><div class="dd-fact-value">${esc(v)}</div></div>`).join('')}</div>`
      : '';

    // Amenity badges
    const badges = [];
    if (tags.fee === 'no') badges.push(['Free', 'good']);
    else if (tags.fee === 'yes' && !tags['fee:amount']) badges.push(['Fee required', 'warn']);
    if (tags['fee:amount']) badges.push(['$' + tags['fee:amount'], 'warn']);
    if (tags.toilets === 'yes') badges.push(['Restrooms', 'good']);
    if (tags.shower === 'yes') badges.push(['Showers', 'good']);
    if (tags.drinking_water === 'yes' || tags.amenity === 'drinking_water') badges.push(['Water', 'good']);
    if (tags.dog === 'yes') badges.push(['Dogs OK', 'good']);
    if (tags.wheelchair === 'yes') badges.push(['Wheelchair accessible', 'good']);
    if (tags.access === 'permit' || tags.permit === 'yes') badges.push(['Permit required', 'warn']);
    if (tags.reservation === 'required') badges.push(['Reservation', 'warn']);
    const badgesHtml = badges.length
      ? `<div class="dd-section-label">Amenities</div><div class="dd-badges">${badges.map(([l, k]) => `<span class="dd-badge${k === 'warn' ? ' warn' : ''}">${esc(l)}</span>`).join('')}</div>`
      : '';

    // Address (compose from addr:* tags, fall back to OTM structured
    // address, then reverse-geocoded city/state when only coords are tagged
    // on the POI).
    const otmStreet = otmAddr?.road || otmAddr?.pedestrian || null;
    const addrParts = [
      tags['addr:street'] || otmStreet,
      tags['addr:city'] || otmCity || revCity,
      tags['addr:state'] || otmState || revState
    ].filter(Boolean);
    const addressLine = addrParts.join(', ');

    // Info rows: hours / address / website / phone / coords (always last)
    const rows = [];
    if (tags.opening_hours) rows.push(['🕒', esc(tags.opening_hours), 'Hours']);
    if (addressLine) rows.push(['📍', esc(addressLine), 'Address']);
    const website = tags.website || tags['contact:website'] || tags.url || wd?.officialWebsite;
    if (website) {
      const display = website.replace(/^https?:\/\//, '').replace(/\/$/, '');
      rows.push(['🌐', `<a href="${esc(website)}" target="_blank" rel="noopener">${esc(display)}</a>`, 'Website']);
    }
    const phone = tags.phone || tags['contact:phone'];
    if (phone) rows.push(['📞', `<a href="tel:${esc(phone)}">${esc(phone)}</a>`, 'Phone']);
    rows.push(['📌', `${poi.lat.toFixed(5)}, ${poi.lng.toFixed(5)}`, 'Coordinates']);
    const rowsHtml = rows.map(([ico, val, label]) =>
      `<div class="dd-info-row"><span class="dd-ico">${ico}</span><div><div>${val}</div><div class="dd-info-label">${esc(label)}</div></div></div>`
    ).join('');

    return `
      ${hero}
      <div class="dd-name">${esc(poi.name)}</div>
      <div class="dd-subline">${subline}</div>
      ${descBlock}
      ${factsHtml}
      ${badgesHtml}
      ${rowsHtml}
    `;
  },

  _renderDetailFooter(poi) {
    const esc = s => this._esc(s);
    const saved = this._alreadySaved(poi);
    const saveBtn = saved
      ? `<button class="btn btn-outline" disabled style="flex:1">✓ Saved</button>`
      : `<button class="btn btn-primary" style="flex:1"
                 onclick="Discover.savePOI('${poi.xid}')">+ Save</button>`;

    // Search-the-web row. Suffix the Google query with city + state to
    // disambiguate generic POI names ("Bidwell Mansion" vs the dozens of
    // others). Pulls from OSM addr:* tags first, then a Nominatim reverse-
    // geocode (cached on the POI as poi._reverseAddr) when those tags are
    // missing. Offline state checked at click time via _lookupClick.
    const tags = poi.tags || {};
    const city = tags['addr:city'] || tags['addr:town'] || tags['addr:village'] || poi._reverseAddr?.city;
    const stateName = tags['addr:state'] || poi._reverseAddr?.state;
    const locParts = [city, stateName].filter(Boolean);
    const locSuffix = locParts.length ? ' ' + locParts.join(' ') : '';
    const gQuery = encodeURIComponent(poi.name + locSuffix);
    const wQuery = encodeURIComponent(poi.name);
    return `
      <div class="dd-lookup-row">
        <span class="dd-lookup-label">Look up:</span>
        <a href="https://www.google.com/search?q=${gQuery}" target="_blank" rel="noopener"
           class="dd-lookup-btn" title="Search on Google" onclick="return Discover._lookupClick(event)">
          <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
            <path fill="#4285f4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>
            <path fill="#34a853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>
            <path fill="#fbbc04" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"/>
            <path fill="#ea4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/>
          </svg>
          <span>Google</span>
        </a>
        <a href="https://en.wikipedia.org/wiki/Special:Search?search=${wQuery}" target="_blank" rel="noopener"
           class="dd-lookup-btn" title="Search on Wikipedia" onclick="return Discover._lookupClick(event)">
          <span class="dd-wiki-glyph" aria-hidden="true">W</span>
          <span>Wikipedia</span>
        </a>
      </div>
      <div class="dd-footer-actions">
        <button class="btn btn-outline" style="flex:1"
                onclick="Discover.openInMaps('${esc(poi.name)}', ${poi.lat}, ${poi.lng})">
          📍 Open in Maps
        </button>
        ${saveBtn}
      </div>
    `;
  },

  // Click guard: blocks the navigation if offline and shows a toast. Browsers
  // would otherwise just open a "no internet" page in the background tab.
  _lookupClick(e) {
    if (!navigator.onLine) {
      e.preventDefault();
      if (window.UI?.showToast) UI.showToast("You're offline — can't open search", 'error');
      return false;
    }
    return true;
  },

  // Coarse emoji fallback for the gradient hero placeholder (no Wikipedia
  // image available). Picks a single representative glyph by category.
  _categoryIcon(category) {
    const map = {
      'Hiking Trail': '🥾', 'Trail': '🥾', 'Footpath': '🥾', 'Trailhead': '🚩',
      'Peak': '⛰', 'Waterfall': '💧', 'Cave': '🕳', 'Spring': '♨',
      'Nature Reserve': '🌲', 'National Park': '🏞', 'Viewpoint': '🌄',
      'Campground': '⛺', 'Dump Station': '🚮', 'Water Fill': '💧',
      'Museum': '🏛', 'Gallery': '🖼', 'Theatre': '🎭', 'Arts Centre': '🎨',
      'Planetarium': '🪐', 'Fountain': '⛲', 'Lighthouse': '🗼', 'Tower': '🗼',
      'Memorial': '🗿', 'Monument': '🗿', 'Ruins': '🏛', 'Archaeological': '🏺',
      'Historic': '🏛', 'Attraction': '✨', 'Artwork': '🎨', 'Place': '📍'
    };
    return map[category] || '📍';
  },

  // Render a 1–5 star row. Returns '' when stars is 0 / null so OSM-source
  // cards (Camping/Hiking) get no row at all.
  _renderStars(stars) {
    if (!stars || stars < 1) return '';
    const filled = Math.max(0, Math.min(5, Math.round(stars)));
    const empty = 5 - filled;
    return `<span class="discover-stars" aria-label="${filled} of 5 stars">${'★'.repeat(filled)}${'☆'.repeat(empty)}</span>`;
  },

  _renderCard(p) {
    // Prefix '~' while distance is still straight-line — driving miles can be
    // 5–10× crow-flies in mountain terrain, so the unprefixed number would
    // actively mislead until ORS Matrix replaces it.
    const distLabel = State.formatDistance
      ? (p._approx ? '~' : '') + State.formatDistance(p.distance) + ' away'
      : (p._approx ? '~' : '') + Math.round(p.distance) + ' mi away';
    const saved = this._alreadySaved(p);
    const saveButton = saved
      ? `<span class="discover-saved-badge">✓ Saved</span>`
      : `<button type="button" class="discover-save" data-xid="${p.xid}">+ Save</button>`;
    const badges = (p.badges || []).map(b =>
      `<span class="discover-badge ${b.kind}">${this._esc(b.label)}</span>`
    ).join('');
    const stars = this._renderStars(p.stars);
    return `
      <div class="discover-card" data-xid="${p.xid}">
        <div class="discover-card-content">
          <div class="discover-card-name">${this._esc(p.name)}</div>
          <div class="discover-card-meta">
            <span class="discover-tag">${this._esc(p.category)}</span>
            ${stars}
            <span class="discover-dist">${this._esc(distLabel)}</span>
          </div>
          ${badges ? `<div class="discover-card-badges">${badges}</div>` : ''}
        </div>
        <div class="discover-card-actions">
          ${saveButton}
          <button type="button" class="discover-mapsbtn"
                  data-lat="${p.lat}" data-lng="${p.lng}"
                  data-name="${this._esc(p.name)}"
                  aria-label="Open in maps">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 1 1 18 0z"/>
              <circle cx="12" cy="10" r="3"/>
            </svg>
          </button>
        </div>
      </div>`;
  },

  // Hero card for Top Picks: large preview image, category badge, stars,
  // distance, Save. Falls back to a category-tinted gradient + the category
  // PNG icon when no preview image is available (which is most OTM list
  // results — the image lives in the detail-endpoint payload, not the list).
  _renderHeroCard(p) {
    const distLabel = State.formatDistance
      ? (p._approx ? '~' : '') + State.formatDistance(p.distance) + ' away'
      : (p._approx ? '~' : '') + Math.round(p.distance) + ' mi away';
    const saved = this._alreadySaved(p);
    const saveButton = saved
      ? `<span class="discover-saved-badge">✓ Saved</span>`
      : `<button type="button" class="discover-save" data-xid="${p.xid}">+ Save</button>`;
    const stars = this._renderStars(p.stars);
    // Map OTM category → tile icon for the gradient fallback hero.
    const iconMap = {
      'Natural': 'natural', 'Cultural': 'cultural', 'Quirky': 'quirky',
      'Historic': 'historical', 'Place': 'top-picks'
    };
    const iconFile = iconMap[p.category] || 'top-picks';
    const heroSrc = (p.images && p.images[0]) || null;
    const hero = heroSrc
      ? `<div class="discover-hero-image" style="background-image:url('${this._esc(heroSrc)}')"></div>`
      : `<div class="discover-hero-image fallback">
           <img src="icons/categories/${iconFile}.png" alt="" />
         </div>`;
    return `
      <div class="discover-card hero" data-xid="${p.xid}">
        ${hero}
        <div class="discover-card-content">
          <div class="discover-card-row">
            <span class="discover-card-name">${this._esc(p.name)}</span>
            <span class="discover-cat-badge">${this._esc(p.category)}</span>
          </div>
          <div class="discover-card-meta">
            ${stars}
            <span class="discover-dist">${this._esc(distLabel)}</span>
          </div>
        </div>
        <div class="discover-card-actions">
          ${saveButton}
        </div>
      </div>`;
  },

  _esc(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }
};

window.Discover = Discover;
