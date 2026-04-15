/**
 * The Fallback v2 - Firebase Module
 * Authentication and Firestore database operations
 */

const Firebase = {
  // References
  auth: null,
  db: null,
  user: null,
  
  // Subscription cleanup
  entriesUnsub: null,
  journeysUnsub: null,
  
  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  init() {
    // Firebase config
    const firebaseConfig = {
      apiKey: "AIzaSyDUXDB9p9XfGnQ6n1hS4BfoFdVKoLB_5pE",
      authDomain: "road-tripping-app.firebaseapp.com",
      projectId: "road-tripping-app",
      storageBucket: "road-tripping-app.firebasestorage.app",
      messagingSenderId: "155aborede557992851",
      appId: "1:155557992851:web:9abd2b6bf87db5cd9bb9dc"
    };
    
    // Initialize Firebase
    firebase.initializeApp(firebaseConfig);
    this.auth = firebase.auth();
    this.db = firebase.firestore();
    
    // Enable offline persistence
    this.db.enablePersistence({ synchronizeTabs: true }).catch(err => {
      if (err.code === 'failed-precondition') {
        console.warn('Firestore persistence unavailable: multiple tabs open');
      } else if (err.code === 'unimplemented') {
        console.warn('Firestore persistence unavailable: browser not supported');
      }
    });
    
    // Listen for auth state changes
    this.auth.onAuthStateChanged(user => this.handleAuthChange(user));
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // AUTHENTICATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  handleAuthChange(user) {
    if (user) {
      this.user = user;
      this.subscribeToData();
      State.emit('auth:signed-in', user);
    } else {
      this.user = null;
      this.unsubscribeFromData();
      State.setEntries([]);
      State.setJourneys([]);
      State.emit('auth:signed-out');
    }
  },
  
  async signInWithGoogle() {
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await this.auth.signInWithPopup(provider);
    } catch (err) {
      console.error('Sign in error:', err);
      State.emit('auth:error', err.message);
    }
  },
  
  async signOut() {
    try {
      await this.auth.signOut();
    } catch (err) {
      console.error('Sign out error:', err);
    }
  },
  
  getUser() {
    return this.user;
  },
  
  getUserId() {
    return this.user?.uid;
  },
  
  getUserName() {
    return this.user?.displayName || 'User';
  },
  
  getUserEmail() {
    return this.user?.email || '';
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // DATA SUBSCRIPTIONS
  // ═══════════════════════════════════════════════════════════════════════════
  
  subscribeToData() {
    const uid = this.getUserId();
    if (!uid) return;
    
    // Subscribe to entries
    this.entriesUnsub = this.db
      .collection('entries')
      .where('uid', '==', uid)
      .onSnapshot(snapshot => {
        const entries = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));
        State.setEntries(entries);
      }, err => {
        console.error('Entries subscription error:', err);
      });
    
    // Subscribe to journeys
    this.journeysUnsub = this.db
      .collection('journeys')
      .where('uid', '==', uid)
      .onSnapshot(snapshot => {
        const journeys = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));
        
        // Sort: pinned first, then by creation date
        journeys.sort((a, b) => {
          if (a.pinned && !b.pinned) return -1;
          if (!a.pinned && b.pinned) return 1;
          return (b.createdAt || 0) - (a.createdAt || 0);
        });
        
        State.setJourneys(journeys);
        
        // Set current journey if we have a pinned one
        const pinned = journeys.find(j => j.pinned);
        if (pinned && !State.currentJourneyId) {
          State.setCurrentJourney(pinned.id);
        }
      }, err => {
        console.error('Journeys subscription error:', err);
      });
  },
  
  unsubscribeFromData() {
    if (this.entriesUnsub) {
      this.entriesUnsub();
      this.entriesUnsub = null;
    }
    if (this.journeysUnsub) {
      this.journeysUnsub();
      this.journeysUnsub = null;
    }
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // ENTRIES CRUD
  // ═══════════════════════════════════════════════════════════════════════════
  
  async saveEntry(entry) {
    const uid = this.getUserId();
    if (!uid) throw new Error('Not authenticated');
    
    const data = {
      ...entry,
      uid,
      updatedAt: Date.now()
    };
    
    if (entry.id) {
      // Update existing
      await this.db.collection('entries').doc(entry.id).update(data);
      return entry.id;
    } else {
      // Create new
      data.createdAt = Date.now();
      const docRef = await this.db.collection('entries').add(data);
      return docRef.id;
    }
  },
  
  async deleteEntry(id) {
    await this.db.collection('entries').doc(id).delete();
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // JOURNEYS CRUD
  // ═══════════════════════════════════════════════════════════════════════════
  
  async saveJourney(journey) {
    const uid = this.getUserId();
    if (!uid) throw new Error('Not authenticated');
    
    const data = {
      ...journey,
      uid,
      updatedAt: Date.now()
    };
    
    if (journey.id) {
      await this.db.collection('journeys').doc(journey.id).update(data);
      return journey.id;
    } else {
      data.createdAt = Date.now();
      data.legs = data.legs || [];
      const docRef = await this.db.collection('journeys').add(data);
      return docRef.id;
    }
  },
  
  async deleteJourney(id) {
    await this.db.collection('journeys').doc(id).delete();
  },
  
  async pinJourney(id) {
    const uid = this.getUserId();
    if (!uid) return;
    
    // Unpin all other journeys for this user
    const batch = this.db.batch();
    const journeysSnapshot = await this.db
      .collection('journeys')
      .where('uid', '==', uid)
      .where('pinned', '==', true)
      .get();
    
    journeysSnapshot.docs.forEach(doc => {
      batch.update(doc.ref, { pinned: false });
    });
    
    // Pin the selected journey
    batch.update(this.db.collection('journeys').doc(id), { pinned: true });
    
    await batch.commit();
    State.setCurrentJourney(id);
  },
  
  async addLeg(journeyId, leg) {
    const journey = State.getJourney(journeyId);
    if (!journey) throw new Error('Journey not found');
    
    const legs = [...(journey.legs || []), leg];
    await this.db.collection('journeys').doc(journeyId).update({ legs });
  },
  
  async updateLeg(journeyId, legIndex, legData) {
    const journey = State.getJourney(journeyId);
    if (!journey) throw new Error('Journey not found');
    
    const legs = [...(journey.legs || [])];
    legs[legIndex] = { ...legs[legIndex], ...legData };
    await this.db.collection('journeys').doc(journeyId).update({ legs });
  },
  
  async deleteLeg(journeyId, legIndex) {
    const journey = State.getJourney(journeyId);
    if (!journey) throw new Error('Journey not found');
    
    const legs = [...(journey.legs || [])];
    legs.splice(legIndex, 1);
    await this.db.collection('journeys').doc(journeyId).update({ legs });
  }
};

// Export
window.Firebase = Firebase;
