// ===== Firebase configuration =====
const firebaseConfig = {
  apiKey: "AIzaSyDgdikKYrHhRwj9TsMR8nfwTsbFYkV0-eQ",
  authDomain: "aureon-fc92c.firebaseapp.com",
  projectId: "aureon-fc92c",
  storageBucket: "aureon-fc92c.firebasestorage.app",
  messagingSenderId: "240783796334",
  appId: "1:240783796334:web:f20665bac17b7bf1865e7f"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
