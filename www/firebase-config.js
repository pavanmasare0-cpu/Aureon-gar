// ===== Firebase configuration =====
// Get these values from: Firebase Console → Project Settings → General
// → "Your apps" → Web app (</>) → SDK setup and configuration → Config
//
// Replace every "REPLACE_ME" below with your actual project values.

const firebaseConfig = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
