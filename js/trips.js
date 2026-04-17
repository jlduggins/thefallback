/**
 * The Fallback v2 - Trips Module
 * Journey and leg management — panel-based layout
 */

const Trips = {
  editingJourneyId: null,
  _defaultPanelContent: null,
  editingLegIndex: null,
  pendingLegFromId: null,
  legModalInitialState: null,
  returnToLegModalAfterSave: false,
  journeyMarkers: [],
  backupMarkers: [],
  showingBackups: false,
  activeJourneyId: null,
  mapsModalJourneyId: null,
  pendingMapsAction: null,
  currentDetailEntryId: null,
  currentDetailJourneyContext: null,
  viewingBackupForEntryId: null,

  init() {
    State.on('journeys:changed', () => this.renderAll());
    State.on('journey:current-changed', () => this.renderAll());
    State.on('fuel:changed', () => { this.updateFuelSummary(); this.renderJourneys(); });
    State.on('location:updated', () => this.renderTripStatus());
    State.on('view:changed', ({ from, to }) => {
      // Leaving trips view — tear down journey overlay so the map is clean
      if (from === 'trips' && to !== 'trips') {
        if (this.activeJourneyId) {
          this.clearJourneyFromMap();
          // Reset the detail panel back to the list
          const content = document.getElementById('trips-panel-content');
          if (content && this._defaultPanelContent) {
            content.innerHTML = this._defaultPanelContent;
            this._defaultPanelContent = null;
            this.renderJourneys();
            this.updateFuelSummary();
          }
        }
        this.closeLocationDetail();
      }
    });
    this.updateFuelSummary();
    this.initResizeHandles();

    // Intercept backdrop click for unsaved leg modal changes
    const backdrop = document.getElementById('modal-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', (e) => {
        const legModal = document.getElementById('modal-leg');
        if (legModal && legModal.classList.contains('visible')) {
          if (this.hasLegModalChanges()) {
            e.stopImmediatePropagation();
            if (confirm('Unsaved changes. Save before closing?')) this.saveLeg();
            else this.closeLegModal();
          }
        }
      }, true);
    }
  },

  // ─── Resize handles ──────────────────────────────────────────────────────

  initResizeHandles() {
    document.querySelectorAll('.resize-handle[data-resize]').forEach(handle => {
      let startX, startWidth, panel;
      handle.addEventListener('mousedown', e => {
        panel = document.getElementById(handle.dataset.resize);
        if (!panel) return;
        startX = e.clientX;
        startWidth = panel.offsetWidth;
        handle.classList.add('dragging');
        const onMove = e => {
          const w = Math.max(220, Math.min(520, startWidth + (e.clientX - startX)));
          panel.style.width = w + 'px';
          panel.style.minWidth = w + 'px';
          if (MapModule.map) MapModule.map.invalidateSize();
        };
        const onUp = () => {
          handle.classList.remove('dragging');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          if (MapModule.map) MapModule.map.invalidateSize();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
      });
    });
  },

  // ─── Render ──────────────────────────────────────────────────────────────

  renderAll() { this.renderTripStatus(); this.renderJourneys(); },

  renderTripStatus() {
    const el = document.getElementById('trip-status-card');
    if (!el) return;
    const journey = State.getCurrentJourney();
    if (!journey || !journey.legs?.length) {
      el.innerHTML = `<div class="trip-status-header"><div><div class="trip-status-label">No active trip</div><div class="trip-status-destination">Start planning your route</div></div></div>`;
      return;
    }
    const nextLeg = this.findNextLeg(journey);
    const stats = this.calculateJourneyStats(journey);
    if (nextLeg) {
      el.innerHTML = `
        <div class="trip-status-header">
          <div>
            <div class="trip-status-label">En route to</div>
            <div class="trip-status-destination">${this.esc(nextLeg.destName)}</div>
            ${nextLeg.distance ? `<div class="trip-status-distance">${nextLeg.distance} mi · ${this.fmtDuration(nextLeg.duration)}</div>` : ''}
          </div>
          <button class="trip-status-share" onclick="Trips.shareNextDestination()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          </button>
        </div>
        <div class="trip-status-stats">
          <div class="trip-stat"><div class="trip-stat-value">${Math.round(stats.totalMiles)}</div><div class="trip-stat-label">Total miles</div></div>
          <div class="trip-stat"><div class="trip-stat-value">$${Math.round(stats.totalFuel)}</div><div class="trip-stat-label">Est. fuel</div></div>
          <div class="trip-stat accent"><div class="trip-stat-value">$${Math.round(stats.totalLodging)}</div><div class="trip-stat-label">Lodging</div></div>
        </div>`;
    }
  },

  renderJourneys() {
    const list = document.getElementById('journeys-list');
    const noEl = document.getElementById('no-journeys');
    if (!list) return;
    const journeys = State.journeys;
    if (!journeys.length) {
      if (noEl) noEl.style.display = '';
      // Remove any previously rendered section wrappers
      list.querySelectorAll('.journey-section').forEach(c => c.remove());
      return;
    }
    if (noEl) noEl.style.display = 'none';
    // Clean previous render
    list.querySelectorAll('.journey-section').forEach(c => c.remove());

    const pinned = journeys.filter(j => j.pinned);
    const others = journeys.filter(j => !j.pinned)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const renderSection = (title, arr) => {
      if (!arr.length) return;
      const section = document.createElement('div');
      section.className = 'journey-section';
      section.innerHTML = `<div class="journey-section-title">${title}</div>` +
        arr.map(j => this.renderJourneyCard(j)).join('');
      list.appendChild(section);
    };

    renderSection('📌 PINNED', pinned);
    renderSection('ALL JOURNEYS', others);

    // Update journeys count display
    const countEl = document.getElementById('journeys-count');
    if (countEl) countEl.textContent = `${journeys.length} journey${journeys.length !== 1 ? 's' : ''}`;
  },

  renderJourneyCard(j) {
    const legs = j.legs||[];
    const totalMiles = legs.reduce((s,l)=>s+(l.distance||0),0);
    const totalFuel = legs.reduce((s,l)=>s+(l.fuelCost||0),0);
    const totalNights = legs.reduce((s,l)=>{ if(!l.arriveDate||!l.departDate)return s; return s+Math.max(0,Math.round((new Date(l.departDate)-new Date(l.arriveDate))/86400000)); },0);
    const totalLodging = legs.reduce((s,l)=>{ const e=State.getEntry(l.destId); if(!e||!l.arriveDate||!l.departDate)return s; const n=Math.round((new Date(l.departDate)-new Date(l.arriveDate))/86400000); if(n<=0)return s; let c=(e.cost||0)*n; if(e.discountPercent&&e.discountType)c=c*(1-e.discountPercent/100); return s+c; },0);
    const totalCost = Math.round(totalFuel + totalLodging);
    return `
      <div class="journey-card${j.pinned?' pinned':''}" data-id="${j.id}" onclick="Trips.openJourneyDetail('${j.id}')">
        <div class="jcard-top">
          <div class="jcard-info">
            <div class="jcard-name">${this.esc(j.name)}</div>
            <div class="jcard-meta">${legs.length} stop${legs.length!==1?'s':''} · ${Math.round(totalMiles)} mi · ${totalNights} night${totalNights!==1?'s':''}</div>
          </div>
          <div class="jcard-price">
            <div class="jcard-price-val">$${totalCost}</div>
            <div class="jcard-price-lbl">total est.</div>
          </div>
        </div>
        <div class="jcard-budgets">
          <div class="bp muted"><div class="bp-v">$${Math.round(totalLodging)}</div><div class="bp-l">Lodging</div></div>
          <div class="bp muted"><div class="bp-v">$${Math.round(totalFuel)}</div><div class="bp-l">Fuel</div></div>
          <div class="bp accent"><div class="bp-v">$${totalCost}</div><div class="bp-l">Total</div></div>
        </div>
      </div>`;
  },

  // ─── Journey Detail Panel ─────────────────────────────────────────────────

  openJourneyDetail(journeyId) {
    const journey = State.getJourney(journeyId);
    if (!journey) return;
    const legs = journey.legs||[];
    const today = State.today();
    const totalMiles = legs.reduce((s,l)=>s+(l.distance||0),0);
    const totalFuel = legs.reduce((s,l)=>s+(l.fuelCost||0),0);
    const totalNights = legs.reduce((s,l)=>{ if(!l.arriveDate||!l.departDate)return s;return s+Math.max(0,Math.round((new Date(l.departDate)-new Date(l.arriveDate))/86400000));},0);
    const totalLodging = legs.reduce((s,l)=>{ const e=State.getEntry(l.destId);if(!e||!l.arriveDate||!l.departDate)return s;const n=Math.round((new Date(l.departDate)-new Date(l.arriveDate))/86400000);if(n<=0)return s;let c=(e.cost||0)*n;if(e.discountPercent&&e.discountType)c=c*(1-e.discountPercent/100);return s+c;},0);

    let curIdx=-1, atStart=false;
    const uLat=State.userLat, uLng=State.userLng, PROX=2;
    if(uLat){let cl=Infinity;if(legs.length>0&&legs[0].fromLat){const d=this.haversine(uLat,uLng,legs[0].fromLat,legs[0].fromLng);if(d<=PROX&&d<cl){cl=d;atStart=true;curIdx=-1;}}legs.forEach((l,i)=>{if(!l.destLat)return;const d=this.haversine(uLat,uLng,l.destLat,l.destLng);if(d<=PROX&&d<cl){cl=d;atStart=false;curIdx=i;}});}

    // Auto-refresh routes in background if any are missing
    const hasMissingRoute = legs.some(l => !l.routeGeometry && l.destLat);
    if (hasMissingRoute) {
      this.refreshAllRoutes(journeyId).catch(() => {});
    }

    // Store default panel content for restoration on close
    const panelContent = document.getElementById('trips-panel-content');
    if (!panelContent) return;
    if (!this._defaultPanelContent) {
      this._defaultPanelContent = panelContent.innerHTML;
    }

    panelContent.innerHTML = `
      <div class="detail-panel-hd">
        <div class="detail-back-row">
          <button class="detail-back-btn" onclick="Trips.closeJourneyDetail()">← Back to journeys</button>
        </div>
        <div class="detail-panel-nav">
          <div class="detail-journey-name">${this.esc(journey.name)}</div>
          <div class="detail-actions">
            <button class="detail-share-btn" onclick="Trips.openSendToMapsModal('${journey.id}')" title="Share to Maps">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
            </button>
            <div class="detail-menu-wrap">
              <button class="detail-more-btn" onclick="Trips.toggleJourneyDetailMenu('${journey.id}')">⋮</button>
              <div id="journey-detail-menu" class="journey-context-menu" style="right:0">
                <button onclick="Trips.closeJourneyDetailMenu();Trips.editJourneyName('${journey.id}')" class="jmenu-item">Rename</button>
                <button onclick="Trips.closeJourneyDetailMenu();Trips.togglePinJourney('${journey.id}')" class="jmenu-item">${journey.pinned?'Unpin':'Pin'}</button>
                <div style="height:0.5px;background:var(--color-border);margin:4px 0"></div>
                <button onclick="Trips.closeJourneyDetailMenu();Trips.confirmDeleteJourney('${journey.id}')" class="jmenu-item" style="color:var(--color-error)">Delete journey</button>
              </div>
            </div>
          </div>
        </div>
        <div class="detail-journey-meta">${legs.length} stop${legs.length!==1?'s':''} · ${Math.round(totalMiles)} mi · ${totalNights} night${totalNights!==1?'s':''}</div>
        <div class="detail-cost-row">
          <div class="detail-cost-card muted"><div class="detail-cost-label">Est. Lodging</div><div class="detail-cost-value">$${Math.round(totalLodging)}</div></div>
          <div class="detail-cost-card muted"><div class="detail-cost-label">Est. Fuel</div><div class="detail-cost-value">$${Math.round(totalFuel)}</div></div>
          <div class="detail-cost-card accent"><div class="detail-cost-label">Est. Total</div><div class="detail-cost-value">$${Math.round(totalFuel+totalLodging)}</div></div>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto">
        <div class="itin-section-title">Itinerary</div>
        ${legs.length>0&&legs[0].fromName?`
          <div class="leg-stop">
            <div class="leg-stop-line"></div>
            <div class="drag-handle"></div>
            <div class="leg-stop-dot start"></div>
            ${legs[0].fromId?`<div class="leg-stop-name" onclick="Trips.openLocationDetail('${legs[0].fromId}')">${this.esc(legs[0].fromName)}</div>`:`<div class="leg-stop-name muted">${this.esc(legs[0].fromName)}</div>`}
            <div class="leg-stop-dates">${atStart?'📍 Currently here':'Starting point'}</div>
            <div class="leg-drive-info">🚐 ${legs[0].distance||'--'} mi · ${legs[0].duration?Math.floor(legs[0].duration/60)+'h '+Math.round(legs[0].duration%60)+'m':'--'} · $${legs[0].fuelCost||0} fuel</div>
          </div>`:''}
        ${legs.map((l,i)=>{
          const isPast=l.departDate&&l.departDate<today;
          const isCurrent=i===curIdx;
          const entry=State.getEntry(l.destId);
          const nights=l.arriveDate&&l.departDate?Math.max(0,Math.round((new Date(l.departDate)-new Date(l.arriveDate))/86400000)):0;
          let lc=entry?(entry.cost||0)*nights:0; if(entry?.discountPercent&&entry?.discountType)lc=lc*(1-entry.discountPercent/100);
          return `<div class="leg-item leg-stop" draggable="true" data-leg-index="${i}" style="${isPast?'opacity:0.5':''}${isCurrent?'background:var(--color-primary-muted);border-radius:var(--radius-md);':''}">
            ${i<legs.length-1?`<div class="leg-stop-line" style="${isPast?'opacity:0.2':''}"></div>`:''}
            <div class="drag-handle">⋮⋮</div>
            <div class="leg-stop-dot${isCurrent?' here':''}"></div>
            <div class="leg-stop-actions">
              ${lc>0?`<div class="leg-stop-cost">$${Math.round(lc)}</div>`:`<div class="leg-stop-cost free">Free</div>`}
              <div class="leg-stop-edit-btns">
                <button onclick="Trips.editLeg('${journey.id}',${i})" style="background:none;border:none;cursor:pointer;font-size:13px;padding:1px" title="Edit">✏️</button>
                <button onclick="Trips.deleteLeg('${journey.id}',${i})" style="background:none;border:none;cursor:pointer;font-size:13px;padding:1px" title="Delete">🗑</button>
              </div>
            </div>
            <div class="leg-stop-name" onclick="Trips.openLocationDetail('${l.destId}',{journeyId:'${journey.id}',legIndex:${i}})">${this.esc(l.destName)}</div>
            ${isCurrent?`<div class="leg-stop-here">📍 Currently here</div>`:''}
            <div class="leg-stop-dates">${l.arriveDate?new Date(l.arriveDate+'T12:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}):''} ${l.departDate?' – '+new Date(l.departDate+'T12:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}):''} ${nights>0?' · '+nights+' night'+(nights>1?'s':''):''}</div>
            ${l.notes?`<div style="font-size:11px;color:var(--color-text-muted);margin-top:2px;font-style:italic">${this.esc(l.notes)}</div>`:''}
            ${i<legs.length-1?`<div class="leg-drive-info">🚐 ${legs[i+1].distance||'--'} mi · ${legs[i+1].duration?Math.floor(legs[i+1].duration/60)+'h '+Math.round(legs[i+1].duration%60)+'m':'--'} · $${legs[i+1].fuelCost||0} fuel</div>`:''}
          </div>`;
        }).join('')}
        <button class="add-stop-btn" onclick="Trips.openAddLegModal('${journey.id}')">+ Add next destination</button>
      </div>`;

    this.setupLegDragDrop(journeyId);
    this.showJourneyOnMap(journeyId);
    if (MapModule.map) MapModule.map.invalidateSize();
  },

  closeJourneyDetail() {
    const content = document.getElementById('trips-panel-content');
    if (content && this._defaultPanelContent) {
      content.innerHTML = this._defaultPanelContent;
    }
    this._defaultPanelContent = null;
    this.renderJourneys();
    this.updateFuelSummary();
    this.closeLocationDetail();
    this.clearJourneyFromMap();
    if (MapModule.map) MapModule.map.invalidateSize();
  },

  toggleJourneyDetailMenu(journeyId) {
    const m = document.getElementById('journey-detail-menu');
    if (m) m.classList.toggle('open');
  },
  closeJourneyDetailMenu() {
    const m = document.getElementById('journey-detail-menu');
    if (m) m.classList.remove('open');
  },
  editJourneyName(journeyId) {
    const j = State.getJourney(journeyId); if(!j) return;
    this.editingJourneyId = journeyId;
    const inp = document.getElementById('journey-name'); if(inp) inp.value = j.name;
    UI.openModal('modal-new-journey');
  },

  // ─── Leg drag/drop ────────────────────────────────────────────────────────

  setupLegDragDrop(journeyId) {
    const items = document.querySelectorAll('.leg-item');
    let dragged = null;
    items.forEach(item => {
      item.addEventListener('dragstart', e => { dragged=item; item.style.opacity='0.5'; e.dataTransfer.effectAllowed='move'; });
      item.addEventListener('dragend', () => { item.style.opacity=''; dragged=null; items.forEach(i=>i.style.background=''); });
      item.addEventListener('dragover', e => { e.preventDefault(); if(item!==dragged) item.style.background='var(--color-primary-muted)'; });
      item.addEventListener('dragleave', () => { item.style.background=''; });
      item.addEventListener('drop', async e => { e.preventDefault(); item.style.background=''; if(!dragged||item===dragged)return; await this.reorderLegs(journeyId,parseInt(dragged.dataset.legIndex),parseInt(item.dataset.legIndex)); });
    });
  },

  async reorderLegs(journeyId,fromIdx,toIdx) {
    const j=State.getJourney(journeyId); if(!j?.legs)return;
    const legs=[...j.legs]; const[moved]=legs.splice(fromIdx,1); legs.splice(toIdx,0,moved);
    await Firebase.saveJourney({...j,legs}); this.openJourneyDetail(journeyId);
  },

  // ─── Leg Modal ────────────────────────────────────────────────────────────

  openAddLegModal(journeyId, preselectedDestId=null) {
    this.editingJourneyId=journeyId; this.editingLegIndex=null;
    const j=State.getJourney(journeyId), legs=j?.legs||[];
    if(legs.length>0){const last=legs[legs.length-1],e=State.getEntry(last.destId);document.getElementById('leg-from-name').textContent=e?.name||'Previous destination';document.getElementById('leg-from-id').value=last.destId;this.pendingLegFromId=last.destId;document.getElementById('leg-arrive').value=last.departDate||'';}
    else{document.getElementById('leg-from-name').textContent='📍 Current location';document.getElementById('leg-from-id').value='';this.pendingLegFromId=null;document.getElementById('leg-arrive').value='';}
    document.getElementById('leg-from-selected').style.display='block';document.getElementById('leg-from-search').style.display='none';
    ['leg-search','leg-dest-id','leg-depart','leg-notes'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    ['leg-dest-selected','leg-search-results','leg-from-results','leg-preview','leg-backups','leg-fuel-settings','leg-fuel-expanded'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display='none';});
    document.getElementById('leg-fuel-toggle').textContent='▼';
    const{pricePerGal,priceUnit,mpg}=State.fuelSettings;
    document.getElementById('leg-fuel-price').value=pricePerGal;
    document.getElementById('leg-fuel-unit').value=priceUnit||'gal';
    document.getElementById('leg-fuel-default').textContent=`${mpg} mpg, $${pricePerGal.toFixed(2)}/${priceUnit||'gal'}`;
    document.getElementById('leg-backup-radius').textContent=State.fuelSettings.backupRadius||30;
    document.getElementById('leg-save-btn').textContent='Add';
    if(preselectedDestId){const e=State.getEntry(preselectedDestId);if(e)this.selectLegDestination(preselectedDestId);}
    this.storeLegModalInitialState();
    UI.openModal('modal-leg');
  },

  storeLegModalInitialState() { this.legModalInitialState={destId:document.getElementById('leg-dest-id').value,arrive:document.getElementById('leg-arrive').value,depart:document.getElementById('leg-depart').value,notes:document.getElementById('leg-notes').value}; },
  hasLegModalChanges() { if(!this.legModalInitialState)return false;return document.getElementById('leg-dest-id').value!==this.legModalInitialState.destId||document.getElementById('leg-arrive').value!==this.legModalInitialState.arrive||document.getElementById('leg-depart').value!==this.legModalInitialState.depart||document.getElementById('leg-notes').value!==this.legModalInitialState.notes; },
  closeLegModal() { UI.closeModal('modal-leg'); this.returnToLegModalAfterSave=false; this.legModalInitialState=null; },

  clearLegOrigin() { document.getElementById('leg-from-id').value='';this.pendingLegFromId=null;document.getElementById('leg-from-selected').style.display='none';document.getElementById('leg-from-search').style.display='block';document.getElementById('leg-from-search').value='';document.getElementById('leg-from-search').focus(); },

  showFromOptions() {
    const r=document.getElementById('leg-from-results');
    let h=`<div onclick="Trips.selectLegOrigin(null)" style="padding:10px 12px;cursor:pointer;border-bottom:0.5px solid var(--color-border);background:var(--color-primary-muted)" onmouseover="this.style.background='rgba(45,90,71,0.12)'" onmouseout="this.style.background='var(--color-primary-muted)'"><div style="font-size:13px;font-weight:500;color:var(--color-primary)">📍 Use current location</div></div>`;
    h+=State.entries.map(e=>`<div onclick="Trips.selectLegOrigin('${e.id}')" style="padding:10px 12px;cursor:pointer;border-bottom:0.5px solid var(--color-border)" onmouseover="this.style.background='var(--color-surface-alt)'" onmouseout="this.style.background='transparent'"><div style="font-size:13px;font-weight:500;color:var(--color-text)">${this.esc(e.name)}</div><div style="font-size:11px;color:var(--color-text-muted)">${e.type||''}</div></div>`).join('');
    r.innerHTML=h; r.style.display='block';
  },
  searchLocationsForLegFrom(query) { if(!query.trim()){this.showFromOptions();return;} const q=query.toLowerCase(),r=document.getElementById('leg-from-results'); let h=`<div onclick="Trips.selectLegOrigin(null)" style="padding:10px 12px;cursor:pointer;border-bottom:0.5px solid var(--color-border);background:var(--color-primary-muted)"><div style="font-size:13px;font-weight:500;color:var(--color-primary)">📍 Use current location</div></div>`; h+=State.entries.filter(e=>e.name.toLowerCase().includes(q)||(e.address||'').toLowerCase().includes(q)).map(e=>`<div onclick="Trips.selectLegOrigin('${e.id}')" style="padding:10px 12px;cursor:pointer;border-bottom:0.5px solid var(--color-border)" onmouseover="this.style.background='var(--color-surface-alt)'" onmouseout="this.style.background='transparent'"><div style="font-size:13px;font-weight:500;color:var(--color-text)">${this.esc(e.name)}</div><div style="font-size:11px;color:var(--color-text-muted)">${e.type||''}</div></div>`).join(''); r.innerHTML=h; r.style.display='block'; },

  selectLegOrigin(entryId) {
    if(entryId){const e=State.getEntry(entryId);if(!e)return;document.getElementById('leg-from-name').textContent=e.name;document.getElementById('leg-from-id').value=entryId;this.pendingLegFromId=entryId;}
    else{document.getElementById('leg-from-name').textContent='📍 Current location';document.getElementById('leg-from-id').value='';this.pendingLegFromId=null;}
    document.getElementById('leg-from-selected').style.display='block';document.getElementById('leg-from-search').style.display='none';document.getElementById('leg-from-results').style.display='none';
    const destId=document.getElementById('leg-dest-id').value;if(destId){const e=State.getEntry(destId);if(e)this.calculateLegPreview(e);}
  },

  showToOptions() { const q=document.getElementById('leg-search').value.trim();if(q){this.searchLocationsForLeg(q);return;} const r=document.getElementById('leg-search-results'); if(!State.entries.length){r.innerHTML='<div style="padding:12px;font-size:12px;color:var(--color-text-muted)">No locations logged yet</div>';r.style.display='block';return;} r.innerHTML=State.entries.map(e=>`<div onclick="Trips.selectLegDestination('${e.id}')" style="padding:10px 12px;cursor:pointer;border-bottom:0.5px solid var(--color-border)" onmouseover="this.style.background='var(--color-surface-alt)'" onmouseout="this.style.background='transparent'"><div style="font-size:13px;font-weight:500;color:var(--color-text)">${this.esc(e.name)}</div><div style="font-size:11px;color:var(--color-text-muted)">${e.type||''}</div></div>`).join(''); r.style.display='block'; },
  searchLocationsForLeg(query) { if(!query.trim()){this.showToOptions();return;} const q=query.toLowerCase(),matches=State.entries.filter(e=>e.name.toLowerCase().includes(q)||(e.address||'').toLowerCase().includes(q)),r=document.getElementById('leg-search-results'); if(!matches.length){r.innerHTML='<div style="padding:12px;font-size:12px;color:var(--color-text-muted)">No matches found</div>';r.style.display='block';return;} r.innerHTML=matches.map(e=>`<div onclick="Trips.selectLegDestination('${e.id}')" style="padding:10px 12px;cursor:pointer;border-bottom:0.5px solid var(--color-border)" onmouseover="this.style.background='var(--color-surface-alt)'" onmouseout="this.style.background='transparent'"><div style="font-size:13px;font-weight:500;color:var(--color-text)">${this.esc(e.name)}</div><div style="font-size:11px;color:var(--color-text-muted)">${e.type||''}</div></div>`).join(''); r.style.display='block'; },

  selectLegDestination(entryId) { const e=State.getEntry(entryId);if(!e)return; document.getElementById('leg-dest-id').value=entryId;document.getElementById('leg-dest-name').textContent=e.name;document.getElementById('leg-dest-selected').style.display='block';document.getElementById('leg-search').value='';document.getElementById('leg-search-results').style.display='none';document.getElementById('leg-fuel-settings').style.display='block';this.calculateLegPreview(e);if(this.editingLegIndex!==null)this.findBackupOptions(e);else document.getElementById('leg-backups').style.display='none'; },
  clearLegDestination() { document.getElementById('leg-dest-id').value='';document.getElementById('leg-dest-selected').style.display='none';document.getElementById('leg-preview').style.display='none';document.getElementById('leg-backups').style.display='none';document.getElementById('leg-fuel-settings').style.display='none'; },
  addNewLocationFromLeg() { this.returnToLegModalAfterSave=true; this.closeLegModal(); UI.openAddModal(); },
  toggleLegFuelExpand() { const ex=document.getElementById('leg-fuel-expanded'),tg=document.getElementById('leg-fuel-toggle'),op=ex.style.display==='none';ex.style.display=op?'block':'none';tg.textContent=op?'▲':'▼'; },
  updateLegFuelPreview() { const el=document.getElementById('leg-distance');if(!el||el.textContent==='--'||el.textContent==='...')return;const miles=parseFloat(el.textContent.replace(/[^0-9.]/g,''))||0;if(!miles)return;document.getElementById('leg-fuel').textContent=`~$${Math.round(this.calcFuelCost(miles))}`; },

  calcFuelCost(miles,legFuelPrice=null,legFuelUnit=null) { const{mpg,pricePerGal,priceUnit}=State.fuelSettings;const price=legFuelPrice??parseFloat(document.getElementById('leg-fuel-price')?.value)??pricePerGal;const unit=legFuelUnit??document.getElementById('leg-fuel-unit')?.value??priceUnit??'gal';return(miles/mpg)*(unit==='L'?price*3.78541:price); },

  async calculateLegPreview(destEntry) {
    const preview=document.getElementById('leg-preview');let fromLat,fromLng;
    if(this.pendingLegFromId){const f=State.getEntry(this.pendingLegFromId);if(f){fromLat=f.lat;fromLng=f.lng;}}
    if(!fromLat&&State.userLat){fromLat=State.userLat;fromLng=State.userLng;}
    if(!fromLat||!destEntry.lat){preview.style.display='none';return;}
    preview.style.display='block';document.getElementById('leg-distance').textContent='...';document.getElementById('leg-duration').textContent='...';document.getElementById('leg-fuel').textContent='...';
    try{const route=await this.getRoute(fromLat,fromLng,destEntry.lat,destEntry.lng);if(route){const h=Math.floor(route.duration/60),m=Math.round(route.duration%60);document.getElementById('leg-distance').textContent=`${Math.round(route.distance)} mi`;document.getElementById('leg-duration').textContent=h>0?`${h}h ${m}m`:`${m}m`;document.getElementById('leg-fuel').textContent=`~$${Math.round(this.calcFuelCost(route.distance))}`;}}
    catch(e){const miles=this.haversine(fromLat,fromLng,destEntry.lat,destEntry.lng);document.getElementById('leg-distance').textContent=`~${Math.round(miles)} mi`;document.getElementById('leg-duration').textContent='--';document.getElementById('leg-fuel').textContent=`~$${Math.round(this.calcFuelCost(miles))}`;}
  },

  findBackupOptions(destEntry) { if(!destEntry.lat)return;const radius=State.fuelSettings.backupRadius||30,arriveDate=document.getElementById('leg-arrive').value;const backups=State.entries.filter(e=>{if(e.id===destEntry.id||!e.lat)return false;if(this.haversine(destEntry.lat,destEntry.lng,e.lat,e.lng)>radius)return false;if(e.isSeasonal&&arriveDate&&!this.isInSeason(arriveDate))return false;return true;});const el=document.getElementById('leg-backups');if(backups.length>0){document.getElementById('leg-backup-count').textContent=`${backups.length} backup option${backups.length>1?'s':''}`;document.getElementById('leg-backup-radius').textContent=radius;el.style.display='block';el._backups=backups;}else el.style.display='none'; },

  showBackupOptions() { const el=document.getElementById('leg-backups'),backups=el._backups||[];if(!backups.length)return;const destEntry=State.getEntry(document.getElementById('leg-dest-id').value),r=document.getElementById('leg-search-results'); r.innerHTML='<div style="padding:8px 12px;font-size:11px;font-weight:500;color:var(--color-primary);background:var(--color-primary-muted);border-bottom:0.5px solid var(--color-border)">BACKUP OPTIONS</div>'+backups.map(e=>{const d=destEntry?Math.round(this.haversine(destEntry.lat,destEntry.lng,e.lat,e.lng)):0;return`<div onclick="Trips.selectLegDestination('${e.id}')" style="padding:10px 12px;cursor:pointer;border-bottom:0.5px solid var(--color-border)" onmouseover="this.style.background='var(--color-surface-alt)'" onmouseout="this.style.background='transparent'"><div style="display:flex;justify-content:space-between"><div style="font-size:13px;font-weight:500;color:var(--color-text)">${this.esc(e.name)}</div><div style="font-size:11px;color:var(--color-text-muted)">${d}mi away</div></div><div style="font-size:11px;color:var(--color-text-muted)">${e.type||''}</div></div>`;}).join('');r.style.display='block'; },

  async saveLeg() {
    const destId=document.getElementById('leg-dest-id').value;if(!destId){alert('Please select a destination');return;}
    const destEntry=State.getEntry(destId);
    const arriveDate=document.getElementById('leg-arrive').value,departDate=document.getElementById('leg-depart').value,notes=document.getElementById('leg-notes').value.trim();
    const legFuelPrice=parseFloat(document.getElementById('leg-fuel-price').value)||State.fuelSettings.pricePerGal;
    const legFuelUnit=document.getElementById('leg-fuel-unit').value||'gal';
    const fromId=document.getElementById('leg-from-id').value;
    let fromLat,fromLng,fromName;
    if(fromId){const fromEntry=State.getEntry(fromId);if(fromEntry?.lat){fromLat=fromEntry.lat;fromLng=fromEntry.lng;fromName=fromEntry.name;}else if(this.editingLegIndex!==null&&this.editingLegIndex>0){const j=State.getJourney(this.editingJourneyId);const pl=j?.legs?.[this.editingLegIndex-1];if(pl?.destLat){fromLat=pl.destLat;fromLng=pl.destLng;fromName=pl.destName||'Previous stop';}}if(!fromLat){alert('Selected starting location has no coordinates.');return;}}
    else{if(State.userLat){fromLat=State.userLat;fromLng=State.userLng;fromName='Current Location';}else{alert('Location not available. Allow location access or choose a saved starting point.');return;}}
    let distance=0,duration=0,fuelCost=0,routeGeometry=null;
    if(fromLat&&destEntry.lat){try{const route=await this.getRoute(fromLat,fromLng,destEntry.lat,destEntry.lng);if(route){distance=Math.round(route.distance);duration=Math.round(route.duration);fuelCost=Math.round(this.calcFuelCost(route.distance,legFuelPrice,legFuelUnit));routeGeometry=route.geometry;}}catch(e){distance=Math.round(this.haversine(fromLat,fromLng,destEntry.lat,destEntry.lng)*1.3);duration=Math.round(distance/45*60);fuelCost=Math.round(this.calcFuelCost(distance,legFuelPrice,legFuelUnit));}}
    const leg={destId,destName:destEntry.name,destLat:destEntry.lat,destLng:destEntry.lng,fromId:fromId||null,fromName:fromName||null,fromLat:fromLat||null,fromLng:fromLng||null,arriveDate,departDate,notes,distance,duration,fuelCost,fuelPrice:legFuelPrice,fuelPriceUnit:legFuelUnit,routeGeometry:routeGeometry?JSON.stringify(routeGeometry):null};
    const journey=State.getJourney(this.editingJourneyId);if(!journey)return;
    const updatedLegs=[...(journey.legs||[])];
    if(this.editingLegIndex!==null){updatedLegs[this.editingLegIndex]=leg;if(this.editingLegIndex<updatedLegs.length-1){const nl={...updatedLegs[this.editingLegIndex+1]},ne=State.getEntry(nl.destId);if(ne?.lat&&destEntry.lat){try{const r=await this.getRoute(destEntry.lat,destEntry.lng,ne.lat,ne.lng);if(r){nl.fromLat=destEntry.lat;nl.fromLng=destEntry.lng;nl.fromName=destEntry.name;nl.distance=Math.round(r.distance);nl.duration=Math.round(r.duration);nl.fuelCost=Math.round(this.calcFuelCost(r.distance,nl.fuelPrice,nl.fuelPriceUnit));nl.routeGeometry=r.geometry?JSON.stringify(r.geometry):null;updatedLegs[this.editingLegIndex+1]=nl;}}catch(e){}}}}
    else{updatedLegs.push(leg);}
    await Firebase.saveJourney({...journey,legs:updatedLegs});
    this.closeLegModal();
    setTimeout(()=>this.openJourneyDetail(this.editingJourneyId),100);
  },

  async editLeg(journeyId,legIndex) {
    const j=State.getJourney(journeyId);if(!j?.legs?.[legIndex])return;
    const leg=j.legs[legIndex];this.editingJourneyId=journeyId;this.editingLegIndex=legIndex;
    if(legIndex>0){const pl=j.legs[legIndex-1],pe=State.getEntry(pl.destId);document.getElementById('leg-from-name').textContent=pe?.name||'Previous stop';document.getElementById('leg-from-id').value=pl.destId;this.pendingLegFromId=pl.destId;}
    else{document.getElementById('leg-from-name').textContent='📍 Starting point';document.getElementById('leg-from-id').value='';this.pendingLegFromId=null;}
    document.getElementById('leg-from-selected').style.display='block';document.getElementById('leg-from-search').style.display='none';
    document.getElementById('leg-dest-id').value=leg.destId;document.getElementById('leg-dest-name').textContent=leg.destName;document.getElementById('leg-dest-selected').style.display='block';document.getElementById('leg-search').value='';document.getElementById('leg-search-results').style.display='none';
    document.getElementById('leg-arrive').value=leg.arriveDate||'';document.getElementById('leg-depart').value=leg.departDate||'';document.getElementById('leg-notes').value=leg.notes||'';
    document.getElementById('leg-fuel-settings').style.display='block';document.getElementById('leg-fuel-price').value=leg.fuelPrice||State.fuelSettings.pricePerGal;document.getElementById('leg-fuel-unit').value=leg.fuelPriceUnit||'gal';document.getElementById('leg-fuel-expanded').style.display='none';document.getElementById('leg-fuel-toggle').textContent='▼';
    const{mpg,pricePerGal,priceUnit}=State.fuelSettings;document.getElementById('leg-fuel-default').textContent=`${mpg} mpg, $${pricePerGal.toFixed(2)}/${priceUnit||'gal'}`;document.getElementById('leg-backup-radius').textContent=State.fuelSettings.backupRadius||30;
    document.getElementById('leg-save-btn').textContent='Save';
    const de=State.getEntry(leg.destId);if(de){this.calculateLegPreview(de);this.findBackupOptions(de);}
    this.storeLegModalInitialState();UI.openModal('modal-leg');
  },

  async deleteLeg(journeyId,legIndex) {
    if(!confirm('Delete this stop?'))return;
    const j=State.getJourney(journeyId);if(!j?.legs)return;
    const legs=[...j.legs];legs.splice(legIndex,1);
    if(legIndex>0&&legIndex<legs.length){const pl=legs[legIndex-1],nl=legs[legIndex],pe=State.getEntry(pl.destId),ne=State.getEntry(nl.destId);if(pe?.lat&&ne?.lat){try{const r=await this.getRoute(pe.lat,pe.lng,ne.lat,ne.lng);if(r){nl.fromLat=pe.lat;nl.fromLng=pe.lng;nl.fromName=pe.name;nl.distance=Math.round(r.distance);nl.duration=Math.round(r.duration);nl.fuelCost=Math.round(this.calcFuelCost(r.distance));nl.routeGeometry=r.geometry?JSON.stringify(r.geometry):null;}}catch(e){}}}
    await Firebase.saveJourney({...j,legs});this.openJourneyDetail(journeyId);
  },

  // ─── Location Detail Panel ────────────────────────────────────────────────

  openLocationDetail(entryId,journeyContext=null) {
    const entry=State.getEntry(entryId);if(!entry)return;
    this.currentDetailEntryId=entryId;this.currentDetailJourneyContext=journeyContext;this.viewingBackupForEntryId=null;
    const content=document.getElementById('location-detail-content'),footer=document.getElementById('location-detail-footer');
    if(!content||!footer)return;
    const hasPhoto=entry.photos?.length>0,photoUrl=hasPhoto?(typeof entry.photos[0]==='string'?entry.photos[0]:entry.photos[0].data):null;
    const cost=entry.cost===0?'Free':entry.cost!=null?'$'+entry.cost:'--';
    const amap={hasPotableWater:'💧 Water',hasDumpStation:'🚿 Dump',hasHookups:'⚡ Hookups',hasTrash:'🗑 Trash',hasWaterFill:'💦 Fill',isSeasonal:'📅 Seasonal',hasPets:'🐕 Pets OK',needs4x4:'🚙 4x4',needsReservations:'📋 Reservations'};
    const amenities=Object.entries(amap).filter(([k])=>entry[k]).map(([,v])=>v);
    content.innerHTML=`
      ${hasPhoto?`<img src="${photoUrl}" style="width:100%;height:140px;object-fit:cover;border-radius:var(--radius-md);margin-bottom:16px">`:''}
      <div style="font-size:17px;font-weight:500;color:var(--color-text);margin-bottom:4px">${this.esc(entry.name)}</div>
      <div style="font-size:12px;color:var(--color-text-muted);margin-bottom:16px">${entry.address||entry.type||''}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
        <div style="background:var(--color-surface-alt);border-radius:var(--radius-md);padding:10px"><div style="font-size:10px;color:var(--color-text-muted)">Cost/night</div><div style="font-size:15px;font-weight:500;color:var(--color-text)">${cost}</div></div>
        <div style="background:var(--color-surface-alt);border-radius:var(--radius-md);padding:10px"><div style="font-size:10px;color:var(--color-text-muted)">Type</div><div style="font-size:15px;font-weight:500;color:var(--color-text)">${entry.type||'--'}</div></div>
      </div>
      ${entry.discountType&&entry.discountPercent?`<div style="background:rgba(184,85,211,0.08);border-radius:var(--radius-md);padding:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:10px;color:#8B3BA8">Discount</div><div style="font-size:13px;font-weight:500;color:#8B3BA8">${entry.discountType}</div></div><div style="font-size:17px;font-weight:500;color:#8B3BA8">${entry.discountPercent}% off</div></div>`:''}
      ${amenities.length>0?`<div style="font-size:11px;font-weight:500;color:var(--color-text-muted);margin-bottom:8px">Amenities</div><div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:14px">${amenities.map(a=>`<span style="background:var(--color-primary-muted);color:var(--color-primary);font-size:11px;padding:3px 8px;border-radius:var(--radius-sm)">${a}</span>`).join('')}</div>`:''}
      ${entry.notes?`<div style="font-size:11px;font-weight:500;color:var(--color-text-muted);margin-bottom:6px">Notes</div><div style="font-size:13px;color:var(--color-text);line-height:1.5;margin-bottom:14px">${this.esc(entry.notes)}</div>`:''}
      ${entry.rating?`<div style="font-size:14px;margin-bottom:14px">${'★'.repeat(entry.rating)}${'☆'.repeat(5-entry.rating)}</div>`:''}
      ${entry.link?`<a href="${entry.link}" target="_blank" rel="noopener" style="display:block;background:var(--color-surface-alt);border-radius:var(--radius-md);padding:10px;text-decoration:none;color:var(--color-text);margin-bottom:14px"><div style="display:flex;align-items:center;gap:8px"><span>🔗</span><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${entry.linkTitle||'View Website'}</div><div style="font-size:11px;color:var(--color-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${entry.link}</div></div><span style="color:var(--color-primary)">→</span></div></a>`:''}`;

    if(journeyContext&&entry.lat){
      const radius=State.fuelSettings.backupRadius||30;
      const j=State.getJourney(journeyContext.journeyId),leg=j?.legs?.[journeyContext.legIndex];
      const backups=State.entries.filter(e=>{if(e.id===entry.id||!e.lat)return false;if(this.haversine(entry.lat,entry.lng,e.lat,e.lng)>radius)return false;if(e.isSeasonal&&leg?.arriveDate&&!this.isInSeason(leg.arriveDate))return false;return true;});
      if(backups.length>0){content.innerHTML+=`<div style="margin-top:16px;padding-top:16px;border-top:0.5px solid var(--color-border)"><div style="font-size:11px;font-weight:500;color:var(--color-text-muted);margin-bottom:10px">💡 Backup Options (within ${radius}mi)</div><div style="display:flex;flex-direction:column;gap:7px">${backups.map(b=>{const d=Math.round(this.haversine(entry.lat,entry.lng,b.lat,b.lng));const bc=b.cost===0?'Free':b.cost!=null?'$'+b.cost+'/night':'';return`<div onclick="Trips.openBackupLocationDetail('${b.id}')" style="background:rgba(245,158,11,0.08);border-radius:var(--radius-md);padding:10px 12px;cursor:pointer" onmouseover="this.style.background='rgba(245,158,11,0.14)'" onmouseout="this.style.background='rgba(245,158,11,0.08)'"><div style="display:flex;justify-content:space-between"><div><div style="font-size:13px;font-weight:500;color:var(--color-text)">${this.esc(b.name)}</div><div style="font-size:11px;color:var(--color-text-muted)">${b.type||''}${bc?' · '+bc:''}</div></div><div style="font-size:12px;font-weight:500;color:#92400e">${d}mi</div></div></div>`;}).join('')}</div></div>`;}
      footer.innerHTML=`<button onclick="Trips.editDestinationFromDetail()" class="btn btn-primary" style="width:100%;margin-bottom:8px">Edit destination</button><button onclick="Trips.editLocationFromDetail()" class="btn btn-outline" style="width:100%">Edit location details</button>`;
    } else {
      footer.innerHTML=`<button onclick="Trips.editLocationFromDetail()" class="btn btn-primary" style="width:100%">Edit location</button>`;
    }

    const panel=document.getElementById('location-detail-panel');
    if(panel){panel.style.display='flex';}
    const rh=document.querySelector('.trips-location-resize');
    if(rh)rh.style.display='';
    if(MapModule.map)MapModule.map.invalidateSize();
  },

  closeLocationDetail() {
    const panel=document.getElementById('location-detail-panel');
    if(panel)panel.style.display='none';
    const rh=document.querySelector('.trips-location-resize');
    if(rh)rh.style.display='none';
    this.currentDetailEntryId=null;this.currentDetailJourneyContext=null;
    if(MapModule.map)MapModule.map.invalidateSize();
  },

  editLocationFromDetail() { if(!this.currentDetailEntryId)return;this.closeLocationDetail();const e=State.getEntry(this.currentDetailEntryId);if(e)Entries.openEditForm(e); },
  editDestinationFromDetail() { if(!this.currentDetailJourneyContext)return;const{journeyId,legIndex}=this.currentDetailJourneyContext;this.closeLocationDetail();this.editLeg(journeyId,legIndex); },

  openBackupLocationDetail(backupEntryId) {
    const b=State.getEntry(backupEntryId);if(!b)return;
    this.viewingBackupForEntryId=this.currentDetailEntryId;
    const content=document.getElementById('location-detail-content'),footer=document.getElementById('location-detail-footer');
    const cost=b.cost===0?'Free':b.cost!=null?'$'+b.cost:'--';
    content.innerHTML=`<button onclick="Trips.backToOriginalLocation()" style="background:none;border:none;color:var(--color-primary);font-size:13px;font-weight:500;cursor:pointer;padding:0;margin-bottom:12px">← Back</button><div style="display:inline-block;background:#f59e0b;color:white;font-size:10px;font-weight:500;padding:3px 8px;border-radius:var(--radius-sm);margin-bottom:8px">BACKUP OPTION</div><div style="font-size:17px;font-weight:500;color:var(--color-text);margin-bottom:4px">${this.esc(b.name)}</div><div style="font-size:12px;color:var(--color-text-muted);margin-bottom:16px">${b.address||b.type||''}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px"><div style="background:var(--color-surface-alt);border-radius:var(--radius-md);padding:10px"><div style="font-size:10px;color:var(--color-text-muted)">Cost/night</div><div style="font-size:15px;font-weight:500;color:var(--color-text)">${cost}</div></div><div style="background:var(--color-surface-alt);border-radius:var(--radius-md);padding:10px"><div style="font-size:10px;color:var(--color-text-muted)">Type</div><div style="font-size:15px;font-weight:500;color:var(--color-text)">${b.type||'--'}</div></div></div>${b.notes?`<div style="font-size:13px;color:var(--color-text);line-height:1.5">${this.esc(b.notes)}</div>`:''}`;
    footer.innerHTML=`<button onclick="Trips.replaceDestinationWithBackup('${backupEntryId}')" class="btn btn-primary" style="width:100%;background:#f59e0b;border-color:#f59e0b">Use as destination</button>`;
  },

  backToOriginalLocation() { if(this.viewingBackupForEntryId)this.openLocationDetail(this.viewingBackupForEntryId,this.currentDetailJourneyContext); },

  async replaceDestinationWithBackup(backupEntryId) {
    if(!this.currentDetailJourneyContext)return;const{journeyId,legIndex}=this.currentDetailJourneyContext,j=State.getJourney(journeyId);if(!j?.legs?.[legIndex])return;
    const backupEntry=State.getEntry(backupEntryId);if(!backupEntry)return;
    const legs=[...j.legs];const leg={...legs[legIndex]};leg.destId=backupEntryId;leg.destName=backupEntry.name;leg.destLat=backupEntry.lat;leg.destLng=backupEntry.lng;
    let fromLat,fromLng,fromName;
    if(legIndex>0){const pl=legs[legIndex-1];if(pl?.destLat){fromLat=pl.destLat;fromLng=pl.destLng;fromName=pl.destName||'Previous stop';}else{alert('Cannot calculate route: previous stop has no coordinates.');return;}}
    else{if(leg.fromLat){fromLat=leg.fromLat;fromLng=leg.fromLng;fromName=leg.fromName||'Start';}else if(State.userLat){fromLat=State.userLat;fromLng=State.userLng;fromName='Current Location';}else{alert('Location not available.');return;}}
    if(fromLat&&backupEntry.lat){try{const r=await this.getRoute(fromLat,fromLng,backupEntry.lat,backupEntry.lng);if(r){leg.distance=Math.round(r.distance);leg.duration=Math.round(r.duration);leg.fuelCost=Math.round(this.calcFuelCost(r.distance,leg.fuelPrice,leg.fuelPriceUnit));leg.routeGeometry=r.geometry?JSON.stringify(r.geometry):null;if(legIndex===0){leg.fromLat=fromLat;leg.fromLng=fromLng;leg.fromName=fromName;}}}catch(e){}}
    legs[legIndex]=leg;
    if(legIndex<legs.length-1){const nl={...legs[legIndex+1]},ne=State.getEntry(nl.destId);if(ne?.lat&&backupEntry.lat){try{const r=await this.getRoute(backupEntry.lat,backupEntry.lng,ne.lat,ne.lng);if(r){nl.fromLat=backupEntry.lat;nl.fromLng=backupEntry.lng;nl.fromName=backupEntry.name;nl.distance=Math.round(r.distance);nl.duration=Math.round(r.duration);nl.fuelCost=Math.round(this.calcFuelCost(r.distance,nl.fuelPrice,nl.fuelPriceUnit));nl.routeGeometry=r.geometry?JSON.stringify(r.geometry):null;legs[legIndex+1]=nl;}}catch(e){}}}
    await Firebase.saveJourney({...j,legs});this.closeLocationDetail();setTimeout(()=>this.openJourneyDetail(journeyId),100);
  },

  // ─── Map operations ───────────────────────────────────────────────────────

  viewJourneyOnMap(journeyId,shouldSwitchView=true) {
    // If map isn't initialized yet, switch to trips view first
    if (!MapModule.map) { State.setView('trips'); return; }
    const j=State.getJourney(journeyId);if(!j?.legs?.length)return;
    this.activeJourneyId=journeyId;
    const m=MapModule.map;
    MapModule.markers.forEach(mk=>mk.remove());
    this.backupMarkers.forEach(mk=>m.removeLayer(mk));this.backupMarkers=[];this.showingBackups=false;
    this.journeyMarkers.forEach(mk=>m.removeLayer(mk));this.journeyMarkers=[];
    const legs=j.legs,uLat=State.userLat,uLng=State.userLng,PROX=2;
    let curIdx=-1,atStart=false;
    if(uLat){let cl=Infinity;if(legs.length>0&&legs[0].fromLat){const d=this.haversine(uLat,uLng,legs[0].fromLat,legs[0].fromLng);if(d<=PROX&&d<cl){cl=d;atStart=true;curIdx=-1;}}legs.forEach((l,i)=>{if(!l.destLat)return;const d=this.haversine(uLat,uLng,l.destLat,l.destLng);if(d<=PROX&&d<cl){cl=d;atStart=false;curIdx=i;}});}
    const allCoords=[],sLat=legs[0].fromLat||uLat,sLng=legs[0].fromLng||uLng,sName=legs[0].fromName||'Start';
    if(sLat){allCoords.push([sLat,sLng]);const si=L.divIcon({html:atStart?`<div style="width:26px;height:26px;background:#586F6B;border:2.5px solid white;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.3),0 0 0 6px rgba(88,111,107,.25);display:flex;align-items:center;justify-content:center"><svg width="13" height="13" viewBox="0 0 24 24" fill="white"><polygon points="12,2 15,9 22,9 16,14 18,22 12,17 6,22 8,14 2,9 9,9"/></svg></div>`:`<div style="width:20px;height:20px;background:#586F6B;border:2px solid white;border-radius:50%;box-shadow:0 2px 5px rgba(0,0,0,.2)"></div>`,className:'journey-marker',iconSize:atStart?[26,26]:[20,20],iconAnchor:atStart?[13,13]:[10,10]});const sm=L.marker([sLat,sLng],{icon:si,zIndexOffset:1000}).addTo(m);sm.bindPopup(`<b>${sName}</b><br>${atStart?'📍 Currently here':'Starting point'}`);this.journeyMarkers.push(sm);}
    legs.forEach((leg,i)=>{const e=State.getEntry(leg.destId),lat=e?.lat||leg.destLat,lng=e?.lng||leg.destLng;if(!lat||!lng)return;allCoords.push([lat,lng]);const ic=i===curIdx;const icon=L.divIcon({html:ic?`<div style="width:26px;height:26px;background:var(--color-primary,#2d5a47);border:2.5px solid white;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.3),0 0 0 5px rgba(45,90,71,.2);display:flex;align-items:center;justify-content:center;color:white;font-size:10px;font-weight:600">${i+1}</div>`:`<div style="width:20px;height:20px;background:var(--color-primary,#2d5a47);border:2px solid white;border-radius:50%;box-shadow:0 2px 5px rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center;color:white;font-size:9px;font-weight:600">${i+1}</div>`,className:'journey-marker',iconSize:[26,26],iconAnchor:[13,13]});const mk=L.marker([lat,lng],{icon,zIndexOffset:1000+i}).addTo(m);mk.bindPopup(`<b>${leg.destName}</b>${ic?'<br>📍 Currently here':''}`);this.journeyMarkers.push(mk);});
    if(allCoords.length>1){const pg=g=>{if(!g)return null;try{const p=typeof g==='string'?JSON.parse(g):g;return p.map(c=>[c[1],c[0]]);}catch(e){return null;}};const f0=pg(legs[0]?.routeGeometry);const l0=f0?L.polyline(f0,{color:'#2d5a47',weight:4,opacity:0.7}):L.polyline([allCoords[0],allCoords[1]],{color:'#2d5a47',weight:3,opacity:0.5,dashArray:'6 4'});l0.addTo(m);this.journeyMarkers.push(l0);for(let i=1;i<legs.length;i++){const g=pg(legs[i].routeGeometry),fr=allCoords[i],to=allCoords[i+1];if(!to)continue;const ln=g?L.polyline(g,{color:'#2d5a47',weight:4,opacity:0.7}):L.polyline([fr,to],{color:'#2d5a47',weight:3,opacity:0.5,dashArray:'6 4'});ln.addTo(m);this.journeyMarkers.push(ln);}
    m.fitBounds(L.latLngBounds(allCoords),{padding:[60,60],maxZoom:11});}
    else if(allCoords.length===1){m.setView(allCoords[0],12);}
    // Show the Backups toggle button now that a journey is active
    const bb = document.getElementById('map-backups-btn');
    if (bb) bb.style.display = '';
    if(shouldSwitchView && State.currentView !== 'trips') State.setView('trips');
  },

  showJourneyOnMap(journeyId){this.viewJourneyOnMap(journeyId,false);},

  clearJourneyFromMap(){
    const m=MapModule.map;if(m){this.journeyMarkers.forEach(mk=>m.removeLayer(mk));this.backupMarkers.forEach(mk=>m.removeLayer(mk));}
    this.journeyMarkers=[];this.backupMarkers=[];this.showingBackups=false;
    MapModule.renderMarkers();this.activeJourneyId=null;
    const bb = document.getElementById('map-backups-btn');
    if (bb) { bb.style.display = 'none'; bb.classList.remove('active'); }
  },

  toggleBackupMarkers(){
    const bb = document.getElementById('map-backups-btn');
    if(this.showingBackups){
      const m=MapModule.map;if(m)this.backupMarkers.forEach(mk=>m.removeLayer(mk));
      this.backupMarkers=[];this.showingBackups=false;
      if(bb)bb.classList.remove('active');
    }else{
      this.showBackupMarkersForJourney();this.showingBackups=true;
      if(bb)bb.classList.add('active');
    }
  },

  showBackupMarkersForJourney(){if(!this.activeJourneyId)return;const j=State.getJourney(this.activeJourneyId);if(!j?.legs)return;const m=MapModule.map;if(!m)return;const radius=State.fuelSettings.backupRadius||30,jids=new Set(j.legs.map(l=>l.destId)),seen=new Set();j.legs.forEach(leg=>{const de=State.getEntry(leg.destId);if(!de?.lat)return;State.entries.forEach(e=>{if(jids.has(e.id)||!e.lat||seen.has(e.id))return;if(this.haversine(de.lat,de.lng,e.lat,e.lng)<=radius){seen.add(e.id);const icon=L.divIcon({html:`<div style="width:20px;height:30px;position:relative"><div style="width:20px;height:20px;background:#f59e0b;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:2px solid white;position:absolute"></div></div>`,className:'backup-marker',iconSize:[20,30],iconAnchor:[10,30]});const mk=L.marker([e.lat,e.lng],{icon,zIndexOffset:500}).addTo(m);mk.bindPopup(`<div style="font-family:system-ui;padding:4px"><span style="background:#f59e0b;color:white;font-size:9px;font-weight:600;padding:2px 6px;border-radius:4px">BACKUP</span><div style="font-weight:500;font-size:14px;margin:4px 0">${this.esc(e.name)}</div><div style="font-size:12px;color:#4a6358">${e.type||''}</div></div>`);this.backupMarkers.push(mk);}});});},

  async refreshAllRoutes(journeyId){const j=State.getJourney(journeyId);if(!j?.legs?.length)return;const legs=[...j.legs];for(let i=0;i<legs.length;i++){const leg={...legs[i]};let fLat,fLng;if(i===0){fLat=leg.fromLat;fLng=leg.fromLng;if(!fLat&&State.userLat){fLat=State.userLat;fLng=State.userLng;leg.fromLat=fLat;leg.fromLng=fLng;leg.fromName='Current Location';}}else{fLat=legs[i-1].destLat;fLng=legs[i-1].destLng;}if(fLat&&leg.destLat){try{const r=await this.getRoute(fLat,fLng,leg.destLat,leg.destLng);if(r){leg.distance=Math.round(r.distance);leg.duration=Math.round(r.duration);leg.fuelCost=Math.round(this.calcFuelCost(r.distance));leg.routeGeometry=r.geometry?JSON.stringify(r.geometry):null;}}catch(e){}}legs[i]=leg;}await Firebase.saveJourney({...j,legs});this.openJourneyDetail(journeyId);},

  // ─── Send to Maps ─────────────────────────────────────────────────────────

  openSendToMapsModal(journeyId){const j=State.getJourney(journeyId);if(!j?.legs?.length){alert('No stops in this journey');return;}this.mapsModalJourneyId=journeyId;const legs=j.legs;let ni=0,nd=null;if(State.userLat){for(let i=0;i<legs.length;i++){const e=State.getEntry(legs[i].destId);if(e?.lat&&this.haversine(State.userLat,State.userLng,e.lat,e.lng)<10){ni=Math.min(i+1,legs.length-1);break;}}const ne=State.getEntry(legs[ni].destId);if(ne?.lat)nd=Math.round(this.haversine(State.userLat,State.userLng,ne.lat,ne.lng));}const ns=legs[ni];document.getElementById('maps-modal-content').innerHTML=`<div style="margin-bottom:14px"><div style="font-size:11px;font-weight:500;color:var(--color-text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">Navigate to</div><button onclick="Trips.selectMapsDestination('${ns.destId}')" style="width:100%;padding:11px;border-radius:var(--radius-md);border:1.5px solid var(--color-primary);background:white;text-align:left;cursor:pointer;margin-bottom:8px"><div style="font-size:13px;font-weight:500;color:var(--color-text)">Next stop: ${this.esc(ns.destName)}</div>${nd?`<div style="font-size:11px;color:var(--color-text-muted)">${nd} mi away</div>`:''}</button>${legs.length>1?`<button onclick="Trips.showStopPicker()" id="stop-picker-btn" style="width:100%;padding:11px;border-radius:var(--radius-md);border:0.5px solid var(--color-border);background:white;text-align:left;cursor:pointer"><div style="font-size:13px;color:var(--color-text-muted)">Choose a different stop…</div></button><div id="stop-picker-list" style="display:none;margin-top:6px;border:0.5px solid var(--color-border);border-radius:var(--radius-md);max-height:180px;overflow-y:auto">${legs.map(l=>`<div onclick="Trips.selectMapsDestination('${l.destId}')" style="padding:9px 12px;cursor:pointer;border-bottom:0.5px solid var(--color-border);font-size:13px;color:var(--color-text)" onmouseover="this.style.background='var(--color-surface-alt)'" onmouseout="this.style.background='white'">${this.esc(l.destName)}</div>`).join('')}</div>`:''}</div><div style="border-top:0.5px solid var(--color-border);padding-top:14px"><div style="font-size:11px;font-weight:500;color:var(--color-text-muted);margin-bottom:8px;text-transform:uppercase">Full route</div><button onclick="Trips.shareFullRoute()" style="width:100%;padding:11px;border-radius:var(--radius-md);border:0.5px solid var(--color-border);background:white;text-align:left;cursor:pointer"><div style="font-size:13px;color:var(--color-text)">Open full route</div><div style="font-size:11px;color:var(--color-text-muted)">Navigate all stops in order</div></button></div>`;UI.openModal('modal-maps');},

  closeMapsModal(){UI.closeModal('modal-maps');},
  showStopPicker(){const l=document.getElementById('stop-picker-list'),b=document.getElementById('stop-picker-btn'),op=l.style.display==='none';l.style.display=op?'block':'none';if(b)b.style.display=op?'none':'block';},
  selectMapsDestination(destId){this.pendingMapsAction={type:'navigate',destId};this.closeMapsModal();UI.openModal('modal-maps-picker');},
  shareFullRoute(){this.pendingMapsAction={type:'share'};this.closeMapsModal();UI.openModal('modal-maps-picker');},
  closeMapsPickerModal(){UI.closeModal('modal-maps-picker');this.pendingMapsAction=null;},
  openInAppleMaps(){if(!this.pendingMapsAction)return;if(this.pendingMapsAction.type==='navigate'){const e=State.getEntry(this.pendingMapsAction.destId);if(e?.lat)window.open(`https://maps.apple.com/?daddr=${e.lat},${e.lng}&dirflg=d`,'_blank');}else{const j=State.getJourney(this.mapsModalJourneyId);if(j?.legs){const c=j.legs.map(l=>{const e=State.getEntry(l.destId);return e?.lat?`${e.lat},${e.lng}`:null;}).filter(Boolean);if(c.length)window.open(`https://maps.apple.com/?daddr=${c.join('+to:')}`,`_blank`);}}this.closeMapsPickerModal();},
  openInGoogleMaps(){if(!this.pendingMapsAction)return;if(this.pendingMapsAction.type==='navigate'){const e=State.getEntry(this.pendingMapsAction.destId);if(e?.lat)window.open(`https://www.google.com/maps/dir/?api=1&destination=${e.lat},${e.lng}&travelmode=driving`,'_blank');}else{const j=State.getJourney(this.mapsModalJourneyId);if(j?.legs){const c=j.legs.map(l=>{const e=State.getEntry(l.destId);return e?.lat?`${e.lat},${e.lng}`:null;}).filter(Boolean);if(c.length){const dest=c[c.length-1],wp=c.slice(0,-1).join('|');window.open(c.length===1?`https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`:`https://www.google.com/maps/dir/?api=1&destination=${dest}&waypoints=${wp}&travelmode=driving`,'_blank');}}}this.closeMapsPickerModal();},

  // ─── Journey menu ─────────────────────────────────────────────────────────

  toggleJourneyMenu(journeyId){document.querySelectorAll('[id^="journey-menu-"]').forEach(m=>{if(m.id!=='journey-menu-'+journeyId)m.classList.remove('open');});const m=document.getElementById('journey-menu-'+journeyId);if(m)m.classList.toggle('open');},
  closeJourneyMenu(){document.querySelectorAll('[id^="journey-menu-"]').forEach(m=>m.classList.remove('open'));},

  async togglePinJourney(journeyId){this.closeJourneyMenu();const j=State.getJourney(journeyId);if(!j)return;if(j.pinned){await Firebase.saveJourney({...j,pinned:false});if(State.currentJourneyId===journeyId)State.setCurrentJourney(null);}else{await Firebase.pinJourney(journeyId);}},

  async confirmDeleteJourney(journeyId){const j=State.getJourney(journeyId);if(!confirm(`Delete journey "${j?.name}"? This cannot be undone.`))return;await Firebase.deleteJourney(journeyId);this.closeJourneyDetail();if(State.currentJourneyId===journeyId)State.setCurrentJourney(null);this.clearJourneyFromMap();},

  // ─── Modals (journey, fuel) ───────────────────────────────────────────────

  updateFuelSummary(){const el=document.getElementById('fuel-summary');if(!el)return;const{fuelType,mpg,pricePerGal,priceUnit}=State.fuelSettings;el.textContent=`${fuelType} · ${mpg} mpg · $${pricePerGal.toFixed(2)}/${priceUnit}`;},

  openNewJourneyModal(){this.editingJourneyId=null;const i=document.getElementById('journey-name');if(i)i.value='';UI.openModal('modal-new-journey');},
  closeNewJourneyModal(){UI.closeModal('modal-new-journey');},

  async saveNewJourney(){const inp=document.getElementById('journey-name'),name=inp?.value.trim();if(!name){alert('Please enter a journey name');return;}try{if(this.editingJourneyId){const j=State.getJourney(this.editingJourneyId);await Firebase.saveJourney({...j,name});this.closeNewJourneyModal();this.openJourneyDetail(this.editingJourneyId);this.editingJourneyId=null;}else{await Firebase.saveJourney({name,pinned:State.journeys.length===0});this.closeNewJourneyModal();UI.showToast('Journey created','success');}}catch(err){console.error(err);alert('Failed to save journey');}},

  openFuelSettingsModal(){const{fuelType,mpg,pricePerGal,priceUnit,backupRadius}=State.fuelSettings;document.getElementById('fuel-type').value=fuelType;document.getElementById('fuel-mpg').value=mpg;document.getElementById('fuel-price').value=pricePerGal;document.getElementById('fuel-price-unit').value=priceUnit;document.getElementById('backup-radius').value=backupRadius;UI.openModal('modal-fuel-settings');},
  closeFuelSettingsModal(){UI.closeModal('modal-fuel-settings');},
  saveFuelSettings(){State.setFuelSettings({fuelType:document.getElementById('fuel-type').value,mpg:parseFloat(document.getElementById('fuel-mpg').value)||18,pricePerGal:parseFloat(document.getElementById('fuel-price').value)||3.89,priceUnit:document.getElementById('fuel-price-unit').value,backupRadius:parseInt(document.getElementById('backup-radius').value)||30});this.closeFuelSettingsModal();UI.showToast('Settings saved','success');},

  // ─── Routing & calculations ───────────────────────────────────────────────

  async getRoute(fromLat,fromLng,toLat,toLng){const KEY=window.ORS_API_KEY||(window.CONFIG?.ORS_API_KEY)||'';if(!KEY){const m=this.haversine(fromLat,fromLng,toLat,toLng);return{distance:m*1.3,duration:m*1.3/45*60,geometry:null};}try{const r=await fetch(`https://api.openrouteservice.org/v2/directions/driving-car?api_key=${KEY}&start=${fromLng},${fromLat}&end=${toLng},${toLat}`);const d=await r.json();if(d.features?.[0]){const f=d.features[0],p=f.properties.summary;return{distance:p.distance*0.000621371,duration:p.duration/60,geometry:f.geometry?.coordinates||null};}}catch(e){console.error('[Route]',e);}const m=this.haversine(fromLat,fromLng,toLat,toLng);return{distance:m*1.3,duration:m*1.3/45*60,geometry:null};},

  haversine(lat1,lon1,lat2,lon2){const R=3959,dl=(lat2-lat1)*Math.PI/180,dn=(lon2-lon1)*Math.PI/180,a=Math.sin(dl/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dn/2)**2;return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));},
  isInSeason(d){if(!d)return true;const m=new Date(d+'T12:00').getMonth();return m>=4&&m<=8;},

  calculateJourneyStats(journey){const legs=journey.legs||[],{mpg,pricePerGal}=State.fuelSettings;let tm=0,tf=0,tl=0;legs.forEach(l=>{if(l.distance){tm+=l.distance;tf+=(l.distance/mpg)*(l.fuelPrice||pricePerGal);}if(l.destId){const e=State.getEntry(l.destId);if(e?.cost){const n=this.calcNights(l.arriveDate,l.departDate)||1;tl+=e.cost*n;}}});return{totalMiles:tm,totalFuel:tf,totalLodging:tl};},
  calcNights(a,d){if(!a||!d)return 1;return Math.max(1,Math.ceil((new Date(d)-new Date(a))/86400000));},
  findNextLeg(journey){if(!journey?.legs?.length)return null;if(!State.userLat)return journey.legs[0];let best=null,bs=Infinity;journey.legs.forEach(l=>{if(!l.destLat)return;const d=this.haversine(State.userLat,State.userLng,l.destLat,l.destLng);if(d<bs){bs=d;best=l;}});return best||journey.legs[0];},
  shareNextDestination(){const j=State.getCurrentJourney();if(!j)return;const l=this.findNextLeg(j);if(!l)return;const e=State.getEntry(l.destId);if(e?.lat){const c=`${e.lat},${e.lng}`;if(/iPad|iPhone|iPod/.test(navigator.userAgent))window.location.href=`maps://maps.apple.com/?daddr=${c}`;else window.open(`https://www.google.com/maps/dir/?api=1&destination=${c}`,'_blank');}},
  fmtDuration(m){if(!m)return'';const h=Math.floor(m/60),mn=Math.round(m%60);return h>0?`${h}h ${mn}m`:`${mn}m`;},
  esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
};

