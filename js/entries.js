/**
 * The Fallback v2 - Entries Module
 * Location CRUD operations and rendering
 */

const Entries = {
  // Current filter
  currentFilter: 'all',
  
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
  },

  updateEntriesCount() {
    const el = document.getElementById('entries-count');
    if (el) {
      const n = State.entries.length;
      el.textContent = `${n} location${n !== 1 ? 's' : ''}`;
    }
  },
  
  initFilters() {
    const filterContainer = document.getElementById('location-filters');
    if (!filterContainer) return;
    
    filterContainer.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      
      const filter = chip.dataset.filter;
      if (!filter) return;
      
      // Update active state
      filterContainer.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      
      // Apply filter
      this.currentFilter = filter;
      this.renderSavedList();
    });
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
    // Star rating
    document.querySelectorAll('#modal-add-location .star').forEach(star => {
      star.addEventListener('click', () => {
        State.currentRating = parseInt(star.dataset.value);
        this.updateStars();
      });
    });
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
    
    let entries = State.entries;
    
    // Apply filter
    if (this.currentFilter === 'nearby') {
      if (State.userLat && State.userLng) {
        entries = State.getNearbyEntries(State.userLat, State.userLng, 50);
      }
    } else if (this.currentFilter === 'planned') {
      entries = entries.filter(e => e.status === 'planned');
    } else if (this.currentFilter === 'visited') {
      entries = entries.filter(e => e.status === 'visited');
    }
    // 'all' shows everything
    
    if (entries.length === 0) {
      const emptyMessage = this.currentFilter === 'all' 
        ? 'Tap the + button to add your first camping spot'
        : `No ${this.currentFilter} locations`;
      
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🗺</div>
          <div class="empty-state-title">No locations</div>
          <div class="empty-state-text">${emptyMessage}</div>
        </div>
      `;
      return;
    }
    
    container.innerHTML = entries.map(entry => this.renderLocationCard(entry)).join('');
    
    // Add click handlers
    container.querySelectorAll('.location-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        
        // Toggle selection - click again to deselect
        if (State.selectedEntryId === id) {
          State.selectEntry(null);
          MapModule.fitAllMarkers();
        } else {
          State.selectEntry(id);
          const entry = State.getEntry(id);
          if (entry && entry.lat && entry.lng) {
            MapModule.flyTo(entry.lat, entry.lng, 14);
          }
        }
      });
    });
  },
  
  renderLocationCard(entry) {
    const isSelected = State.selectedEntryId === entry.id;
    const costLabel = State.costLabel(entry.cost);
    const tags = [];
    
    // Add amenities as tags
    State.AMENITY_META.forEach(am => {
      if (entry[am.id]) {
        tags.push(`<span class="location-card-tag amenity">${am.icon} ${am.label}</span>`);
      }
    });
    
    return `
      <div class="location-card ${isSelected ? 'selected' : ''}" data-id="${entry.id}">
        <div class="location-card-image" style="${entry.photos?.[0] ? `background-image: url(${entry.photos[0]})` : ''}"></div>
        <div class="location-card-content">
          <div class="location-card-name">${this.escapeHtml(entry.name)}</div>
          <div class="location-card-address">${this.escapeHtml(entry.address || entry.type || '')}</div>
          <div class="location-card-tags">
            <span class="location-card-tag cost" style="color: ${State.costColor(entry.cost)}">${costLabel}</span>
            ${tags.slice(0, 3).join('')}
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
    State.pendingPhotos = [];
    
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
    State.pendingPhotos = entry.photos || [];
    
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
    
    // Open modal
    UI.openModal('modal-add-location');
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
      if (address && window.CONFIG?.GEOCODIO_KEY) {
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
      photos: State.pendingPhotos
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
    const key = window.CONFIG?.GEOCODIO_KEY;
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

  // Replace leg[legIndex].dest with backup entry — delegates to Trips.replaceDestinationWithBackup
  // to ensure identical route-recomputation behavior (same getRoute + fuel calc + next-leg update).
  async replaceLegDest(backupEntryId, legIndex) {
    if (!State.currentJourneyId) return;
    if (!window.Trips?.replaceDestinationWithBackup) return;
    // Set the journey context Trips needs, then invoke the shared code path
    Trips.currentDetailJourneyContext = { journeyId: State.currentJourneyId, legIndex };
    Trips.currentDetailEntryId = null; // not used by replaceDestinationWithBackup
    try {
      await Trips.replaceDestinationWithBackup(backupEntryId);
    } finally {
      Trips.currentDetailJourneyContext = null;
    }
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
