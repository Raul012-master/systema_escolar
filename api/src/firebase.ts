import { cert, initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
  const credJson = process.env['GOOGLE_APPLICATION_CREDENTIALS_JSON'];
  if (credJson) {
    initializeApp({ credential: cert(JSON.parse(credJson)) });
  } else {
    // local: usa GOOGLE_APPLICATION_CREDENTIALS apuntando al archivo
    initializeApp({ projectId: process.env['FIREBASE_PROJECT_ID'] });
  }
}

export const auth = getAuth();
export const db = getFirestore();
