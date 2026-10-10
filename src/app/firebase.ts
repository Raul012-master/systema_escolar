import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

export const firebaseApp = initializeApp({
  apiKey: 'AIzaSyCAePcY78xQgxp5G4_Xk1naPg4beT7BbI0',
  authDomain: 'sistema-escolar-fec8f.firebaseapp.com',
  projectId: 'sistema-escolar-fec8f',
  storageBucket: 'sistema-escolar-fec8f.firebasestorage.app',
  messagingSenderId: '938443820702',
  appId: '1:938443820702:web:e171bc8f66f49b58b0b58f',
});

export const firebaseAuth = getAuth(firebaseApp);

// URL base de la API — en producción apunta a Render
export const API_URL = (window as Window & { __API_URL__?: string }).__API_URL__
  ?? (location.hostname === 'localhost' ? 'http://localhost:3000' : 'https://sistema-escolar-api.onrender.com');
