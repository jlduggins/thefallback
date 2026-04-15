/**
 * The Fallback v2 - Trips Module
 * Journey and leg management
 */

const Trips = {
  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  init() {
    // Subscribe to state changes
    State.on('journeys:changed', () => this.renderAll());
    State.on('journey:current-changed', () => this.renderAll());
    State.on('fuel:changed', () => this.updateFuelSummary());
    State.on('location:updated', () => this.updateTripStatus());
    
    // Initial render
    this.updateFuelSummary();
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // RENDERING
  // ═══════════════════════════════════════════════════════════════════════════
  
  renderAll() {
    this.renderTripStatus();
    this.renderTripsView();
  },
  
  renderTripStatus() {
    const container = document.getElementById('trip-status-card');
    if (!container) return;
    
    const journey = State.getCurrentJourney();
    
    if (!journey || !journey.legs?.length) {
      container.innerHTML = `
        <div class="trip-status-header">
          <div>
            <div class="trip-status-label">No active trip</div>
            <div class="trip-status-destination">Start planning your route</div>
          </div>
        </div>
      `;
      return;
    }
    
    // Find next destination
    const nextLeg = this.findNextLeg(journey);
    const stats = this.calculateJourneyStats(journey);
    
    if (nextLeg) {
      container.innerHTML = `
        <div class="trip-status-header">
          <div>
            <div class="trip-status-label">En route to</div>
            <div class="trip-status-destination">${this.escapeHtml(nextLeg.destName)}</div>
            ${nextLeg.arriveDate ? `
              <div class="trip-status-link">${UI.formatDateShort(nextLeg.arriveDate)}</div>
            ` : ''}
            ${nextLeg.distance ? `
              <div class="trip-status-distance">${State.formatDistance(nextLeg.distance)} · ${State.formatDuration(nextLeg.duration)}</div>
            ` : ''}
          </div>
          <button class="trip-status-share" onclick="Trips.shareNextDestination()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
            </svg>
          </button>
        </div>
        <div class="trip-status-stats">
          <div class="trip-stat">
            <div class="trip-stat-value">${Math.round(stats.totalMiles)}</div>
            <div class="trip-stat-label">Total miles</div>
          </div>
          <div class="trip-stat">
            <div class="trip-stat-value">$${Math.round(stats.totalFuel)}</div>
            <div class="trip-stat-label">Est. fuel</div>
          </div>
          <div class="trip-stat">
            <div class="trip-stat-value">$${Math.round(stats.totalLodging)}</div>
            <div class="trip-stat-label">Lodging</div>
          </div>
        </div>
      `;
    }
  },
  
  renderTripsView() {
    const container = document.getElementById('trips-list');
    if (!container) return;
    
    const journeys = State.journeys;
    const currentJourney = State.getCurrentJourney();
    
    if (journeys.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🗺</div>
          <div class="empty-state-title">No journeys yet</div>
          <div class="empty-state-text">Create a journey to start planning your route with destinations and backups</div>
          <button class="btn btn-primary" onclick="Trips.openNewJourneyModal()">Create Journey</button>
        </div>
      `;
      return;
    }
    
    let html = '';
    
    // Current journey (if any)
    if (currentJourney) {
      html += this.renderCurrentTripCard(currentJourney);
    }
    
    // Other journeys
    const otherJourneys = journeys.filter(j => j.id !== currentJourney?.id);
    if (otherJourneys.length > 0) {
      html += `<div class="trips-section-title">Other Journeys</div>`;
      html += otherJourneys.map(j => this.renderTripCard(j)).join('');
    }
    
    // Add new journey button
    html += `
      <button class="btn btn-outline" style="width: 100%; margin-top: var(--space-4);" onclick="Trips.openNewJourneyModal()">
        + New Journey
      </button>
    `;
    
    container.innerHTML = html;
  },
  
  renderCurrentTripCard(journey) {
    const stats = this.calculateJourneyStats(journey);
    const legs = journey.legs || [];
    
    // Progress visualization
    let progressHtml = '';
    if (legs.length > 0) {
      progressHtml = '<div class="trip-progress">';
      legs.forEach((leg, i) => {
        const isVisited = this.isLegVisited(leg);
        progressHtml += `
          <div class="trip-progress-stop ${isVisited ? 'visited' : ''}">
            <div class="dot"></div>
          </div>
        `;
        if (i < legs.length - 1) {
          progressHtml += '<div class="trip-progress-line"></div>';
        }
      });
      progressHtml += '</div>';
    }
    
    return `
      <div class="current-trip-card" data-id="${journey.id}">
        <div class="current-trip-badge">Current</div>
        <div class="current-trip-name">${this.escapeHtml(journey.name)}</div>
        <div class="current-trip-meta">${legs.length} stops · ${Math.round(stats.totalMiles)} miles</div>
        ${progressHtml}
        <div class="current-trip-footer">
          <span>Est. fuel: $${Math.round(stats.totalFuel)}</span>
          <span>Lodging: $${Math.round(stats.totalLodging)}</span>
        </div>
      </div>
    `;
  },
  
  renderTripCard(journey) {
    const stats = this.calculateJourneyStats(journey);
    const legs = journey.legs || [];
    
    return `
      <div class="trip-card" data-id="${journey.id}" onclick="Trips.selectJourney('${journey.id}')">
        <div class="trip-card-header">
          <div>
            <div class="trip-card-name">${this.escapeHtml(journey.name)}</div>
            <div class="trip-card-meta">${legs.length} stops</div>
          </div>
          <button class="btn btn-ghost btn-icon-sm" onclick="event.stopPropagation(); Trips.openJourneyMenu('${journey.id}')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>
            </svg>
          </button>
        </div>
        <div class="trip-card-stats">
          <span class="trip-card-stat">${Math.round(stats.totalMiles)} mi</span>
          <span class="trip-card-stat">$${Math.round(stats.totalFuel)} fuel</span>
        </div>
      </div>
    `;
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // CALCULATIONS
  // ═══════════════════════════════════════════════════════════════════════════
  
  calculateJourneyStats(journey) {
    const legs = journey.legs || [];
    const { mpg, pricePerGal, priceUnit } = State.fuelSettings;
    
    let totalMiles = 0;
    let totalFuel = 0;
    let totalLodging = 0;
    
    legs.forEach(leg => {
      // Distance
      if (leg.distance) {
        totalMiles += leg.distance;
        
        // Fuel cost
        let pricePerGallon = leg.fuelPrice || pricePerGal;
        if (leg.fuelPriceUnit === 'L' || priceUnit === 'L') {
          pricePerGallon *= State.LITERS_PER_GALLON;
        }
        totalFuel += (leg.distance / mpg) * pricePerGallon;
      }
      
      // Lodging cost
      if (leg.destId) {
        const entry = State.getEntry(leg.destId);
        if (entry?.cost) {
          // Estimate nights based on arrive/depart dates
          const nights = this.calculateNights(leg.arriveDate, leg.departDate) || 1;
          totalLodging += entry.cost * nights;
        }
      }
    });
    
    return { totalMiles, totalFuel, totalLodging };
  },
  
  calculateNights(arriveDate, departDate) {
    if (!arriveDate || !departDate) return 1;
    
    const arrive = new Date(arriveDate);
    const depart = new Date(departDate);
    const diff = (depart - arrive) / (1000 * 60 * 60 * 24);
    
    return Math.max(1, Math.ceil(diff));
  },
  
  findNextLeg(journey) {
    if (!journey?.legs?.length) return null;
    if (!State.userLat || !State.userLng) return journey.legs[0];
    
    // Find the leg where we're closest to the origin
    // (meaning we're on our way to that destination)
    let bestLeg = null;
    let bestScore = Infinity;
    
    journey.legs.forEach(leg => {
      if (!leg.fromLat || !leg.fromLng || !leg.destLat || !leg.destLng) return;
      
      const distToOrigin = State.getDistanceMiles(State.userLat, State.userLng, leg.fromLat, leg.fromLng);
      const distToDest = State.getDistanceMiles(State.userLat, State.userLng, leg.destLat, leg.destLng);
      const legDist = State.getDistanceMiles(leg.fromLat, leg.fromLng, leg.destLat, leg.destLng);
      
      // We're "on" this leg if we're closer to dest than to a point beyond dest
      const progressRatio = distToOrigin / legDist;
      
      if (progressRatio < 1.5 && distToDest < bestScore) {
        bestScore = distToDest;
        bestLeg = leg;
      }
    });
    
    return bestLeg || journey.legs[0];
  },
  
  isLegVisited(leg) {
    if (!leg.departDate) return false;
    return new Date(leg.departDate) < new Date();
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════
  
  updateTripStatus() {
    this.renderTripStatus();
  },
  
  updateFuelSummary() {
    const el = document.getElementById('fuel-summary');
    if (!el) return;
    
    const { fuelType, mpg, pricePerGal, priceUnit } = State.fuelSettings;
    el.textContent = `${fuelType} · ${mpg} mpg · $${pricePerGal.toFixed(2)}/${priceUnit}`;
  },
  
  shareNextDestination() {
    const journey = State.getCurrentJourney();
    if (!journey) return;
    
    const nextLeg = this.findNextLeg(journey);
    if (!nextLeg) return;
    
    const entry = State.getEntry(nextLeg.destId);
    if (entry) {
      Entries.openInMaps(entry);
    } else if (nextLeg.destLat && nextLeg.destLng) {
      // Open raw coordinates
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      const coords = `${nextLeg.destLat},${nextLeg.destLng}`;
      
      if (isIOS) {
        window.location.href = `maps://maps.apple.com/?daddr=${coords}`;
      } else {
        window.open(`https://www.google.com/maps/dir/?api=1&destination=${coords}`, '_blank');
      }
    }
  },
  
  selectJourney(id) {
    // For now, just pin it as current
    Firebase.pinJourney(id);
  },
  
  openJourneyMenu(id) {
    // TODO: Show context menu with options (Set as current, Edit, Delete)
    console.log('Open journey menu:', id);
  },
  
  openNewJourneyModal() {
    UI.openModal('modal-new-journey');
    
    // Reset form
    const nameInput = document.getElementById('journey-name');
    if (nameInput) nameInput.value = '';
  },
  
  closeNewJourneyModal() {
    UI.closeModal('modal-new-journey');
  },
  
  async saveNewJourney() {
    const nameInput = document.getElementById('journey-name');
    const name = nameInput?.value.trim();
    
    if (!name) {
      UI.showToast('Please enter a name', 'error');
      return;
    }
    
    try {
      const id = await Firebase.saveJourney({
        name,
        pinned: State.journeys.length === 0 // Auto-pin first journey
      });
      
      UI.showToast('Journey created', 'success');
      this.closeNewJourneyModal();
      
      // Set as current if it's the first
      if (State.journeys.length === 0) {
        State.setCurrentJourney(id);
      }
    } catch (err) {
      console.error('Save journey error:', err);
      UI.showToast('Failed to create journey', 'error');
    }
  },
  
  openFuelSettingsModal() {
    UI.openModal('modal-fuel-settings');
    
    // Fill current values
    const { fuelType, mpg, pricePerGal, priceUnit, backupRadius } = State.fuelSettings;
    
    document.getElementById('fuel-type').value = fuelType;
    document.getElementById('fuel-mpg').value = mpg;
    document.getElementById('fuel-price').value = pricePerGal;
    document.getElementById('fuel-price-unit').value = priceUnit;
    document.getElementById('backup-radius').value = backupRadius;
  },
  
  closeFuelSettingsModal() {
    UI.closeModal('modal-fuel-settings');
  },
  
  saveFuelSettings() {
    const fuelType = document.getElementById('fuel-type').value;
    const mpg = parseFloat(document.getElementById('fuel-mpg').value) || 18;
    const pricePerGal = parseFloat(document.getElementById('fuel-price').value) || 3.89;
    const priceUnit = document.getElementById('fuel-price-unit').value;
    const backupRadius = parseInt(document.getElementById('backup-radius').value) || 30;
    
    State.setFuelSettings({ fuelType, mpg, pricePerGal, priceUnit, backupRadius });
    
    UI.showToast('Settings saved', 'success');
    this.closeFuelSettingsModal();
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
window.Trips = Trips;
