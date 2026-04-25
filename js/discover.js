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
  mode: null,             // 'route' | 'near' | null
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
    ]
  },

  // Approx point sampling along a route. Smaller = denser sampling = more
  // POIs found along windy roads, but bigger query payload.
  SAMPLE_EVERY_MI: 12,
  ROUTE_RADIUS_M: 8000,    // ~5 mi window around each sample point
  NEAR_RADIUS_M: 48000,    // ~30 mi around user GPS in "near" mode
  MAX_SAMPLES: 12,         // cap for the union to keep query body sane
  MAX_RESULTS: 24,
  COLLAPSED_COUNT: 3,

  // ── Init ───────────────────────────────────────────────────────────────
  init() {
    State.on('entries:changed',  () => this.render());
    State.on('journeys:changed', () => this.refresh());
    State.on('journey:current-changed', () => this.refresh());
    State.on('location:updated', () => this.refresh());
    State.on('view:changed', view => { if (view === 'explore') this.refresh(); });
    this.render();
  },

  setCategory(cat) {
    if (this.category === cat) return;
    this.category = cat;
    this.expanded = false;
    this.refresh();
  },

  toggleExpanded() {
    this.expanded = !this.expanded;
    this.render();
  },

  // ── Anchor selection: route vs near vs none ────────────────────────────
  _resolveAnchor() {
    const journey = State.currentJourneyId ? State.getJourney(State.currentJourneyId) : null;
    const legs = journey?.legs || [];
    const withGeom = legs.filter(l => !!l.routeGeometry);

    if (journey && withGeom.length) {
      let samples = [];
      let routeSig = '';
      for (const l of withGeom) {
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

    if (State.userLat != null && State.userLng != null) {
      const sig = `${State.userLat.toFixed(2)},${State.userLng.toFixed(2)}`;
      return {
        mode: 'near',
        samples: [{ lat: State.userLat, lng: State.userLng }],
        radiusM: this.NEAR_RADIUS_M,
        signature: sig,
        label: 'near your location',
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

    const key = `${a.mode}:${a.signature}:${this.category}`;
    if (this._cache[key]) {
      this.results = this._cache[key];
      this.loading = false;
      this.error = null;
      this.render();
      return;
    }

    if (this._inflight[key]) return;
    this._inflight[key] = true;
    this.loading = true;
    this.error = null;
    this.render();

    try {
      const pois = await this._fetchPOIs(a);
      this._cache[key] = pois;
      this.results = pois;
      this.error = null;
    } catch (e) {
      console.error('[Discover] fetch failed:', e);
      this.error = 'Discoveries are temporarily unavailable. Try again in a moment.';
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

    let body = '[out:json][timeout:30];(\n';
    for (const s of samples) {
      for (const sel of tagSelectors) {
        const filter = sel.length === 1
          ? `["${sel[0]}"]`
          : `["${sel[0]}"="${sel[1]}"]`;
        // `nwr` = node + way + relation in one go.
        body += `nwr${filter}(around:${anchor.radiusM},${s.lat},${s.lng});\n`;
      }
    }
    body += ');\nout center tags 250;';

    const r = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(body)
    });
    if (!r.ok) throw new Error('Overpass HTTP ' + r.status);
    const data = await r.json();
    if (!Array.isArray(data.elements)) throw new Error('Overpass: unexpected response');

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
      // Synthesize a name for unnamed utility POIs (dump/water) so they
      // still show up — vanlifers want these even unnamed.
      const name = tags.name
        || tags.operator
        || (tags.amenity === 'sanitary_dump_station' ? 'Dump Station' : null)
        || (tags.amenity === 'drinking_water' ? 'Water Fill-up' : null);
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
        distance: this._haversine(refLat, refLng, lat, lng)
      });
    }
    return [...seen.values()]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, this.MAX_RESULTS);
  },

  // OSM tag → human-readable type label
  _classify(tags) {
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

  // ── Render ─────────────────────────────────────────────────────────────
  render() {
    const wrap = document.getElementById('discover-wrap');
    if (!wrap) return;

    const sub = wrap.querySelector('#discover-subtitle');
    if (sub) {
      sub.textContent = this.mode === 'route'
        ? 'along your route'
        : this.mode === 'near'
          ? 'near your location'
          : '';
    }

    const chipBar = wrap.querySelector('#discover-chips');
    if (chipBar) {
      const chips = [
        ['all',      'All'],
        ['camping',  'Camping'],
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
      list.innerHTML = `
        <div class="empty-state" style="padding:20px;text-align:center">
          <div style="font-size:13px;color:var(--color-text-muted)">${this._esc(this.error)}</div>
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

    const visible = this.expanded
      ? this.results
      : this.results.slice(0, this.COLLAPSED_COUNT);

    list.classList.toggle('expanded', !!this.expanded);
    list.innerHTML = visible.map(p => this._renderCard(p)).join('');

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
        const c = `${lat},${lng}`;
        if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
          window.location.href = `maps://maps.apple.com/?daddr=${c}`;
        } else {
          window.open(`https://www.google.com/maps/dir/?api=1&destination=${c}`, '_blank');
        }
      };
    });

    if (moreBtn) {
      if (this.results.length > this.COLLAPSED_COUNT) {
        moreBtn.style.display = '';
        moreBtn.textContent = this.expanded
          ? 'Show less'
          : `Show more (${this.results.length - this.COLLAPSED_COUNT})`;
        moreBtn.onclick = () => Discover.toggleExpanded();
      } else {
        moreBtn.style.display = 'none';
      }
    }
  },

  _renderCard(p) {
    const distLabel = State.formatDistance
      ? State.formatDistance(p.distance) + ' away'
      : Math.round(p.distance) + ' mi away';
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
