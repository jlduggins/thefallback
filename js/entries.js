/**
 * The Fallback v2 - Entries Module
 * Location CRUD operations and rendering
 */

const Entries = {
  // Filter state
  filters: {
    search: '',
    type: new Set(),       // Set of type strings
    status: new Set(),     // Set of status strings
    cost: new Set(),       // Set of range strings
    rating: null,          // single min-rating value
    state: ''              // single state string
  },
  filterPanelOpen: false,
  
  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  init() {
    // Subscribe to state changes
    State.on('entries:changed', () => this.renderAll());
    State.on('entry:selected', id => {
      this.updateSelectedCard(id);
    });
    State.on('dragpin:moved', ({ lat, lng }) => this.updateCoords(lat, lng));
    State.on('fuel:changed', () => this.renderExploreNearby());
    State.on('location:updated', () => this.renderExploreNearby());
    State.on('journeys:changed', () => this.renderExploreNearby());
    State.on('journey:current-changed', () => this.renderExploreNearby());
    // Close the backup detail panel when leaving Explore
    State.on('view:changed', ({ from, to }) => {
      if (from === 'explore' && to !== 'explore') this.closeBackupPanel();
    });

    this.initForm();
    this.initFilters();
    this.updateEntriesCount();
    this._installGlobalSwipeCloser();
  },

  updateEntriesCount() {
    const el = document.getElementById('entries-count');
    if (el) {
      const n = State.entries.length;
      el.textContent = `${n} location${n !== 1 ? 's' : ''}`;
    }
  },
  
  initFilters() {
    // Search input
    const searchInput = document.getElementById('loc-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', e => {
        this.filters.search = e.target.value.trim().toLowerCase();
        this.renderSavedList();
        this.updateActiveChips();
        this.updateFilterCount();
      });
    }

    // Multi-select chip groups
    document.querySelectorAll('.loc-filter-chips').forEach(group => {
      const groupName = group.dataset.filterGroup;
      group.addEventListener('click', e => {
        const chip = e.target.closest('.loc-chip');
        if (!chip) return;
        const value = chip.dataset.value;
        if (groupName === 'rating') {
          // Single-select: clicking active chip clears it
          if (this.filters.rating === value) {
            this.filters.rating = null;
            chip.classList.remove('active');
          } else {
            this.filters.rating = value;
            group.querySelectorAll('.loc-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
          }
        } else {
          // Multi-select
          const set = this.filters[groupName];
          if (set.has(value)) { set.delete(value); chip.classList.remove('active'); }
          else { set.add(value); chip.classList.add('active'); }
        }
        this.renderSavedList();
        this.updateActiveChips();
        this.updateFilterCount();
      });
    });

    // State dropdown
    const stateSel = document.getElementById('loc-filter-state');
    if (stateSel) {
      stateSel.addEventListener('change', e => {
        this.filters.state = e.target.value;
        this.renderSavedList();
        this.updateActiveChips();
        this.updateFilterCount();
      });
    }

    // Populate state dropdown when entries load
    State.on('entries:changed', () => this.populateStateDropdown());
    this.populateStateDropdown();
  },

  // US state bounds for reverse-lookup from entry lat/lng (ported from v1)
  STATE_BOUNDS: {
    'Alabama':{lat:[30.2,35.0],lng:[-88.5,-84.9]},'Alaska':{lat:[51.2,71.4],lng:[-179.2,-129.9]},
    'Arizona':{lat:[31.3,37.0],lng:[-114.8,-109.0]},'Arkansas':{lat:[33.0,36.5],lng:[-94.6,-89.6]},
    'California':{lat:[32.5,42.0],lng:[-124.4,-114.1]},'Colorado':{lat:[37.0,41.0],lng:[-109.1,-102.0]},
    'Connecticut':{lat:[40.9,42.1],lng:[-73.7,-71.8]},'Delaware':{lat:[38.5,39.8],lng:[-75.8,-75.0]},
    'Florida':{lat:[24.5,31.0],lng:[-87.6,-80.0]},'Georgia':{lat:[30.4,35.0],lng:[-85.6,-80.8]},
    'Hawaii':{lat:[18.9,22.2],lng:[-160.2,-154.8]},'Idaho':{lat:[42.0,49.0],lng:[-117.2,-111.0]},
    'Illinois':{lat:[36.9,42.5],lng:[-91.5,-87.5]},'Indiana':{lat:[37.8,41.8],lng:[-88.1,-84.8]},
    'Iowa':{lat:[40.4,43.5],lng:[-96.6,-90.1]},'Kansas':{lat:[37.0,40.0],lng:[-102.1,-94.6]},
    'Kentucky':{lat:[36.5,39.1],lng:[-89.6,-81.9]},'Louisiana':{lat:[29.0,33.0],lng:[-94.0,-89.0]},
    'Maine':{lat:[43.0,47.5],lng:[-71.1,-66.9]},'Maryland':{lat:[37.9,39.7],lng:[-79.5,-75.0]},
    'Massachusetts':{lat:[41.2,42.9],lng:[-73.5,-69.9]},'Michigan':{lat:[41.7,48.2],lng:[-90.4,-82.4]},
    'Minnesota':{lat:[43.5,49.4],lng:[-97.2,-89.5]},'Mississippi':{lat:[30.2,35.0],lng:[-91.7,-88.1]},
    'Missouri':{lat:[36.0,40.6],lng:[-95.8,-89.1]},'Montana':{lat:[44.4,49.0],lng:[-116.0,-104.0]},
    'Nebraska':{lat:[40.0,43.0],lng:[-104.1,-95.3]},'Nevada':{lat:[35.0,42.0],lng:[-120.0,-114.0]},
    'New Hampshire':{lat:[42.7,45.3],lng:[-72.6,-70.7]},'New Jersey':{lat:[38.9,41.4],lng:[-75.6,-73.9]},
    'New Mexico':{lat:[31.3,37.0],lng:[-109.1,-103.0]},'New York':{lat:[40.5,45.0],lng:[-79.8,-71.9]},
    'North Carolina':{lat:[33.8,36.6],lng:[-84.3,-75.5]},'North Dakota':{lat:[45.9,49.0],lng:[-104.1,-96.6]},
    'Ohio':{lat:[38.4,42.0],lng:[-84.8,-80.5]},'Oklahoma':{lat:[33.6,37.0],lng:[-103.0,-94.4]},
    'Oregon':{lat:[42.0,46.3],lng:[-124.6,-116.5]},'Pennsylvania':{lat:[39.7,42.3],lng:[-80.5,-74.7]},
    'Rhode Island':{lat:[41.1,42.0],lng:[-71.9,-71.1]},'South Carolina':{lat:[32.0,35.2],lng:[-83.4,-78.5]},
    'South Dakota':{lat:[42.5,45.9],lng:[-104.1,-96.4]},'Tennessee':{lat:[35.0,36.7],lng:[-90.3,-81.6]},
    'Texas':{lat:[25.8,36.5],lng:[-106.6,-93.5]},'Utah':{lat:[37.0,42.0],lng:[-114.1,-109.0]},
    'Vermont':{lat:[42.7,45.0],lng:[-73.4,-71.5]},'Virginia':{lat:[36.5,39.5],lng:[-83.7,-75.2]},
    'Washington':{lat:[45.5,49.0],lng:[-124.8,-116.9]},'West Virginia':{lat:[37.2,40.6],lng:[-82.6,-77.7]},
    'Wisconsin':{lat:[42.5,47.1],lng:[-92.9,-86.8]},'Wyoming':{lat:[41.0,45.0],lng:[-111.1,-104.1]}
  },

  getStateFromCoords(lat, lng) {
    if (lat == null || lng == null) return null;
    for (const [state, b] of Object.entries(this.STATE_BOUNDS)) {
      if (lat >= b.lat[0] && lat <= b.lat[1] && lng >= b.lng[0] && lng <= b.lng[1]) return state;
    }
    return null;
  },

  _entryState(e) {
    return e.state || this.getStateFromCoords(e.lat, e.lng);
  },

  populateStateDropdown() {
    const sel = document.getElementById('loc-filter-state');
    if (!sel) return;
    const states = [...new Set(State.entries.map(e => this._entryState(e)).filter(Boolean))].sort();
    const currentVal = sel.value;
    sel.innerHTML = '<option value="">All states</option>' +
      states.map(s => `<option value="${this.escapeHtml(s)}">${this.escapeHtml(s)}</option>`).join('');
    if (states.includes(currentVal)) sel.value = currentVal;
  },

  toggleFilterPanel() {
    this.filterPanelOpen = !this.filterPanelOpen;
    const panel = document.getElementById('loc-filter-panel');
    const btn = document.getElementById('loc-filter-toggle');
    if (panel) panel.style.display = this.filterPanelOpen ? 'block' : 'none';
    if (btn) btn.classList.toggle('active', this.filterPanelOpen);
  },

  updateFilterCount() {
    const count = this.filters.type.size + this.filters.status.size + this.filters.cost.size +
      (this.filters.rating ? 1 : 0) + (this.filters.state ? 1 : 0) + (this.filters.search ? 1 : 0);
    const el = document.getElementById('loc-filter-count');
    if (el) {
      el.textContent = count;
      el.style.display = count > 0 ? 'inline-flex' : 'none';
    }
    const clearBtn = document.getElementById('loc-filter-clear');
    if (clearBtn) clearBtn.style.display = count > 0 ? 'inline-flex' : 'none';
  },

  updateActiveChips() {
    const container = document.getElementById('loc-active-chips');
    if (!container) return;
    const chips = [];
    const mk = (label, clearAction) => `<button class="loc-active-chip" onclick="${clearAction}">${this.escapeHtml(label)} <span class="x">×</span></button>`;
    this.filters.type.forEach(v => chips.push(mk(v, `Entries.clearFilter('type','${v}')`)));
    this.filters.status.forEach(v => chips.push(mk(v[0].toUpperCase() + v.slice(1), `Entries.clearFilter('status','${v}')`)));
    this.filters.cost.forEach(v => chips.push(mk(v === '0' ? 'Free' : '$' + v, `Entries.clearFilter('cost','${v}')`)));
    if (this.filters.rating) chips.push(mk('★'.repeat(+this.filters.rating) + '+', `Entries.clearFilter('rating')`));
    if (this.filters.state) chips.push(mk(this.filters.state, `Entries.clearFilter('state')`));
    if (chips.length > 0) chips.push(`<button class="loc-active-clear" onclick="Entries.clearAllFilters()">Clear all</button>`);
    container.innerHTML = chips.join('');
    container.style.display = chips.length > 0 ? 'flex' : 'none';
  },

  clearFilter(group, value) {
    if (group === 'rating') this.filters.rating = null;
    else if (group === 'state') { this.filters.state = ''; const sel = document.getElementById('loc-filter-state'); if (sel) sel.value = ''; }
    else this.filters[group].delete(value);
    // Sync chip active state
    document.querySelectorAll(`.loc-filter-chips[data-filter-group="${group}"] .loc-chip`).forEach(c => {
      if (c.dataset.value === value || group === 'rating') c.classList.remove('active');
    });
    this.renderSavedList();
    this.updateActiveChips();
    this.updateFilterCount();
  },

  clearAllFilters() {
    this.filters.search = '';
    this.filters.type.clear();
    this.filters.status.clear();
    this.filters.cost.clear();
    this.filters.rating = null;
    this.filters.state = '';
    const si = document.getElementById('loc-search-input'); if (si) si.value = '';
    const ss = document.getElementById('loc-filter-state'); if (ss) ss.value = '';
    document.querySelectorAll('.loc-chip').forEach(c => c.classList.remove('active'));
    this.renderSavedList();
    this.updateActiveChips();
    this.updateFilterCount();
  },

  _matchesCostRange(cost, range) {
    if (cost == null) return false;
    if (range === '0') return cost === 0;
    if (range === '1-15') return cost >= 1 && cost <= 15;
    if (range === '16-30') return cost >= 16 && cost <= 30;
    if (range === '31-50') return cost >= 31 && cost <= 50;
    if (range === '51-75') return cost >= 51 && cost <= 75;
    if (range === '76+') return cost >= 76;
    return false;
  },
  
  updateSelectedCard(selectedId) {
    // Update all location cards to reflect selection state
    document.querySelectorAll('.location-card').forEach(card => {
      const isSelected = card.dataset.id === selectedId;
      card.classList.toggle('selected', isSelected);
      
      // Scroll selected card into view
      if (isSelected) {
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  },
  
  initForm() {
    // Render amenity chips from AMENITY_META (uses v1 SVG icons for custom ones)
    const ac = document.getElementById('f-amenities');
    if (ac) {
      ac.innerHTML = State.AMENITY_META.map(a => `
        <label class="toggle-chip" data-amenity="${a.id}">
          <input type="checkbox" name="${a.id}">
          <span class="tc-icon">${a.icon}</span>
          <span class="tc-label">${a.label}</span>
        </label>
      `).join('');
    }

    // Star rating
    document.querySelectorAll('#modal-add-location .star').forEach(star => {
      star.addEventListener('click', () => {
        State.currentRating = parseInt(star.dataset.value);
        this.updateStars();
      });
    });
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PHOTOS (v1-style: base64 compressed, stored inline in Firestore)
  // ═══════════════════════════════════════════════════════════════════════════

  pendingPhotos: [],

  handlePhotos(input) {
    Array.from(input.files).forEach(file => {
      this._compressImage(file, 800, 0.7).then(data => {
        this.pendingPhotos.push({ id: this._genId(), data, name: file.name });
        this.renderPhotoRow();
      }).catch(err => {
        console.error('[Entries] photo compression failed', err);
        const reader = new FileReader();
        reader.onload = ev => {
          this.pendingPhotos.push({ id: this._genId(), data: ev.target.result, name: file.name });
          this.renderPhotoRow();
        };
        reader.readAsDataURL(file);
      });
    });
    input.value = '';
  },

  _compressImage(file, maxWidth, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let w = img.width, h = img.height;
          if (w > maxWidth) { h = h * (maxWidth / w); w = maxWidth; }
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  },

  _genId() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },

  renderPhotoRow() {
    const row = document.getElementById('f-photo-row');
    if (!row) return;
    row.innerHTML = this.pendingPhotos.map(p => `
      <div class="photo-wrap">
        <img src="${p.data}" alt="" onclick="Entries.openPhotoLightbox('${p.id}')"/>
        <button type="button" class="photo-remove" onclick="Entries.removePhoto('${p.id}')">✕</button>
      </div>
    `).join('');
  },

  removePhoto(id) {
    this.pendingPhotos = this.pendingPhotos.filter(p => p.id !== id);
    this.renderPhotoRow();
  },

  openPhotoLightbox(id) {
    const p = this.pendingPhotos.find(x => x.id === id);
    if (!p) return;
    this._showLightbox(p.data);
  },

  _showLightbox(src) {
    let lb = document.getElementById('photo-lightbox');
    if (!lb) {
      lb = document.createElement('div');
      lb.id = 'photo-lightbox';
      lb.className = 'photo-lightbox';
      lb.onclick = () => lb.classList.remove('visible');
      lb.innerHTML = '<img alt="">';
      document.body.appendChild(lb);
    }
    lb.querySelector('img').src = src;
    lb.classList.add('visible');
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // RENDERING
  // ═══════════════════════════════════════════════════════════════════════════
  
  renderAll() {
    this.renderExploreNearby();
    this.renderSavedList();
    this.updateEntriesCount();
  },
  
  renderExploreNearby() {
    const container = document.getElementById('nearby-list');
    if (!container) return;

    // Radius from fuel settings (backupRadius) — these are "backup" nearby spots
    const radius = (State.fuelSettings && State.fuelSettings.backupRadius) || 30;
    const radiusLabel = document.getElementById('nearby-radius-label');

    // Determine the anchor point for "nearby":
    //  - If the user is on a current journey, anchor to the next destination
    //    (or current destination if they've arrived at the final stop)
    //  - Otherwise, anchor to the user's GPS location
    let anchorLat = null, anchorLng = null, anchorLabel = null;
    const ctx = this.computeReplacementContext ? this.computeReplacementContext() : null;
    if (ctx && ctx.journey && ctx.legs.length > 0) {
      // Prefer the next leg's destination (upcoming stop)
      if (ctx.nextLegIndex >= 0 && ctx.nextLegIndex < ctx.legs.length) {
        const nl = ctx.legs[ctx.nextLegIndex];
        const ne = State.getEntry(nl.destId);
        anchorLat = nl.destLat || ne?.lat;
        anchorLng = nl.destLng || ne?.lng;
        anchorLabel = nl.destName || ne?.name;
      }
      // If there's no next leg (final destination) but user is currently at a stop, anchor there
      else if (ctx.currentLegIndex >= 0 && ctx.currentLegRole === 'dest') {
        const cl = ctx.legs[ctx.currentLegIndex];
        const ce = State.getEntry(cl.destId);
        anchorLat = cl.destLat || ce?.lat;
        anchorLng = cl.destLng || ce?.lng;
        anchorLabel = cl.destName || ce?.name;
      }
    }
    // Fallback to GPS
    if (anchorLat == null && State.userLat) {
      anchorLat = State.userLat;
      anchorLng = State.userLng;
      anchorLabel = null; // implicit "you"
    }

    if (radiusLabel) {
      radiusLabel.textContent = anchorLabel
        ? `within ${radius} mi of ${anchorLabel}`
        : `within ${radius} mi`;
    }

    let entries = [];
    if (anchorLat != null && anchorLng != null) {
      entries = State.getNearbyEntries(anchorLat, anchorLng, radius);
      // Exclude the anchor entry itself from the list (it's the destination, not a backup)
      const ctxDestId = ctx?.journey && ctx.nextLegIndex >= 0 && ctx.nextLegIndex < ctx.legs.length
        ? ctx.legs[ctx.nextLegIndex].destId
        : (ctx?.journey && ctx.currentLegIndex >= 0 && ctx.currentLegRole === 'dest'
            ? ctx.legs[ctx.currentLegIndex].destId
            : null);
      if (ctxDestId) entries = entries.filter(e => e.id !== ctxDestId);
    }
    entries = entries.slice(0, 20);

    if (entries.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding: 24px; text-align: center;">
          <div style="font-size: 24px; margin-bottom: 8px;">📍</div>
          <div style="font-size: 14px; color: var(--color-text-muted);">
            ${anchorLat != null ? `No spots within ${radius} miles` : 'Enable location to see nearby spots'}
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = entries.map(entry => this.renderNearbyCard(entry)).join('');

    container.querySelectorAll('.nearby-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        // On Explore view, open the backup detail panel anchored to the left column.
        // Elsewhere, fall back to the legacy behavior (jump to Saved view).
        if (State.currentView === 'explore') {
          this.openBackupPanel(id);
        } else {
          State.selectEntry(id);
          State.setView('saved');
          const entry = State.getEntry(id);
          if (entry) MapModule.flyTo(entry.lat, entry.lng, 14);
        }
      });
    });
  },

  renderNearbyCard(entry) {
    const distance = entry.distance != null
      ? State.formatDistance(entry.distance) + ' away'
      : '';
    const costTag = entry.cost === 0
      ? '<span class="nearby-tag free">Free</span>'
      : entry.cost != null
        ? `<span class="nearby-tag cost">$${entry.cost}</span>`
        : '';
    const tags = [costTag];
    if (entry.hasHookups) tags.push('<span class="nearby-tag">Hookups</span>');
    if (entry.needsReservations) tags.push('<span class="nearby-tag warn">Reservation</span>');

    return `
      <div class="nearby-card" data-id="${entry.id}">
        <div class="nearby-card-thumb"${entry.photos?.[0] ? ` style="background-image:url(${entry.photos[0]})"` : ''}></div>
        <div class="nearby-card-content">
          <div class="nearby-card-name">${this.escapeHtml(entry.name)}</div>
          <div class="nearby-card-meta">${distance}</div>
          <div class="nearby-card-tags">${tags.filter(Boolean).join('')}</div>
        </div>
      </div>
    `;
  },
  
  renderSavedList() {
    const container = document.getElementById('locations-list');
    if (!container) return;

    let entries = State.entries.slice();
    const f = this.filters;

    if (f.search) {
      entries = entries.filter(e => {
        const st = this._entryState(e) || '';
        const hay = `${e.name || ''} ${e.notes || ''} ${e.address || ''} ${e.type || ''} ${st}`.toLowerCase();
        return hay.includes(f.search);
      });
    }
    if (f.type.size > 0) entries = entries.filter(e => f.type.has(e.type));
    if (f.status.size > 0) entries = entries.filter(e => f.status.has(e.status));
    if (f.cost.size > 0) entries = entries.filter(e => [...f.cost].some(r => this._matchesCostRange(e.cost, r)));
    if (f.rating) entries = entries.filter(e => (e.rating || 0) >= +f.rating);
    if (f.state) entries = entries.filter(e => this._entryState(e) === f.state);

    if (entries.length === 0) {
      const hasAnyFilter = f.search || f.type.size || f.status.size || f.cost.size || f.rating || f.state;
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🗺</div>
          <div class="empty-state-title">No locations</div>
          <div class="empty-state-text">${hasAnyFilter ? 'Try adjusting your filters' : 'Tap the + button to add your first camping spot'}</div>
        </div>
      `;
      return;
    }
    
    container.innerHTML = entries.map(entry => this.renderLocationCard(entry)).join('');
    
    // Add click handlers
    container.querySelectorAll('.location-card').forEach(card => {
      card.addEventListener('click', () => {
        // If this card is in "revealed" state, a click closes the swipe instead of selecting
        const row = card.closest('.location-swipe-row');
        if (row && row.classList.contains('revealed')) {
          row.classList.remove('revealed');
          return;
        }
        // Also close any other revealed swipe rows
        container.querySelectorAll('.location-swipe-row.revealed').forEach(r => r.classList.remove('revealed'));

        const id = card.dataset.id;
        if (State.selectedEntryId === id) {
          State.selectEntry(null);
          MapModule.fitAllMarkers();
        } else {
          State.selectEntry(id);
          const entry = State.getEntry(id);
          if (entry && entry.lat && entry.lng) {
            MapModule.flyTo(entry.lat, entry.lng, 14);
          }
          if (window.matchMedia('(max-width: 767px)').matches) {
            document.body.setAttribute('data-drawer-snap', 'half');
          }
        }
      });
    });

    // Swipe-to-reveal-delete on mobile
    if (window.matchMedia('(max-width: 767px)').matches) {
      container.querySelectorAll('.location-swipe-row').forEach(row => this._bindSwipeToDelete(row, container));
    }
  },

  _bindSwipeToDelete(row, container) {
    let startX = 0, startY = 0, tracking = false, decided = false, isHorizontal = false;
    let startState = 'neutral'; // 'neutral' | 'revealed' (delete) | 'revealed-edit'
    const THRESHOLD = 40;

    const onStart = e => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
      decided = false;
      isHorizontal = false;
      if (row.classList.contains('revealed')) startState = 'revealed';
      else if (row.classList.contains('revealed-edit')) startState = 'revealed-edit';
      else startState = 'neutral';
    };
    const onMove = e => {
      if (!tracking) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (!decided) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        isHorizontal = Math.abs(dx) > Math.abs(dy);
        decided = true;
      }
      if (!isHorizontal) return;
      container.querySelectorAll('.location-swipe-row.revealed,.location-swipe-row.revealed-edit').forEach(r => {
        if (r !== row) { r.classList.remove('revealed'); r.classList.remove('revealed-edit'); }
      });
      if (startState === 'neutral') {
        if (dx < -THRESHOLD) { row.classList.add('revealed'); row.classList.remove('revealed-edit'); }
        else if (dx > THRESHOLD) { row.classList.add('revealed-edit'); row.classList.remove('revealed'); }
      } else if (startState === 'revealed') {
        // Delete is open — only a swipe RIGHT (positive dx) can close it, cannot cross to edit
        if (dx > THRESHOLD * 0.5) { row.classList.remove('revealed'); }
      } else if (startState === 'revealed-edit') {
        // Edit is open — only a swipe LEFT (negative dx) can close it
        if (dx < -THRESHOLD * 0.5) { row.classList.remove('revealed-edit'); }
      }
    };
    const onEnd = () => { tracking = false; };

    row.addEventListener('touchstart', onStart, { passive: true });
    row.addEventListener('touchmove', onMove, { passive: true });
    row.addEventListener('touchend', onEnd);
    row.addEventListener('touchcancel', onEnd);
  },

  _installGlobalSwipeCloser() {
    if (this._swipeCloserInstalled) return;
    this._swipeCloserInstalled = true;
    document.addEventListener('click', e => {
      const open = document.querySelectorAll('.location-swipe-row.revealed,.location-swipe-row.revealed-edit');
      if (open.length === 0) return;
      open.forEach(row => {
        if (!row.contains(e.target)) { row.classList.remove('revealed'); row.classList.remove('revealed-edit'); }
      });
    });
  },

  editEntryFromSwipe(id) {
    const row = document.querySelector(`.location-swipe-row[data-id="${id}"]`);
    if (row) { row.classList.remove('revealed'); row.classList.remove('revealed-edit'); }
    const entry = State.getEntry(id);
    if (entry) this.openEditForm(entry);
  },

  deleteEntryFromSwipe(id) {
    const row = document.querySelector(`.location-swipe-row[data-id="${id}"]`);
    if (row) row.classList.remove('revealed');
    // Animate out then delete
    if (row) row.classList.add('removing');
    setTimeout(() => {
      Firebase.deleteEntry(id).catch(err => {
        console.error('[Entries] delete failed', err);
        UI.showToast('Delete failed', 'error');
      });
    }, 180);
  },
  
  renderLocationCard(entry) {
    const isSelected = State.selectedEntryId === entry.id;
    const costLabel = State.costLabel(entry.cost);
    const tags = [];
    State.AMENITY_META.forEach(am => {
      if (entry[am.id]) {
        tags.push(`<span class="location-card-tag amenity">${am.icon} ${am.label}</span>`);
      }
    });

    // Type · Status line (v1 style)
    const typeStatusParts = [];
    if (entry.type) typeStatusParts.push(this.escapeHtml(entry.type));
    if (entry.status) typeStatusParts.push(`<span class="location-card-status">${this.escapeHtml(entry.status[0].toUpperCase() + entry.status.slice(1))}</span>`);
    const typeStatusLine = typeStatusParts.join(' · ');

    // Rating stars (inline top-right)
    const ratingHtml = entry.rating
      ? `<div class="location-card-rating">${'★'.repeat(entry.rating)}<span class="muted">${'★'.repeat(5 - entry.rating)}</span></div>`
      : '';

    // Address (only if different from type)
    const addressHtml = entry.address
      ? `<div class="location-card-address">${this.escapeHtml(entry.address)}</div>`
      : '';

    return `
      <div class="location-swipe-row" data-id="${entry.id}">
        <button class="location-swipe-edit" onclick="Entries.editEntryFromSwipe('${entry.id}')" aria-label="Edit">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          <span>Edit</span>
        </button>
        <button class="location-swipe-delete" onclick="Entries.deleteEntryFromSwipe('${entry.id}')" aria-label="Delete">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          <span>Delete</span>
        </button>
        <div class="location-card ${isSelected ? 'selected' : ''}" data-id="${entry.id}">
          <div class="location-card-image" style="${entry.photos?.[0] ? `background-image: url(${entry.photos[0]})` : ''}"></div>
          <div class="location-card-content">
            <div class="location-card-topline">
              <div class="location-card-name">${this.escapeHtml(entry.name)}</div>
              <div class="location-card-cost" style="color: ${State.costColor(entry.cost)}">${costLabel}</div>
            </div>
            ${typeStatusLine ? `<div class="location-card-typeline">${typeStatusLine}</div>` : ''}
            ${addressHtml}
            ${ratingHtml}
            ${tags.length ? `<div class="location-card-tags">${tags.join('')}</div>` : ''}
          </div>
        </div>
      </div>
    `;
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // DETAIL VIEW
  // ═══════════════════════════════════════════════════════════════════════════
  
  showDetail(id) {
    const entry = State.getEntry(id);
    const panel = document.getElementById('location-detail');
    const content = document.getElementById('location-detail-content');
    
    if (!entry || !panel || !content) {
      if (panel) panel.classList.remove('visible');
      return;
    }
    
    // Build detail HTML
    content.innerHTML = this.renderDetailContent(entry);
    
    // Show panel
    panel.classList.add('visible');
    
    // Action button handlers
    panel.querySelector('.detail-edit-btn')?.addEventListener('click', () => {
      this.openEditForm(entry);
    });
    
    panel.querySelector('.detail-navigate-btn')?.addEventListener('click', () => {
      this.openInMaps(entry);
    });
  },
  
  renderDetailContent(entry) {
    const stars = '★'.repeat(entry.rating || 0) + '☆'.repeat(5 - (entry.rating || 0));
    const costLabel = entry.cost === 0 ? 'Free!' : entry.cost ? `$${entry.cost}/night` : 'Cost unknown';
    
    // Amenities
    const amenities = State.AMENITY_META
      .filter(am => entry[am.id])
      .map(am => `<span class="chip">${am.icon} ${am.label}</span>`)
      .join('');
    
    return `
      <div class="detail-header">
        <h2 class="detail-name">${this.escapeHtml(entry.name)}</h2>
        <div class="detail-type">${entry.type || 'Unknown'}</div>
        <div class="detail-stars">${stars}</div>
      </div>
      
      ${entry.photos?.length ? `
        <div class="detail-photo" style="background-image: url(${entry.photos[0]})"></div>
      ` : ''}
      
      <div class="detail-section">
        <div class="detail-row">
          <span class="detail-label">Cost</span>
          <span class="detail-value" style="color: ${State.costColor(entry.cost)}">${costLabel}</span>
        </div>
        ${entry.address ? `
          <div class="detail-row">
            <span class="detail-label">Address</span>
            <span class="detail-value">${this.escapeHtml(entry.address)}</span>
          </div>
        ` : ''}
        <div class="detail-row">
          <span class="detail-label">Coordinates</span>
          <span class="detail-value">${entry.lat?.toFixed(5)}, ${entry.lng?.toFixed(5)}</span>
        </div>
      </div>
      
      ${amenities ? `
        <div class="detail-section">
          <div class="detail-label">Amenities & Tags</div>
          <div class="detail-chips">${amenities}</div>
        </div>
      ` : ''}
      
      ${entry.notes ? `
        <div class="detail-section">
          <div class="detail-label">Notes</div>
          <div class="detail-notes">${this.escapeHtml(entry.notes)}</div>
        </div>
      ` : ''}
      
      <div class="detail-actions">
        <button class="btn btn-secondary detail-navigate-btn">Navigate</button>
        <button class="btn btn-outline detail-edit-btn">Edit</button>
      </div>
    `;
  },
  
  closeDetail() {
    const panel = document.getElementById('location-detail');
    if (panel) panel.classList.remove('visible');
    State.clearSelection();
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // FORM
  // ═══════════════════════════════════════════════════════════════════════════
  
  resetForm() {
    State.editingEntryId = null;
    State.pendingLat = null;
    State.pendingLng = null;
    State.currentRating = 0;
    this.pendingPhotos = [];
    this.renderPhotoRow();
    
    // Reset form fields
    const form = document.getElementById('modal-add-location');
    if (!form) return;
    
    form.querySelector('#f-name').value = '';
    form.querySelector('#f-address').value = '';
    form.querySelector('#f-coords').value = '';
    form.querySelector('#f-type').value = 'Dispersed';
    form.querySelector('#f-status').value = 'planned';
    form.querySelector('#f-cost').value = '';
    form.querySelector('#f-notes').value = '';
    form.querySelector('#f-link').value = '';
    
    // Reset amenities
    form.querySelectorAll('.toggle-chip').forEach(chip => {
      chip.classList.remove('active');
      chip.querySelector('input').checked = false;
    });
    
    // Reset stars
    this.updateStars();
    
    // Update title
    form.querySelector('.modal-title').textContent = 'Add Location';
  },
  
  openEditForm(entry) {
    State.editingEntryId = entry.id;
    State.pendingLat = entry.lat;
    State.pendingLng = entry.lng;
    State.currentRating = entry.rating || 0;
    // Load existing photos into pending state (support legacy string[] and {id,data}[])
    this.pendingPhotos = (entry.photos || []).map(p => {
      if (typeof p === 'string') return { id: this._genId(), data: p };
      return { id: p.id || this._genId(), data: p.data, name: p.name };
    });
    this.renderPhotoRow();
    
    const form = document.getElementById('modal-add-location');
    if (!form) return;
    
    // Fill form fields
    form.querySelector('#f-name').value = entry.name || '';
    form.querySelector('#f-address').value = entry.address || '';
    form.querySelector('#f-coords').value = entry.lat && entry.lng 
      ? `${entry.lat.toFixed(6)}, ${entry.lng.toFixed(6)}` 
      : '';
    form.querySelector('#f-type').value = entry.type || 'Dispersed';
    form.querySelector('#f-status').value = entry.status || 'planned';
    form.querySelector('#f-cost').value = entry.cost || '';
    form.querySelector('#f-notes').value = entry.notes || '';
    form.querySelector('#f-link').value = entry.link || '';
    
    // Set amenities
    State.AMENITY_META.forEach(am => {
      const chip = form.querySelector(`[data-amenity="${am.id}"]`);
      if (chip) {
        const isActive = entry[am.id];
        chip.classList.toggle('active', isActive);
        chip.querySelector('input').checked = isActive;
      }
    });
    
    // Set stars
    this.updateStars();
    
    // Update title
    form.querySelector('.modal-title').textContent = 'Edit Location';
    
    // Show pin on map
    if (entry.lat && entry.lng) {
      MapModule.showDragPin(entry.lat, entry.lng);
    }
    
    // Close detail panel
    this.closeDetail();
    
    // Open drawer using the unified drawer system
    document.body.classList.add('add-location-drawer-open');
    document.body.style.overflow = '';
    UI.openModal('modal-add-location');
    if (window.matchMedia('(max-width: 767px)').matches) {
      UI.initMobileDrawers();
      UI._applySnap('full');
    }
  },
  
  updateCoords(lat, lng) {
    const coordsInput = document.querySelector('#f-coords');
    if (coordsInput) {
      coordsInput.value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    }
  },
  
  updateStars() {
    document.querySelectorAll('#modal-add-location .star').forEach(star => {
      const val = parseInt(star.dataset.value);
      star.classList.toggle('active', val <= State.currentRating);
    });
  },
  
  async saveEntry() {
    const form = document.getElementById('modal-add-location');
    if (!form) return;
    
    const name = form.querySelector('#f-name').value.trim();
    if (!name) {
      UI.showToast('Please enter a name', 'error');
      return;
    }
    
    // Parse coordinates
    let lat = State.pendingLat;
    let lng = State.pendingLng;
    
    const coordsStr = form.querySelector('#f-coords').value.trim();
    if (coordsStr) {
      const parts = coordsStr.split(',').map(s => parseFloat(s.trim()));
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        lat = parts[0];
        lng = parts[1];
      }
    }
    
    // Geocode address if no coords
    if (!lat && !lng) {
      const address = form.querySelector('#f-address').value.trim();
      if (address && (window.CONFIG?.GEOCODIO_KEY||(typeof CONFIG!=="undefined"&&CONFIG.GEOCODIO_KEY))) {
        try {
          const coords = await this.geocodeAddress(address);
          if (coords) {
            lat = coords.lat;
            lng = coords.lng;
          }
        } catch (err) {
          console.error('Geocoding error:', err);
        }
      }
    }
    
    if (!lat || !lng) {
      UI.showToast('Please add coordinates or drag the pin', 'error');
      return;
    }
    
    // Build entry object
    const entry = {
      id: State.editingEntryId || undefined,
      name,
      address: form.querySelector('#f-address').value.trim(),
      lat,
      lng,
      type: form.querySelector('#f-type').value,
      status: form.querySelector('#f-status').value,
      cost: parseFloat(form.querySelector('#f-cost').value) || null,
      rating: State.currentRating,
      notes: form.querySelector('#f-notes').value.trim(),
      link: form.querySelector('#f-link').value.trim(),
      photos: this.pendingPhotos.map(p => p.data || p)
    };
    
    // Add amenities
    State.AMENITY_META.forEach(am => {
      const chip = form.querySelector(`[data-amenity="${am.id}"]`);
      if (chip) {
        entry[am.id] = chip.classList.contains('active');
      }
    });
    
    try {
      await Firebase.saveEntry(entry);
      UI.showToast(State.editingEntryId ? 'Location updated' : 'Location saved', 'success');
      UI.closeAddModal();
    } catch (err) {
      console.error('Save error:', err);
      UI.showToast('Failed to save', 'error');
    }
  },
  
  async geocodeAddress(address) {
    const key = (window.CONFIG?.GEOCODIO_KEY||(typeof CONFIG!=="undefined"&&CONFIG.GEOCODIO_KEY));
    if (!key) return null;
    
    const response = await fetch(
      `https://api.geocod.io/v1.7/geocode?q=${encodeURIComponent(address)}&api_key=${key}`
    );
    
    if (!response.ok) return null;
    
    const data = await response.json();
    const result = data.results?.[0];
    
    if (result) {
      return {
        lat: result.location.lat,
        lng: result.location.lng
      };
    }
    
    return null;
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // EXPLORE BACKUP DETAIL PANEL
  // Slides in from right edge of .explore-left. Lets the user preview a nearby
  // "backup" spot and optionally save it as a replacement for the current or
  // next leg of their current journey.
  // ═══════════════════════════════════════════════════════════════════════════

  // Tracks which nearby entry the panel is showing
  _backupEntryId: null,

  openBackupPanel(entryId) {
    const entry = State.getEntry(entryId);
    if (!entry) return;
    this._backupEntryId = entryId;

    const panel = document.getElementById('explore-backup-panel');
    const content = document.getElementById('explore-backup-content');
    const footer = document.getElementById('explore-backup-footer');
    if (!panel || !content || !footer) return;

    // Fly map to the entry so the user has spatial context
    if (entry.lat && entry.lng && MapModule.map) {
      MapModule.flyTo(entry.lat, entry.lng, 12);
    }

    // Determine replacement context from the current journey (if any)
    const ctx = this.computeReplacementContext();

    content.innerHTML = this.renderBackupDetailContent(entry, ctx);
    footer.innerHTML = this.renderBackupDetailFooter(entry, ctx);

    panel.style.display = 'flex';

    // Map container just got narrower — tell Leaflet to re-render
    setTimeout(() => { if (MapModule.map) MapModule.map.invalidateSize(); }, 50);
  },

  closeBackupPanel() {
    const panel = document.getElementById('explore-backup-panel');
    if (panel) panel.style.display = 'none';
    this._backupEntryId = null;

    // Map container got wider — tell Leaflet to re-render
    setTimeout(() => { if (MapModule.map) MapModule.map.invalidateSize(); }, 50);
  },

  /**
   * Figure out what "current" and "next" mean for the user's current journey.
   * Returns { journey, legs, currentLegIndex, currentLegRole, nextLegIndex }
   * where currentLegRole is 'dest' (at a leg's destination) or 'start' (at the
   * starting point of the journey), and -1 means "not applicable".
   */
  computeReplacementContext() {
    const journey = State.currentJourneyId ? State.getJourney(State.currentJourneyId) : null;
    if (!journey || !Array.isArray(journey.legs) || journey.legs.length === 0) {
      return { journey: null, legs: [], currentLegIndex: -1, currentLegRole: null, nextLegIndex: -1 };
    }
    const legs = journey.legs;
    const uLat = State.userLat, uLng = State.userLng;
    const PROX = 2;

    let currentLegIndex = -1;
    let currentLegRole = null; // 'start' | 'dest' | null
    let nextLegIndex = -1;

    if (uLat) {
      let closestDist = Infinity;
      // Starting point (leg[0].from*)
      const firstLeg = legs[0];
      const fromE = firstLeg.fromId ? State.getEntry(firstLeg.fromId) : null;
      const fromLat = firstLeg.fromLat || fromE?.lat;
      const fromLng = firstLeg.fromLng || fromE?.lng;
      if (fromLat) {
        const d = State.getDistanceMiles(uLat, uLng, fromLat, fromLng);
        if (d <= PROX) {
          closestDist = d;
          currentLegIndex = 0;
          currentLegRole = 'start';
          nextLegIndex = 0;
        }
      }
      // Each destination
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        const destE = State.getEntry(l.destId);
        const destLat = l.destLat || destE?.lat;
        const destLng = l.destLng || destE?.lng;
        if (destLat) {
          const d = State.getDistanceMiles(uLat, uLng, destLat, destLng);
          if (d <= PROX && d < closestDist) {
            closestDist = d;
            currentLegIndex = i;
            currentLegRole = 'dest';
            nextLegIndex = i + 1;
          }
        }
      }
    }

    // If not at any stop, "next" = the first upcoming destination (legs[0] if no GPS)
    if (currentLegIndex === -1 && legs.length > 0) {
      if (uLat) {
        // Walk legs to find the one the user is still traveling toward
        for (let i = 0; i < legs.length; i++) {
          const l = legs[i];
          if (!l.destLat) continue;
          let originLat, originLng;
          if (i === 0) { originLat = l.fromLat; originLng = l.fromLng; }
          else { originLat = legs[i - 1].destLat; originLng = legs[i - 1].destLng; }
          const distToDest = State.getDistanceMiles(uLat, uLng, l.destLat, l.destLng);
          if (!originLat) { nextLegIndex = i; break; }
          const distToOrigin = State.getDistanceMiles(uLat, uLng, originLat, originLng);
          if (distToDest < distToOrigin || distToOrigin > PROX) { nextLegIndex = i; break; }
        }
        if (nextLegIndex === -1) nextLegIndex = legs.length - 1;
      } else {
        nextLegIndex = 0;
      }
    }

    // Clamp next to valid range
    if (nextLegIndex >= legs.length) nextLegIndex = -1;

    return { journey, legs, currentLegIndex, currentLegRole, nextLegIndex };
  },

  renderBackupDetailContent(entry, ctx) {
    const esc = s => this.escapeHtml(s);
    const hasPhoto = entry.photos?.length > 0;
    const photoUrl = hasPhoto ? (typeof entry.photos[0] === 'string' ? entry.photos[0] : entry.photos[0].data) : null;
    const cost = entry.cost === 0 ? 'Free' : entry.cost != null ? '$' + entry.cost : '--';

    const amap = {
      hasPotableWater: '💧 Water',
      hasDumpStation: '🚿 Dump',
      hasHookups: '⚡ Hookups',
      hasTrash: '🗑 Trash',
      hasWaterFill: '💦 Fill',
      isSeasonal: '📅 Seasonal',
      hasPets: '🐕 Pets OK',
      needs4x4: '🚙 4x4',
      needsReservations: '📋 Reservations'
    };
    const amenities = Object.entries(amap).filter(([k]) => entry[k]).map(([, v]) => v);

    // "Backup option" context pill — shown if we have a current journey
    let contextPill = '';
    if (ctx.journey) {
      contextPill = `
        <div style="display:flex;align-items:center;gap:8px;background:rgba(245,158,11,0.10);border-radius:var(--radius-md);padding:10px 12px;margin-bottom:14px">
          <span style="font-size:16px">💡</span>
          <span style="font-size:13px;font-weight:500;color:#92400e">Backup option</span>
        </div>`;
    }

    return `
      ${contextPill}
      ${hasPhoto ? `<img src="${photoUrl}" style="width:100%;height:140px;object-fit:cover;border-radius:var(--radius-md);margin-bottom:16px">` : ''}
      <div style="font-size:17px;font-weight:600;color:var(--color-text);margin-bottom:4px">${esc(entry.name)}</div>
      <div style="font-size:12px;color:var(--color-text-muted);margin-bottom:16px">${esc(entry.address || entry.type || '')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
        <div style="background:var(--color-surface-alt);border-radius:var(--radius-md);padding:10px">
          <div style="font-size:10px;color:var(--color-text-muted)">Cost/night</div>
          <div style="font-size:15px;font-weight:500;color:var(--color-text)">${cost}</div>
        </div>
        <div style="background:var(--color-surface-alt);border-radius:var(--radius-md);padding:10px">
          <div style="font-size:10px;color:var(--color-text-muted)">Type</div>
          <div style="font-size:15px;font-weight:500;color:var(--color-text)">${esc(entry.type || '--')}</div>
        </div>
      </div>
      ${amenities.length > 0 ? `
        <div style="font-size:11px;font-weight:500;color:var(--color-text-muted);margin-bottom:8px">Amenities</div>
        <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:14px">
          ${amenities.map(a => `<span style="background:var(--color-primary-muted);color:var(--color-primary);font-size:11px;padding:3px 8px;border-radius:var(--radius-sm)">${a}</span>`).join('')}
        </div>
      ` : ''}
      ${entry.notes ? `
        <div style="font-size:11px;font-weight:500;color:var(--color-text-muted);margin-bottom:6px">Notes</div>
        <div style="font-size:13px;color:var(--color-text);line-height:1.5;margin-bottom:14px">${esc(entry.notes)}</div>
      ` : ''}
      ${entry.rating ? `<div style="font-size:14px;margin-bottom:14px">${'★'.repeat(entry.rating)}${'☆'.repeat(5 - entry.rating)}</div>` : ''}
      ${entry.link ? `
        <a href="${entry.link}" target="_blank" rel="noopener" style="display:block;background:var(--color-surface-alt);border-radius:var(--radius-md);padding:10px;text-decoration:none;color:var(--color-text);margin-bottom:14px">
          <div style="display:flex;align-items:center;gap:8px">
            <span>🔗</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(entry.linkTitle || 'View Website')}</div>
              <div style="font-size:11px;color:var(--color-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(entry.link)}</div>
            </div>
            <span style="color:var(--color-primary)">→</span>
          </div>
        </a>
      ` : ''}
    `;
  },

  renderBackupDetailFooter(entry, ctx) {
    const esc = s => this.escapeHtml(s);
    const viewFullBtn = `<button onclick="Entries.viewFullFromBackup('${entry.id}')" class="btn btn-outline" style="width:100%">View full details</button>`;

    // No current journey → just "View full details"
    if (!ctx.journey) {
      return viewFullBtn;
    }

    // Build the list of replacement choices based on context
    const choices = [];
    const legs = ctx.legs;

    if (ctx.currentLegRole === 'start') {
      // At starting point — offer both "replace current (start)" and "replace next dest"
      choices.push({
        label: `Replace starting point`,
        sub: esc(legs[0].fromName || 'Starting point'),
        action: `Entries.replaceStartingPoint('${entry.id}')`
      });
      if (legs.length > 0) {
        choices.push({
          label: `Replace next destination`,
          sub: esc(legs[0].destName || 'Next stop'),
          action: `Entries.replaceLegDest('${entry.id}', 0)`
        });
      }
    } else if (ctx.currentLegRole === 'dest') {
      // At a leg's destination — offer "replace current" and (if exists) "replace next"
      const curIdx = ctx.currentLegIndex;
      choices.push({
        label: `Replace current destination`,
        sub: esc(legs[curIdx].destName || 'Current stop'),
        action: `Entries.replaceLegDest('${entry.id}', ${curIdx})`
      });
      if (curIdx + 1 < legs.length) {
        choices.push({
          label: `Replace next destination`,
          sub: esc(legs[curIdx + 1].destName || 'Next stop'),
          action: `Entries.replaceLegDest('${entry.id}', ${curIdx + 1})`
        });
      }
    } else if (ctx.nextLegIndex >= 0) {
      // En route — only "replace next"
      const nextIdx = ctx.nextLegIndex;
      choices.push({
        label: `Replace next destination`,
        sub: esc(legs[nextIdx].destName || 'Next stop'),
        action: `Entries.replaceLegDest('${entry.id}', ${nextIdx})`
      });
    }

    if (choices.length === 0) {
      return viewFullBtn;
    }

    // Render one orange primary button per choice (Save as replacement style),
    // stacked, with a small subtitle showing which stop it will replace.
    const choiceBtns = choices.map(c => `
      <button onclick="event.stopPropagation();${c.action}"
        style="width:100%;margin-bottom:8px;padding:12px;background:#f59e0b;color:#fff;border:none;border-radius:var(--radius-md);cursor:pointer;text-align:center">
        <div style="font-size:14px;font-weight:600;line-height:1.2">${c.label}</div>
        <div style="font-size:11px;opacity:0.9;margin-top:2px;line-height:1.2">${c.sub}</div>
      </button>
    `).join('');

    return choiceBtns + viewFullBtn;
  },

  viewFullFromBackup(entryId) {
    this.closeBackupPanel();
    State.selectEntry(entryId);
    State.setView('saved');
    const entry = State.getEntry(entryId);
    if (entry) MapModule.flyTo(entry.lat, entry.lng, 14);
  },

  // Replace leg[legIndex].dest with backup entry. Does the swap + route recomputation
  // directly (mirrors Trips.replaceDestinationWithBackup) but WITHOUT the Trips side
  // effects that happen when you're on the Trips view (activating journey overlay,
  // wiping entry markers, triggering refreshAllRoutes). Safe to call from Explore.
  async replaceLegDest(backupEntryId, legIndex) {
    const journey = State.currentJourneyId ? State.getJourney(State.currentJourneyId) : null;
    if (!journey?.legs?.[legIndex]) return;
    const backup = State.getEntry(backupEntryId);
    if (!backup) return;
    if (!window.Trips) return;

    const legs = [...journey.legs];
    const leg = { ...legs[legIndex] };
    leg.destId = backupEntryId;
    leg.destName = backup.name;
    leg.destLat = backup.lat;
    leg.destLng = backup.lng;

    // Resolve "from" coordinates for this leg
    let fromLat, fromLng, fromName;
    if (legIndex > 0) {
      const pl = legs[legIndex - 1];
      if (pl?.destLat) { fromLat = pl.destLat; fromLng = pl.destLng; fromName = pl.destName || 'Previous stop'; }
    } else {
      if (leg.fromLat) { fromLat = leg.fromLat; fromLng = leg.fromLng; fromName = leg.fromName || 'Start'; }
      else if (State.userLat) { fromLat = State.userLat; fromLng = State.userLng; fromName = 'Current Location'; }
    }

    // Recompute this leg's route. Preserve existing geometry on ORS failure
    // rather than nulling it (which would cause a dashed-line regression).
    if (fromLat && backup.lat) {
      try {
        const r = await Trips.getRoute(fromLat, fromLng, backup.lat, backup.lng);
        if (r) {
          leg.distance = Math.round(r.distance);
          leg.duration = Math.round(r.duration);
          leg.fuelCost = Math.round(Trips.calcFuelCost(r.distance, leg.fuelPrice, leg.fuelPriceUnit));
          if (r.geometry) {
            leg.routeGeometry = JSON.stringify(r.geometry);
          }
          // If geometry is null (ORS unavailable), leave leg.routeGeometry as-is from
          // before the replace. It'll be visually slightly off but won't break the map.
          if (legIndex === 0) { leg.fromLat = fromLat; leg.fromLng = fromLng; leg.fromName = fromName; }
        }
      } catch (e) { /* keep prior route data */ }
    }
    legs[legIndex] = leg;

    // Recompute the NEXT leg's route (its origin is now the backup)
    if (legIndex < legs.length - 1) {
      const nl = { ...legs[legIndex + 1] };
      const ne = State.getEntry(nl.destId);
      if (ne?.lat && backup.lat) {
        try {
          const r = await Trips.getRoute(backup.lat, backup.lng, ne.lat, ne.lng);
          if (r) {
            nl.fromLat = backup.lat;
            nl.fromLng = backup.lng;
            nl.fromName = backup.name;
            nl.distance = Math.round(r.distance);
            nl.duration = Math.round(r.duration);
            nl.fuelCost = Math.round(Trips.calcFuelCost(r.distance, nl.fuelPrice, nl.fuelPriceUnit));
            if (r.geometry) {
              nl.routeGeometry = JSON.stringify(r.geometry);
            }
            legs[legIndex + 1] = nl;
          }
        } catch (e) { /* keep prior route data */ }
      }
    }

    await Firebase.saveJourney({ ...journey, legs });
    this.closeBackupPanel();
    UI.showToast('Destination replaced', 'success');
  },

  // Replace the starting point of the journey (leg[0].from*) with a backup entry
  async replaceStartingPoint(backupEntryId) {
    const journey = State.currentJourneyId ? State.getJourney(State.currentJourneyId) : null;
    if (!journey?.legs?.length) return;
    const backup = State.getEntry(backupEntryId);
    if (!backup?.lat) return;

    const legs = [...journey.legs];
    const leg0 = { ...legs[0] };
    leg0.fromId = backupEntryId;
    leg0.fromName = backup.name;
    leg0.fromLat = backup.lat;
    leg0.fromLng = backup.lng;

    // Recompute leg[0]'s route from the new start
    if (leg0.destLat && window.Trips?.getRoute) {
      try {
        const r = await Trips.getRoute(backup.lat, backup.lng, leg0.destLat, leg0.destLng);
        if (r) {
          leg0.distance = Math.round(r.distance);
          leg0.duration = Math.round(r.duration);
          leg0.fuelCost = Math.round(Trips.calcFuelCost(r.distance, leg0.fuelPrice, leg0.fuelPriceUnit));
          leg0.routeGeometry = r.geometry ? JSON.stringify(r.geometry) : null;
        }
      } catch (e) { /* ignore */ }
    }
    legs[0] = leg0;

    await Firebase.saveJourney({ ...journey, legs });
    this.closeBackupPanel();
    UI.showToast('Starting point replaced', 'success');
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // NAVIGATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  openInMaps(entry) {
    if (!entry.lat || !entry.lng) return;
    
    // Detect platform and open appropriate maps app
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const coords = `${entry.lat},${entry.lng}`;
    
    if (isIOS) {
      // Try Apple Maps first, then Google Maps
      window.location.href = `maps://maps.apple.com/?daddr=${coords}`;
    } else {
      // Google Maps
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${coords}`, '_blank');
    }
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════
  
  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
};

// Export
window.Entries = Entries;
