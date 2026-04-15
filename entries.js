/**
 * The Fallback v2 - Entries Module
 * Location CRUD operations and rendering
 */

const Entries = {
  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  init() {
    // Subscribe to state changes
    State.on('entries:changed', () => this.renderAll());
    State.on('entry:selected', id => this.showDetail(id));
    State.on('dragpin:moved', ({ lat, lng }) => this.updateCoords(lat, lng));
    
    // Form event listeners
    this.initForm();
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
  },
  
  renderExploreNearby() {
    const container = document.getElementById('nearby-scroll');
    if (!container) return;
    
    // Get nearby entries if we have user location
    let entries = State.entries;
    
    if (State.userLat && State.userLng) {
      entries = State.getNearbyEntries(State.userLat, State.userLng, 100);
    }
    
    // Take first 10
    entries = entries.slice(0, 10);
    
    if (entries.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding: 24px; text-align: center;">
          <div style="font-size: 24px; margin-bottom: 8px;">📍</div>
          <div style="font-size: 14px; color: var(--color-text-muted);">No locations yet</div>
        </div>
      `;
      return;
    }
    
    container.innerHTML = entries.map(entry => this.renderNearbyCard(entry)).join('');
    
    // Add click handlers
    container.querySelectorAll('.nearby-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        State.selectEntry(id);
        State.setView('saved');
        
        const entry = State.getEntry(id);
        if (entry) {
          MapModule.flyTo(entry.lat, entry.lng, 14);
        }
      });
    });
  },
  
  renderNearbyCard(entry) {
    const distance = entry.distance 
      ? State.formatDistance(entry.distance)
      : '';
    
    return `
      <div class="nearby-card" data-id="${entry.id}">
        <div class="nearby-card-image" style="${entry.photos?.[0] ? `background-image: url(${entry.photos[0]})` : ''}"></div>
        <div class="nearby-card-content">
          <div class="nearby-card-name">${this.escapeHtml(entry.name)}</div>
          <div class="nearby-card-meta">${distance || entry.type || ''}</div>
        </div>
      </div>
    `;
  },
  
  renderSavedList() {
    const container = document.getElementById('locations-list');
    if (!container) return;
    
    const entries = State.entries;
    
    if (entries.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🗺</div>
          <div class="empty-state-title">No locations yet</div>
          <div class="empty-state-text">Tap the + button to add your first camping spot</div>
        </div>
      `;
      return;
    }
    
    container.innerHTML = entries.map(entry => this.renderLocationCard(entry)).join('');
    
    // Add click handlers
    container.querySelectorAll('.location-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        State.selectEntry(id);
        
        const entry = State.getEntry(id);
        if (entry) {
          MapModule.flyTo(entry.lat, entry.lng, 14);
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
