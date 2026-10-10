import { Injectable, signal } from '@angular/core';
import {
  confirmPasswordReset,
  getIdToken,
  getIdTokenResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  linkWithPopup,
  signInWithCustomToken,
  signInWithPopup,
  signOut,
  updatePassword,
  type User,
} from 'firebase/auth';
import { firebaseAuth, API_URL } from './firebase';

export interface AuthUser {
  id: string;
  schoolId: string;
  schoolName: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'TEACHER' | 'PARENT' | 'STUDENT';
}

export type AuthStatus =
  | 'loading'
  | 'unauthenticated'
  | 'authenticated'
  | 'unavailable'
  | 'otp-pending';

async function apiPost<T>(path: string, body: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data['error'] ?? 'Error desconocido.');
  return data as T;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly user = signal<AuthUser | null>(null);
  readonly googleLinked = signal(false);
  readonly status = signal<AuthStatus>('loading');

  async initialize(): Promise<void> {
    this.status.set('loading');
    await new Promise<void>((resolve) => {
      const unsubscribe = onAuthStateChanged(
        firebaseAuth,
        async (firebaseUser) => {
          unsubscribe();
          try {
            await this.setAuthenticatedUser(firebaseUser);
          } catch {
            this.user.set(null);
            this.status.set('unavailable');
          } finally {
            resolve();
          }
        },
        () => {
          unsubscribe();
          this.user.set(null);
          this.status.set('unavailable');
          resolve();
        },
      );
    });
  }

  async login(email: string, password: string): Promise<{ otpSent: boolean; userId: string; email: string } | null> {
    const result = await apiPost<{ otpSent: true; userId: string; email: string }>('/auth/login', { email, password });
    this.status.set('otp-pending');
    return result;
  }

  async loginWithGoogle(): Promise<{ otpSent: true; userId: string; email: string }> {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      const credential = await signInWithPopup(firebaseAuth, provider);
      const idToken = await getIdToken(credential.user);
      const result = await apiPost<{ otpSent: true; userId: string; email: string }>('/auth/google-login', { idToken });
      await signOut(firebaseAuth);
      this.status.set('otp-pending');
      return result;
    } catch (error) {
      if (firebaseAuth.currentUser) await signOut(firebaseAuth);
      throw error;
    }
  }

  async linkGoogleAccount(): Promise<void> {
    const currentUser = firebaseAuth.currentUser;
    if (!currentUser) throw new Error('Inicia sesión para vincular tu cuenta de Google.');
    await linkWithPopup(currentUser, new GoogleAuthProvider());
    this.googleLinked.set(true);
  }

  async verifyOtp(userId: string, code: string): Promise<void> {
    const result = await apiPost<{ customToken: string }>('/auth/verify-otp', { userId, code });
    await signInWithCustomToken(firebaseAuth, result.customToken);
    await this.setAuthenticatedUser(firebaseAuth.currentUser);
  }

  async logout(): Promise<void> {
    await signOut(firebaseAuth);
    this.user.set(null);
    this.status.set('unauthenticated');
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const currentUser = firebaseAuth.currentUser;
    if (!currentUser?.email) throw new Error('Inicia sesión de nuevo para cambiar la contraseña.');
    const { EmailAuthProvider, reauthenticateWithCredential } = await import('firebase/auth');
    const credential = EmailAuthProvider.credential(currentUser.email, currentPassword);
    await reauthenticateWithCredential(currentUser, credential);
    await updatePassword(currentUser, newPassword);
    await this.logout();
  }

  async forgotPassword(email: string): Promise<string> {
    const result = await apiPost<{ message: string }>('/auth/request-reset', { email });
    return result.message;
  }

  async resetPassword(actionCode: string, newPassword: string): Promise<void> {
    await confirmPasswordReset(firebaseAuth, actionCode, newPassword);
  }

  async getToken(): Promise<string | null> {
    return firebaseAuth.currentUser ? getIdToken(firebaseAuth.currentUser) : null;
  }

  private async setAuthenticatedUser(firebaseUser: User | null): Promise<void> {
    if (!firebaseUser) {
      this.user.set(null);
      this.googleLinked.set(false);
      this.status.set('unauthenticated');
      return;
    }
    const token = await getIdTokenResult(firebaseUser, true);
    const claims = token.claims;
    const role = claims['role'];
    if (
      claims['otpVerified'] !== true ||
      typeof claims['schoolId'] !== 'string' ||
      !['ADMIN', 'TEACHER', 'PARENT', 'STUDENT'].includes(String(role))
    ) {
      await signOut(firebaseAuth);
      this.user.set(null);
      this.status.set('unauthenticated');
      return;
    }
    this.user.set({
      id: firebaseUser.uid,
      schoolId: String(claims['schoolId']),
      schoolName: String(claims['schoolName'] ?? 'Colegio'),
      name: String(claims['name'] ?? firebaseUser.displayName ?? ''),
      email: firebaseUser.email ?? '',
      role: role as AuthUser['role'],
    });
    this.googleLinked.set(
      firebaseUser.providerData.some((p) => p.providerId === 'google.com'),
    );
    this.status.set('authenticated');
  }
}
