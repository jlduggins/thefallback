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
  _savingXids: new Set(),

  // OSM tag selectors per chip. Each selector is [key] (presence-only) or
  // [key, value] (exact match). Overpass supports both via the same syntax.
  CATEGORY_TAGS: {
    all: [
      ['tourism','attraction'],
      ['tourism','viewpoint'],
      ['tourism','artwork'],
      ['historic'],
      ['natural','peak'],
      ['natural','waterfall'],
      ['natural','cave_entrance'],
      ['natural','hot_spring'],
      ['leisure','nature_reserve']
    ],
    quirky: [
      ['historic','memorial'],
      ['historic','monument'],
      ['historic','ruins'],
      ['historic','wayside_shrine'],
      ['historic','archaeological_site'],
      ['tourism','artwork'],
      ['man_made','tower'],
      ['man_made','lighthouse'],
      ['amenity','fountain']
    ],
    historic: [
      ['historic']
    ],
    natural: [
      ['natural','peak'],
      ['natural','waterfall'],
      ['natural','cave_entrance'],
      ['natural','spring'],
      ['natural','hot_spring'],
      ['leisure','nature_reserve'],
      ['boundary','national_park'],
      ['tourism','viewpoint']
    ],
    cultural: [
      ['tourism','museum'],
      ['tourism','gallery'],
      ['amenity','theatre'],
      ['amenity','arts_centre'],
      ['amenity','planetarium']
    ],
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
      ['highway','trailhead'],
      // Named footpaths — needed because most short local trails (Toketee
      // Falls, Watson Falls, etc.) are tagged highway=path with a name, NOT
      // as route relations. Without this selector the list misses everything
      // close to the user. The by-name dedupe below collapses the resulting
      // relation/way overlap.
      '["highway"="path"]["name"]'
    ]
  },

  // Approx point sampling along a route. Smaller = denser sampling = more
  // POIs found along windy roads, but bigger query payload.
  SAMPLE_EVERY_MI: 12,
  ROUTE_RADIUS_M: 8000,    // ~5 mi window around each sample point
  NEAR_RADIUS_M: 48000,    // ~30 mi around user GPS in "near" mode
  MAX_SAMPLES: 12,         // cap for the union to keep query body sane
  MAX_RESULTS: 30,         // hard cap from Overpass-side dedupe
  INITIAL_COUNT: 10,       // visible on first render
  PAGE_INCREMENT: 10,      // added per "Show more" click
  _visibleCount: 10,       // current display window; reset on category/mode change
  _wikiCache: {},          // wiki tag → { extract, thumbnail, url } | null
  _wikidataCache: {},      // qid → { image, officialWebsite, description, inception } | null

  // Overpass mirrors tried in order — each has independent rate limits, so
  // when the main endpoint returns 429/504 we silently fall through to the
  // next. All three accept the same Overpass-QL syntax.
  OVERPASS_MIRRORS: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ],

  // localStorage TTL for cached Overpass results. POIs barely change, so a
  // week is comfortable. Keyed by `${modeChoice}:${mode}:${signature}:${cat}`,
  // same as the in-memory cache below.
  CACHE_TTL_MS: 7 * 86400 * 1000,
  // Prefix is versioned — bump it (v2 → v3) any time the POI shape, the dedupe
  // rules, or the inclusion filters change in a way that would make old cached
  // results wrong. Init() cleans up keys with older prefixes so they don't sit
  // in localStorage forever.
  CACHE_PREFIX: 'fb-disc-v2-',
  CACHE_OLD_PREFIXES: ['fb-disc-'],

  // ── Init ───────────────────────────────────────────────────────────────
  init() {
    // One-shot cleanup of localStorage keys written by older cache schemas.
    // Cheap (string scan, no parsing). Runs once on app boot per session.
    try {
      const drop = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && this.CACHE_OLD_PREFIXES.some(p => k.startsWith(p) && !k.startsWith(this.CACHE_PREFIX))) {
          drop.push(k);
        }
      }
      drop.forEach(k => localStorage.removeItem(k));
    } catch (e) { /* localStorage unavailable; skip silently */ }

    State.on('entries:changed',  () => this.render());
    State.on('journeys:changed', () => this.refresh());
    State.on('journey:current-changed', () => this.refresh());
    State.on('location:updated', () => this.refresh());
    State.on('view:changed', ({ from, to }) => {
      if (to === 'explore') this.refresh();
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

  // ── Anchor selection: route vs near vs none ────────────────────────────
  // Honors `modeChoice`. Route mode samples ONLY future legs (using
  // jctx.nextLegIndex) so finishing your last stop doesn't drag in POIs
  // 100+ mi behind you. If forced 'route' but no future geometry exists,
  // we fall back to nearby so the section never goes blank.
  _resolveAnchor() {
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
        return {
          mode: 'route',
          samples: samples.slice(0, this.MAX_SAMPLES),
          radiusM: this.ROUTE_RADIUS_M,
          signature: routeSig + samples.length,
          label: 'along your route',
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

  // ── Refresh: pull from cache or call Overpass ──────────────────────────
  async refresh() {
    if (State.currentView && State.currentView !== 'explore') {
      this.render();
      return;
    }
    const a = this._resolveAnchor();
    this.mode = a.mode;
    this.anchorLabel = a.label;

    if (!a.mode) {
      this.results = [];
      this.error = null;
      this.loading = false;
      this.render();
      return;
    }

    const key = `${this.modeChoice}:${a.mode}:${a.signature}:${this.category}`;

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

  // Build one Overpass QL query that unions every tag selector × every
  // sample point. Single POST, no concurrency fan-out. Returns deduped POIs.
  async _fetchPOIs(anchor) {
    const tagSelectors = this.CATEGORY_TAGS[this.category] || this.CATEGORY_TAGS.all;
    const samples = anchor.samples;

    let body = '[out:json][timeout:60];(\n';
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

  // ── Persistent cache (localStorage with TTL) ──────────────────────────
  // Survives page reloads. Same key shape as the in-memory _cache. On write,
  // if the quota is exceeded, prunes expired + oldest half and retries.
  _persistRead(key) {
    try {
      const raw = localStorage.getItem(this.CACHE_PREFIX + key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj.expires || obj.expires < Date.now()) {
        localStorage.removeItem(this.CACHE_PREFIX + key);
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
    try {
      localStorage.setItem(this.CACHE_PREFIX + key, json);
    } catch (e) {
      this._prunePersisted();
      try { localStorage.setItem(this.CACHE_PREFIX + key, json); }
      catch (e2) { console.warn('[Discover] persist failed after prune:', e2); }
    }
  },
  _prunePersisted() {
    const now = Date.now();
    const ours = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(this.CACHE_PREFIX)) ours.push(k);
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

  // ── Save POI as a normal Entry (auto-fill amenity flags from tags) ─────
  async savePOI(xid) {
    const poi = this.results.find(p => p.xid === xid);
    if (!poi) return;
    if (this._savingXids.has(xid)) return;
    if (!window.Firebase?.getUserId?.()) {
      if (window.UI?.toast) UI.toast('Sign in to save locations');
      return;
    }
    this._savingXids.add(xid);
    this.render();
    try {
      const tags = poi.tags || {};
      const entry = {
        name: poi.name,
        lat: poi.lat,
        lng: poi.lng,
        type: poi.category,
        status: 'planned',
        notes: 'Discovered via OpenStreetMap',
        sourceXid: poi.xid,
        sourceTags: tags
      };
      // Auto-fill amenity fields from OSM tags so vanlife data flows into
      // the rest of the app (Saved card, filters, Trips planning) without
      // the user having to re-enter it.
      if (tags.drinking_water === 'yes' || tags.amenity === 'drinking_water') entry.hasPotableWater = true;
      if (tags.sanitary_dump_station === 'yes' || tags.amenity === 'sanitary_dump_station') entry.hasDumpStation = true;
      if (tags.power_supply === 'yes') entry.hasHookups = true;
      if (tags.dog === 'yes') entry.hasPets = true;
      if (tags.reservation === 'required' || tags.reservation === 'recommended') entry.needsReservations = true;
      if (tags.fee === 'no') entry.cost = 0;
      else if (tags['fee:amount']) {
        const n = parseFloat(tags['fee:amount']);
        if (!isNaN(n)) entry.cost = n;
      }
      if (tags.website) entry.website = tags.website;
      else if (tags['contact:website']) entry.website = tags['contact:website'];
      if (tags.phone) entry.phone = tags.phone;
      else if (tags['contact:phone']) entry.phone = tags['contact:phone'];
      await Firebase.saveEntry(entry);
      if (window.UI?.toast) UI.toast(`Saved "${poi.name}"`);
    } catch (e) {
      console.error('[Discover] save failed:', e);
      if (window.UI?.toast) UI.toast('Could not save location');
    } finally {
      this._savingXids.delete(xid);
      this.render();
    }
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
  render() {
    const wrap = document.getElementById('discover-wrap');
    if (!wrap) return;

    // Preserve section collapsed state across re-renders.
    wrap.classList.toggle('collapsed', !!this.collapsed);

    const sub = wrap.querySelector('#discover-subtitle');
    if (sub) {
      sub.textContent = this.anchorLabel || '';
    }

    // Mode toggle pill row — Route vs Nearby. Lets the user explicitly
    // pick instead of relying on auto-detection. Inserted before chips.
    let modeBar = wrap.querySelector('#discover-mode');
    if (!modeBar) {
      modeBar = document.createElement('div');
      modeBar.id = 'discover-mode';
      modeBar.className = 'discover-mode';
      const chipBarEl = wrap.querySelector('#discover-chips');
      if (chipBarEl) wrap.insertBefore(modeBar, chipBarEl);
      else wrap.appendChild(modeBar);
    }
    const modes = [
      ['auto',  'Auto'],
      ['route', 'Along route'],
      ['near',  'Nearby']
    ];
    modeBar.innerHTML = modes.map(([k, label]) =>
      `<button type="button" class="discover-mode-btn${this.modeChoice === k ? ' active' : ''}"
                data-mode="${k}">${label}</button>`
    ).join('');
    modeBar.querySelectorAll('.discover-mode-btn').forEach(b => {
      b.onclick = () => Discover.setModeChoice(b.dataset.mode);
    });

    const chipBar = wrap.querySelector('#discover-chips');
    if (chipBar) {
      const chips = [
        ['all',      'All'],
        ['camping',  'Camping'],
        ['hiking',   'Hiking'],
        ['quirky',   'Quirky'],
        ['historic', 'Historic'],
        ['natural',  'Natural'],
        ['cultural', 'Cultural']
      ];
      chipBar.innerHTML = chips.map(([k, label]) =>
        `<button type="button" class="discover-chip${this.category === k ? ' active' : ''}"
                  data-cat="${k}">${label}</button>`
      ).join('');
      chipBar.querySelectorAll('.discover-chip').forEach(c => {
        c.onclick = () => Discover.setCategory(c.dataset.cat);
      });
    }

    const list = wrap.querySelector('#discover-list');
    const moreBtn = wrap.querySelector('#discover-more-btn');
    if (!list) return;

    if (this.mode == null) {
      list.classList.remove('expanded');
      list.innerHTML = `
        <div class="empty-state" style="padding:20px;text-align:center">
          <div style="font-size:24px;margin-bottom:6px">🧭</div>
          <div style="font-size:13px;color:var(--color-text-muted)">
            Plan a journey or enable location to discover places.
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
      // Three error states get distinct UI so the user knows what to do.
      const t = this.errorType || 'network';
      const copy = t === 'busy'
        ? { icon: '⏳', msg: 'OpenStreetMap is busy right now.', retry: 'Try again' }
        : t === 'offline'
        ? { icon: '📡', msg: "You're offline. Connect to load discoveries.", retry: null }
        : { icon: '⚠️', msg: "Couldn't reach OpenStreetMap.", retry: 'Try again' };
      list.innerHTML = `
        <div class="empty-state" style="padding:20px;text-align:center">
          <div style="font-size:24px;margin-bottom:6px">${copy.icon}</div>
          <div style="font-size:13px;color:var(--color-text-muted);margin-bottom:${copy.retry ? '12px' : '0'}">${this._esc(copy.msg)}</div>
          ${copy.retry ? `<button class="btn btn-outline btn-sm" onclick="Discover.retry()">${copy.retry}</button>` : ''}
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
    list.innerHTML = visible.map(p => this._renderCard(p)).join('');

    // Whole-card click → open the detail panel. Save and Maps buttons inside
    // stop propagation so they don't double-trigger.
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

    if (moreBtn) {
      const total = this.results.length;
      const showing = Math.min(this._visibleCount, total);
      const hiddenCount = total - showing;
      if (total > this.INITIAL_COUNT) {
        moreBtn.style.display = '';
        if (hiddenCount > 0) {
          // Add up to PAGE_INCREMENT more per click — keeps DOM size bounded
          // and lets the user pace expansion without dumping all results.
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
      } else {
        moreBtn.style.display = 'none';
      }
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

    // Close the saved-Entry backup panel if it happens to be open — they share
    // the third-column slot on desktop.
    if (window.Entries?.closeBackupPanel) Entries.closeBackupPanel();

    const panel = document.getElementById('discover-detail-panel');
    const content = document.getElementById('discover-detail-content');
    const footer = document.getElementById('discover-detail-footer');
    if (!panel || !content || !footer) return;

    const wikiTag = poi.tags?.wikipedia || poi.tags?.['wikipedia:en'];
    const qid = poi.tags?.wikidata;
    const enriching = !!(wikiTag || qid);
    // Need a reverse-geocode if the POI carries no city/state tags — the
    // Google search query is much weaker without those, and the subline is
    // less informative.
    const t = poi.tags || {};
    const hasCity = !!(t['addr:city'] || t['addr:town'] || t['addr:village']);
    const hasState = !!t['addr:state'];
    const needReverse = (!hasCity || !hasState) && poi._reverseAddr === undefined;

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
      if (poi.lat && poi.lng) MapModule.flyTo(poi.lat, poi.lng, 15);
    }, 60);

    // Async: fetch Wikipedia + Wikidata + reverse-geocode in parallel.
    // All cached on the POI / per id-or-tag so repeat opens skip the network.
    if (enriching || needReverse) {
      Promise.all([
        wikiTag ? this._loadWikipedia(wikiTag) : Promise.resolve(null),
        qid ? this._loadWikidata(qid) : Promise.resolve(null),
        needReverse ? this._reverseGeocode(poi) : Promise.resolve(null)
      ]).then(([wiki, wd, _addr]) => {
        // Guard: user may have closed or opened a different POI by then.
        if (this._detailXid !== xid) return;
        const c = document.getElementById('discover-detail-content');
        const f = document.getElementById('discover-detail-footer');
        if (c) c.innerHTML = this._renderDetailContent(poi, wiki, wd, false);
        // Footer re-render is needed when reverse-geocode returned, since
        // poi._reverseAddr changes the Google query and the address row.
        if (f && needReverse) f.innerHTML = this._renderDetailFooter(poi);
      });
    }
  },

  closeDetail() {
    this._detailXid = null;
    const panel = document.getElementById('discover-detail-panel');
    if (panel) panel.style.display = 'none';
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

    // Hero priority: Wikipedia thumb > Wikidata image (Commons) > OSM image tag > gradient
    const heroSrc = wiki?.thumbnail || wd?.image || tags.image || null;
    const heroIcon = this._categoryIcon(poi.category);
    const hero = heroSrc
      ? `<div class="dd-hero" style="background-image:url('${esc(heroSrc)}')"><span class="dd-hero-pill">${esc(poi.category)}</span></div>`
      : `<div class="dd-hero fallback"><span class="dd-hero-pill">${esc(poi.category)}</span><span>${heroIcon}</span></div>`;

    // Subline: distance + operator/region if available. Region falls back to
    // the reverse-geocoded city/state when no addr:* tag is present.
    const distLabel = (poi._approx ? '~' : '') + State.formatDistance(poi.distance) + ' away';
    const revCity = poi._reverseAddr?.city;
    const revState = poi._reverseAddr?.state;
    const region = tags.operator
      || [tags['addr:city'] || revCity, tags['addr:state'] || revState].filter(Boolean).join(', ')
      || '';
    const subline = region ? `${distLabel} · ${esc(region)}` : distLabel;

    // Description priority: Wikipedia extract > OSM description > Wikidata description > empty
    const osmDesc = tags.description || tags['description:en'];
    let descBlock = '';
    if (loading) {
      descBlock = `<div class="dd-loading">Loading description…</div>`;
    } else if (wiki?.extract) {
      descBlock = `
        <div class="dd-description">${esc(wiki.extract)}</div>
        <a href="${esc(wiki.url)}" target="_blank" rel="noopener" class="dd-wiki-link">Read more on Wikipedia →</a>
        <div class="dd-wiki-attribution">Summary from Wikipedia, CC BY-SA 4.0</div>`;
    } else if (osmDesc) {
      descBlock = `<div class="dd-description" style="margin-bottom:18px">${esc(osmDesc)}</div>`;
    } else if (wd?.description) {
      // Wikidata "descriptions" are a one-line gloss, not a full extract — but
      // still better than the generic empty-state when available.
      descBlock = `<div class="dd-description" style="margin-bottom:18px">${esc(wd.description)}</div>`;
    } else if (!tags.website && !tags['contact:website'] && !tags.phone && !wd?.officialWebsite) {
      descBlock = `
        <div class="dd-empty-blurb">
          <strong>No description available</strong>
          This place is in OpenStreetMap but doesn't have a description, Wikipedia article, or website yet. Use the search buttons below to look it up.
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

    // Address (compose from addr:* tags, fall back to reverse-geocoded
    // city/state when only coords are tagged on the POI).
    const addrParts = [
      tags['addr:street'],
      tags['addr:city'] || revCity,
      tags['addr:state'] || revState
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
    const saving = this._savingXids.has(poi.xid);
    const saveBtn = saved
      ? `<button class="btn btn-outline" disabled style="flex:1">✓ Saved</button>`
      : `<button class="btn btn-primary" style="flex:1" ${saving ? 'disabled' : ''}
                 onclick="Discover.savePOI('${poi.xid}')">${saving ? 'Saving…' : '+ Save'}</button>`;

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

  _renderCard(p) {
    // Prefix '~' while distance is still straight-line — driving miles can be
    // 5–10× crow-flies in mountain terrain, so the unprefixed number would
    // actively mislead until ORS Matrix replaces it.
    const distLabel = State.formatDistance
      ? (p._approx ? '~' : '') + State.formatDistance(p.distance) + ' away'
      : (p._approx ? '~' : '') + Math.round(p.distance) + ' mi away';
    const saved = this._alreadySaved(p);
    const saving = this._savingXids.has(p.xid);
    const saveButton = saved
      ? `<span class="discover-saved-badge">✓ Saved</span>`
      : `<button type="button" class="discover-save${saving ? ' loading' : ''}"
                  data-xid="${p.xid}" ${saving ? 'disabled' : ''}>
           ${saving ? 'Saving…' : '+ Save'}
         </button>`;
    const badges = (p.badges || []).map(b =>
      `<span class="discover-badge ${b.kind}">${this._esc(b.label)}</span>`
    ).join('');
    return `
      <div class="discover-card" data-xid="${p.xid}">
        <div class="discover-card-content">
          <div class="discover-card-name">${this._esc(p.name)}</div>
          <div class="discover-card-meta">
            <span class="discover-tag">${this._esc(p.category)}</span>
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

  _esc(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }
};

window.Discover = Discover;
