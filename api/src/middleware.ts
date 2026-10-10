import type { Request, Response, NextFunction } from 'express';
import { auth } from './firebase.js';
import { ApiError, record, storeRef, type Role } from './utils.js';

export interface UserContext {
  uid: string; schoolId: string; role: Role; name: string; email: string;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new ApiError(401, 'Inicia sesión para continuar.');
    const decoded = await auth.verifyIdToken(token);
    if (decoded['otpVerified'] !== true) throw new ApiError(403, 'Completa la verificación por correo.');
    const schoolId = String(decoded['schoolId'] ?? '');
    if (!schoolId) throw new ApiError(403, 'La cuenta no está vinculada a un colegio.');
    const profileSnap = await storeRef(`schools/${schoolId}/users/${decoded.uid}`).get();
    const profile = record(profileSnap.val());
    if (profile['active'] !== true || (await auth.getUser(decoded.uid)).disabled)
      throw new ApiError(403, 'La cuenta está desactivada.');
    const role = String(profile['role']);
    if (!['ADMIN', 'TEACHER', 'PARENT', 'STUDENT'].includes(role))
      throw new ApiError(403, 'Rol no válido.');
    (req as Request & { user: UserContext }).user = {
      uid: decoded.uid, schoolId, role: role as Role,
      name: String(profile['name'] ?? ''), email: String(profile['email'] ?? ''),
    };
    next();
  } catch (err) {
    if (err instanceof ApiError) { res.status(err.status).json({ error: err.message }); return; }
    res.status(401).json({ error: 'Token inválido.' });
  }
}

export function getUser(req: Request): UserContext {
  return (req as Request & { user: UserContext }).user;
}

export function requireRole(user: UserContext, ...roles: Role[]): void {
  if (!roles.includes(user.role)) throw new ApiError(403, 'No tienes permiso para realizar esta acción.');
}