window.Trips = Trips;
window.openAddLegModal=(id,pre)=>Trips.openAddLegModal(id,pre);
window.closeLegModal=()=>Trips.closeLegModal();
window.saveLeg=()=>Trips.saveLeg();
window.openNewJourneyModal=()=>Trips.openNewJourneyModal();
window.closeJourneyModal=()=>Trips.closeNewJourneyModal();
window.saveNewJourney=()=>Trips.saveNewJourney();
window.openFuelSettingsModal=()=>Trips.openFuelSettingsModal();
window.closeFuelModal=()=>Trips.closeFuelSettingsModal();
window.saveFuelSettings=()=>Trips.saveFuelSettings();
window.closeMapsModal=()=>Trips.closeMapsModal();
window.closeMapsPickerModal=()=>Trips.closeMapsPickerModal();
window.openInAppleMaps=()=>Trips.openInAppleMaps();
window.openInGoogleMaps=()=>Trips.openInGoogleMaps();
window.toggleBackupMarkers=()=>Trips.toggleBackupMarkers();
window.openLocationDetail=(id,ctx)=>Trips.openLocationDetail(id,ctx);
window.closeLocationDetail=()=>Trips.closeLocationDetail();
window.viewJourneyOnMap=(id)=>Trips.viewJourneyOnMap(id);
window.closeNewJourneyModal=()=>Trips.closeNewJourneyModal();
