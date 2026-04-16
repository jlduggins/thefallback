/**
 * The Fallback v2 - Firebase Module
 * Authentication and Firestore database operations
 * Uses modular SDK to support named database
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut, browserLocalPersistence, setPersistence } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, collection, doc, setDoc, getDoc, deleteDoc, updateDoc, onSnapshot, query, where, getDocs, writeBatch, enableIndexedDbPersistence } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyAXrhjv1t3520X7QKiVI0qqeMAvpWS5Rdw",
  authDomain: "gen-lang-client-0165143367.firebaseapp.com",
  projectId: "gen-lang-client-0165143367",
  storageBucket: "gen-lang-client-0165143367.firebasestorage.app",
  messagingSenderId: "659366672596",
  appId: "1:659366672596:web:9a8fe8502a0769fdafe341"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app, 'ai-studio-c0969653-1687-41bd-9dbc-30380f72c788');
const googleProvider = new GoogleAuthProvider();

// Set persistence
setPersistence(auth, browserLocalPersistence).catch(err => console.warn('Auth persistence error:', err));

// Enable offline persistence
enableIndexedDbPersistence(db).catch(err => {
  if (err.code === 'failed-precondition') {
    console.warn('Firestore persistence unavailable: multiple tabs open');
  } else if (err.code === 'unimplemented') {
    console.warn('Firestore persistence unavailable: browser not supported');
  }
});

const Firebase = {
  // State
  user: null,
  entriesUnsub: null,
  journeysUnsub: null,
  
  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  init() {
    // Handle redirect result
    getRedirectResult(auth).then(result => {
      if (result && result.user) {
        console.log('Redirect sign-in successful');
      }
    }).catch(err => {
      if (err.code && err.code !== 'auth/no-current-user') {
        console.error('Redirect error:', err);
        State.emit('auth:error', err.message);
      }
    });
    
    // Listen for auth state changes
    onAuthStateChanged(auth, user => this.handleAuthChange(user));
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
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      if (err.code === 'auth/popup-blocked' || err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
        signInWithRedirect(auth, googleProvider);
      } else {
        console.error('Sign in error:', err);
        State.emit('auth:error', err.message);
      }
    }
  },
  
  async signOut() {
    try {
      await signOut(auth);
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
    
    // Subscribe to entries (stored as /users/{uid}/logs/)
    const entriesRef = collection(db, 'users', uid, 'logs');
    let firstSnapshot = true;
    this.entriesUnsub = onSnapshot(entriesRef, snapshot => {
      const entries = snapshot.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));
      State.setEntries(entries);
      // Add a sample entry for brand-new users
      if (firstSnapshot) {
        firstSnapshot = false;
        if (entries.length === 0) {
          this.addSampleEntry(uid);
        }
      }
    }, err => {
      console.error('Entries subscription error:', err);
    });
    
    // Subscribe to journeys (stored as /users/{uid}/journeys/)
    const journeysRef = collection(db, 'users', uid, 'journeys');
    this.journeysUnsub = onSnapshot(journeysRef, snapshot => {
      const journeys = snapshot.docs.map(d => ({
        id: d.id,
        ...d.data()
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
    
    // Remove id from data (it's the doc id, not a field)
    const docId = entry.id;
    delete data.id;
    
    if (docId) {
      // Update existing
      await setDoc(doc(db, 'users', uid, 'logs', docId), data, { merge: true });
      return docId;
    } else {
      // Create new
      data.createdAt = Date.now();
      const newId = State.genId();
      await setDoc(doc(db, 'users', uid, 'logs', newId), data);
      return newId;
    }
  },
  
  async deleteEntry(id) {
    const uid = this.getUserId();
    if (!uid) throw new Error('Not authenticated');
    await deleteDoc(doc(db, 'users', uid, 'logs', id));
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
    
    const docId = journey.id;
    delete data.id;
    
    if (docId) {
      await setDoc(doc(db, 'users', uid, 'journeys', docId), data, { merge: true });
      return docId;
    } else {
      data.createdAt = Date.now();
      data.legs = data.legs || [];
      const newId = State.genId();
      await setDoc(doc(db, 'users', uid, 'journeys', newId), data);
      return newId;
    }
  },
  
  async deleteJourney(id) {
    const uid = this.getUserId();
    if (!uid) throw new Error('Not authenticated');
    await deleteDoc(doc(db, 'users', uid, 'journeys', id));
  },
  
  async pinJourney(id) {
    const uid = this.getUserId();
    if (!uid) return;
    
    // Get all pinned journeys and unpin them
    const journeysRef = collection(db, 'users', uid, 'journeys');
    const pinnedQuery = query(journeysRef, where('pinned', '==', true));
    const pinnedSnapshot = await getDocs(pinnedQuery);
    
    const batch = writeBatch(db);
    pinnedSnapshot.docs.forEach(d => {
      batch.update(d.ref, { pinned: false });
    });
    
    // Pin the selected journey
    batch.update(doc(db, 'users', uid, 'journeys', id), { pinned: true });
    
    await batch.commit();
    State.setCurrentJourney(id);
  },
  
  async addLeg(journeyId, leg) {
    const uid = this.getUserId();
    if (!uid) throw new Error('Not authenticated');
    const journey = State.getJourney(journeyId);
    if (!journey) throw new Error('Journey not found');
    
    const legs = [...(journey.legs || []), leg];
    await updateDoc(doc(db, 'users', uid, 'journeys', journeyId), { legs });
  },
  
  async updateLeg(journeyId, legIndex, legData) {
    const uid = this.getUserId();
    if (!uid) throw new Error('Not authenticated');
    const journey = State.getJourney(journeyId);
    if (!journey) throw new Error('Journey not found');
    
    const legs = [...(journey.legs || [])];
    legs[legIndex] = { ...legs[legIndex], ...legData };
    await updateDoc(doc(db, 'users', uid, 'journeys', journeyId), { legs });
  },
  
  async addSampleEntry(uid) {
    try {
      const id = State.genId();
      const sample = {
        name: 'Grizzly Creek Redwoods — Welcome to The Fallback!',
        address: 'Grizzly Creek Redwoods State Park, Carlotta, CA 95528',
        lat: 40.5485,
        lng: -123.9578,
        type: 'State Park',
        status: 'planned',
        cost: 35,
        rating: 5,
        hasPotableWater: true,
        hasTrash: true,
        hasPets: true,
        notes: 'This is a sample location — feel free to edit or delete it. Log your own camping spots using the + button, and plan routes in the Trips tab.',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        uid
      };
      await setDoc(doc(db, 'users', uid, 'logs', id), sample);
      console.log('[Firebase] Sample entry created for new user');
    } catch (err) {
      console.warn('[Firebase] Could not create sample entry:', err);
    }
  },
  
  async deleteLeg(journeyId, legIndex) {
    const uid = this.getUserId();
    if (!uid) throw new Error('Not authenticated');
    const journey = State.getJourney(journeyId);
    if (!journey) throw new Error('Journey not found');
    
    const legs = [...(journey.legs || [])];
    legs.splice(legIndex, 1);
    await updateDoc(doc(db, 'users', uid, 'journeys', journeyId), { legs });
  }
};

// Export to window for other modules
window.Firebase = Firebase;
