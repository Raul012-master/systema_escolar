import { createHash, randomInt, randomUUID } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import {
  FieldValue,
  getFirestore,
  type DocumentData,
} from 'firebase-admin/firestore';
import { defineSecret, defineString } from 'firebase-functions/params';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import nodemailer from 'nodemailer';

initializeApp();

const db = getFirestore();
const auth = getAuth();
const smtpHost = defineString('SMTP_HOST');
const smtpPort = defineString('SMTP_PORT');
const smtpUser = defineString('SMTP_USER');
const smtpFrom = defineString('SMTP_FROM');
const smtpPassword = defineSecret('SMTP_PASSWORD');
const firebaseWebApiKey = defineString('FIREBASE_WEB_API_KEY');
const schoolName = defineString('SCHOOL_NAME', { default: 'Colegio del Valle' });
const OTP_LIFETIME_MS = 10 * 60 * 1000;
const COLLECTIONS = [
  'users',
  'students',
  'groups',
  'subjects',
  'grades',
  'reports',
  'cycles',
  'attendance',
  'config',
] as const;

type Role = 'ADMIN' | 'TEACHER' | 'PARENT' | 'STUDENT';
type UserContext = { uid: string; schoolId: string; role: Role; name: string; email: string };
type Values = Record<string, unknown>;

function record(value: unknown): Values {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Values)
    : {};
}

function text(value: unknown, label: string, max = 300): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new HttpsError('invalid-argument', `${label} no es válido.`);
  }
  return value.trim();
}

function optionalText(value: unknown, max = 300): string | null {
  if (value === undefined || value === null || value === '') return null;
  return text(value, 'El texto', max);
}

interface StoreSnapshot {
  val(): unknown;
  exists(): boolean;
}

function snapshot(value: unknown, exists = value !== null && value !== undefined): StoreSnapshot {
  return { val: () => value, exists: () => exists };
}

function documentPath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 3 && segments[0] === 'schools' && segments[2] === 'config') {
    return `${segments[0]}/${segments[1]}/config/settings`;
  }
  if (
    segments.length === 2 ||
    segments.length === 4 && segments[0] === 'schools'
  ) {
    return segments.join('/');
  }
  throw new Error(`Invalid Firestore document path: ${path}`);
}

function storeRef(path = '') {
  const normalizedPath = path.replace(/^\/+|\/+$/g, '');
  return {
    child(segment: string) {
      return storeRef([normalizedPath, segment].filter(Boolean).join('/'));
    },
    async get(): Promise<StoreSnapshot> {
      const segments = normalizedPath.split('/').filter(Boolean);
      if (segments.length === 0) return snapshot(null, false);
      if (segments.length === 3 && segments[0] === 'schools' && segments[2] === 'name') {
        const school = await db.doc(`schools/${segments[1]}`).get();
        return snapshot(school.get('name'), school.exists && school.get('name') !== undefined);
      }
      if (segments.length === 0 || segments.length === 1 ||
          segments.length === 3 && segments[0] === 'schools' && segments[2] !== 'config') {
        const collectionPath = normalizedPath || segments[0];
        const result = await db.collection(collectionPath).get();
        const value = Object.fromEntries(result.docs.map((doc) => [doc.id, doc.data()]));
        return snapshot(value, !result.empty);
      }
      const result = await db.doc(documentPath(normalizedPath)).get();
      return snapshot(result.exists ? result.data() : null, result.exists);
    },
    async set(value: DocumentData): Promise<void> {
      await db.doc(documentPath(normalizedPath)).set(value);
    },
    async update(updates: Record<string, unknown>): Promise<void> {
      const entries = Object.entries(updates);
      for (let offset = 0; offset < entries.length; offset += 450) {
        const batch = db.batch();
        for (const [relativePath, value] of entries.slice(offset, offset + 450)) {
          const fullPath = [normalizedPath, relativePath].filter(Boolean).join('/');
          const segments = fullPath.split('/').filter(Boolean);
          if (segments.length === 5 && segments[0] === 'schools') {
            const ref = db.doc(segments.slice(0, 4).join('/'));
            if (value === null) batch.update(ref, { [segments[4]]: FieldValue.delete() });
            else batch.update(ref, { [segments[4]]: value });
          } else {
            const ref = db.doc(documentPath(fullPath));
            if (value === null) batch.delete(ref);
            else batch.set(ref, value as DocumentData);
          }
        }
        await batch.commit();
      }
    },
    async remove(): Promise<void> {
      await db.doc(documentPath(normalizedPath)).delete();
    },
    async transaction(
      update: (current: unknown) => unknown,
    ): Promise<{ committed: boolean; snapshot: StoreSnapshot }> {
      return db.runTransaction(async (transaction) => {
        const ref = db.doc(documentPath(normalizedPath));
        const current = await transaction.get(ref);
        const next = update(current.exists ? current.data() : null);
        if (next === undefined) {
          return { committed: false, snapshot: snapshot(current.exists ? current.data() : null, current.exists) };
        }
        if (next === null) transaction.delete(ref);
        else transaction.set(ref, next as DocumentData);
        return { committed: true, snapshot: snapshot(next, next !== null) };
      });
    },
  };
  }

function list(snapshotValue: StoreSnapshot): Values[] {
  const value = snapshotValue.val();
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).map(([id, item]) => ({ id, ...record(item) }));
}

function byId(values: Values[]): Map<string, Values> {
  return new Map(values.map((item) => [String(item.id), item]));
}

function sortBy(values: Values[], key: string): Values[] {
  return values.sort((a, b) =>
    String(a[key] ?? '').localeCompare(String(b[key] ?? ''), 'es-MX'),
  );
}

function schoolRef(schoolId: string) {
  return storeRef(`schools/${schoolId}`);
}

async function currentUser(request: { auth?: { uid: string; token: Values } }): Promise<UserContext> {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Inicia sesión para continuar.');
  const token = request.auth.token;
  if (token['otpVerified'] !== true) {
    throw new HttpsError('permission-denied', 'Completa la verificación por correo.');
  }
  const schoolId = String(token['schoolId'] ?? '');
  if (!schoolId) throw new HttpsError('permission-denied', 'La cuenta no está vinculada a un colegio.');
  const profileSnapshot = await storeRef(`schools/${schoolId}/users/${request.auth.uid}`).get();
  const profile = record(profileSnapshot.val());
  if (profile['active'] !== true || (await auth.getUser(request.auth.uid)).disabled) {
    throw new HttpsError('permission-denied', 'La cuenta está desactivada o no está configurada.');
  }
  const role = profile['role'];
  if (!['ADMIN', 'TEACHER', 'PARENT', 'STUDENT'].includes(String(role))) {
    throw new HttpsError('permission-denied', 'El perfil de la cuenta no tiene un rol válido.');
  }
  return {
    uid: request.auth.uid,
    schoolId,
    role: role as Role,
    name: String(profile['name'] ?? ''),
    email: String(profile['email'] ?? ''),
  };
}

function requireRole(user: UserContext, ...roles: Role[]): void {
  if (!roles.includes(user.role)) {
    throw new HttpsError('permission-denied', 'No tienes permiso para realizar esta acción.');
  }
}

async function values(user: UserContext, collection: (typeof COLLECTIONS)[number]): Promise<Values[]> {
  const snapshot = await schoolRef(user.schoolId).child(collection).get();
  return list(snapshot);
}

async function mailTransport() {
  const host = smtpHost.value();
  const port = Number(smtpPort.value());
  const username = smtpUser.value();
  const password = smtpPassword.value();
  const from = smtpFrom.value() || username;
  if (!host || !Number.isInteger(port) || !username || !password || !from) {
    throw new HttpsError('failed-precondition', 'El servicio de correo no está configurado.');
  }
  return {
    from,
    transport: nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user: username, pass: password },
    }),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character]!;
  });
}

function emailHtml(title: string, content: string): string {
  const safeTitle = escapeHtml(title);
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#f6f7fb;font-family:Arial,sans-serif"><div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden"><h1 style="margin:0;padding:28px;background:#2A7BE4;text-align:center;color:#fff;font-size:22px">${safeTitle}</h1><div style="padding:32px;line-height:1.6">${content}</div><p style="padding:16px;text-align:center;background:#f6f7fb;color:#8a93a6;font-size:12px">Sistema Escolar Aula</p></div></body></html>`;
}

async function sendEmail(
  to: string,
  subject: string,
  html: string,
  textBody: string,
): Promise<void> {
  const { transport, from } = await mailTransport();
  try {
    await transport.sendMail({ from, to, subject, html, text: textBody });
  } finally {
    transport.close();
  }
}

async function sendLoginOtp(uid: string, email: string, profile: Values): Promise<void> {
  const now = Date.now();
  let throttled = false;
  await storeRef(`loginLimits/${uid}`).transaction((current: unknown) => {
    const previous = record(current);
    if (
      Number(previous['windowStart'] ?? 0) + 60_000 > now &&
      Number(previous['attempts'] ?? 0) >= 5
    ) {
      throttled = true;
      return;
    }
    const windowStart = Number(previous['windowStart'] ?? 0);
    const attempts = windowStart + 60_000 > now ? Number(previous['attempts'] ?? 0) : 0;
    return { windowStart: windowStart + 60_000 > now ? windowStart : now, attempts: attempts + 1 };
  });
  if (throttled) throw new HttpsError('resource-exhausted', 'Demasiados códigos solicitados. Espera un minuto.');

  const code = randomInt(100_000, 1_000_000).toString();
  const codeHash = createHash('sha256').update(`${uid}:${code}`).digest('hex');
  await storeRef(`loginOtps/${uid}`).set({
    codeHash,
    expiresAt: now + OTP_LIFETIME_MS,
    attempts: 0,
    locked: false,
  });
  await sendEmail(
    email,
    'Tu código de verificación – Aula',
    emailHtml(
      'Código de verificación',
      `<p>Hola <strong>${escapeHtml(String(profile['name'] ?? ''))}</strong>,</p><p>Tu código para ingresar es:</p><p style="text-align:center;font-size:38px;font-weight:bold;letter-spacing:10px;color:#2A7BE4">${code}</p><p>Este código expira en 10 minutos.</p>`,
    ),
    `Tu código de verificación es: ${code}. Expira en 10 minutos.`,
  );
}

export const beginLogin = onCall(
  { secrets: [smtpPassword], maxInstances: 10 },
  async (request) => {
    if (request.rawRequest.ip) {
      const ipKey = createHash('sha256').update(request.rawRequest.ip).digest('hex');
      const ipRef = storeRef(`loginIpLimits/${ipKey}`);
      let ipThrottled = false;
      const now = Date.now();
      await ipRef.transaction((raw: unknown) => {
        const current = record(raw);
        const windowStart = Number(current['windowStart'] ?? 0);
        const attempts = windowStart + 60_000 > now ? Number(current['attempts'] ?? 0) : 0;
        if (attempts >= 20) {
          ipThrottled = true;
          return;
        }
        return { windowStart: windowStart + 60_000 > now ? windowStart : now, attempts: attempts + 1 };
      });
      if (ipThrottled) throw new HttpsError('resource-exhausted', 'Demasiados intentos. Espera un minuto.');
    }
    const input = record(request.data);
    const email = text(input['email'], 'El correo', 254).toLowerCase();
    const password = text(input['password'], 'La contraseña', 128);
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(firebaseWebApiKey.value())}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      },
    );
    if (!response.ok) {
      throw new HttpsError('unauthenticated', 'Correo o contraseña incorrectos.');
    }
    const credentials = record(await response.json());
    const uid = String(credentials['localId'] ?? '');
    const indexSnapshot = await storeRef(`userIndexByEmail/${encodeURIComponent(email)}`).get();
    const index = record(indexSnapshot.val());
    if (!uid || index['uid'] !== uid || typeof index['schoolId'] !== 'string') {
      throw new HttpsError('unauthenticated', 'Correo o contraseña incorrectos.');
    }
    const profileSnapshot = await storeRef(`schools/${index['schoolId']}/users/${uid}`).get();
    const profile = record(profileSnapshot.val());
    if (profile['active'] !== true || profile['email'] !== email) {
      throw new HttpsError('unauthenticated', 'Correo o contraseña incorrectos.');
    }

    await sendLoginOtp(uid, email, profile);
    return { otpSent: true, userId: uid, email };
  },
);

export const beginGoogleLogin = onCall(
  { secrets: [smtpPassword], maxInstances: 10 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Inicia sesión con Google para continuar.');
    const account = await auth.getUser(uid);
    if (account.disabled || !account.emailVerified || !account.email ||
        !account.providerData.some((provider) => provider.providerId === 'google.com')) {
      throw new HttpsError('permission-denied', 'Usa una cuenta de Google verificada autorizada por tu colegio.');
    }
    const index = record((await storeRef(`uidIndex/${uid}`).get()).val());
    const schoolId = String(index['schoolId'] ?? '');
    if (!schoolId) throw new HttpsError('permission-denied', 'Esta cuenta no está registrada en el sistema escolar.');
    const profile = record(
      (await storeRef(`schools/${schoolId}/users/${uid}`).get()).val(),
    );
    if (profile['active'] !== true ||
        String(profile['email'] ?? '').toLowerCase() !== account.email.toLowerCase()) {
      throw new HttpsError('permission-denied', 'Esta cuenta no está registrada en el sistema escolar.');
    }
    await sendLoginOtp(uid, account.email, profile);
    return { otpSent: true, userId: uid, email: account.email };
  },
);

export const verifyLoginOtp = onCall(async (request) => {
  if (request.rawRequest.ip) {
    const key = createHash('sha256').update(request.rawRequest.ip).digest('hex');
    const ref = storeRef(`otpIpLimits/${key}`);
    let throttled = false;
    const now = Date.now();
    await ref.transaction((raw: unknown) => {
      const current = record(raw);
      const start = Number(current['windowStart'] ?? 0);
      const count = start + 60_000 > now ? Number(current['attempts'] ?? 0) : 0;
      if (count >= 30) {
        throttled = true;
        return;
      }
      return { windowStart: start + 60_000 > now ? start : now, attempts: count + 1 };
    });
    if (throttled) throw new HttpsError('resource-exhausted', 'Demasiados intentos. Espera un minuto.');
  }
  const input = record(request.data);
  const uid = text(input['userId'], 'La cuenta', 128);
  const code = text(input['code'], 'El código', 6);
  const otpRef = storeRef(`loginOtps/${uid}`);
  const codeHash = createHash('sha256').update(`${uid}:${code}`).digest('hex');
  const result = await otpRef.transaction((raw: unknown) => {
    const otp = record(raw);
    if (
      typeof otp['codeHash'] !== 'string' ||
      otp['locked'] === true ||
      Number(otp['expiresAt']) <= Date.now()
    ) return;
    if (otp['codeHash'] === codeHash) {
      return null;
    }
    const attempts = Number(otp['attempts'] ?? 0) + 1;
    return { ...otp, attempts, locked: attempts >= 5 };
  });
  if (!result.committed || result.snapshot.exists()) {
    throw new HttpsError('unauthenticated', 'Código incorrecto, expirado o ya utilizado.');
  }

  const indexSnapshot = await storeRef(`uidIndex/${uid}`).get();
  const index = record(indexSnapshot.val());
  const schoolId = String(index['schoolId'] ?? '');
  if (!schoolId) throw new HttpsError('permission-denied', 'La cuenta no está vinculada a un colegio.');
  const profileSnapshot = await storeRef(`schools/${schoolId}/users/${uid}`).get();
  const profile = record(profileSnapshot.val());
  const account = await auth.getUser(uid);
  if (profile['active'] !== true || account.disabled) {
    throw new HttpsError('permission-denied', 'La cuenta está desactivada.');
  }
  const role = String(profile['role']) as Role;
  if (!['ADMIN', 'TEACHER', 'PARENT', 'STUDENT'].includes(role)) {
    throw new HttpsError('permission-denied', 'El perfil de la cuenta no tiene un rol válido.');
  }
  const customToken = await auth.createCustomToken(uid, {
    otpVerified: true,
    schoolId,
    role,
    schoolName: String((await schoolRef(schoolId).child('name').get()).val() ?? schoolName.value()),
  });
  return { customToken };
});

export const requestPasswordReset = onCall(
  { secrets: [smtpPassword], maxInstances: 5 },
  async (request) => {
    if (request.rawRequest.ip) {
      const ipKey = createHash('sha256').update(request.rawRequest.ip).digest('hex');
      const ipRef = storeRef(`resetIpLimits/${ipKey}`);
      let throttled = false;
      const now = Date.now();
      await ipRef.transaction((raw: unknown) => {
        const current = record(raw);
        const windowStart = Number(current['windowStart'] ?? 0);
        const attempts = windowStart + 60_000 > now ? Number(current['attempts'] ?? 0) : 0;
        if (attempts >= 5) {
          throttled = true;
          return;
        }
        return { windowStart: windowStart + 60_000 > now ? windowStart : now, attempts: attempts + 1 };
      });
      if (throttled) throw new HttpsError('resource-exhausted', 'Demasiadas solicitudes. Intenta más tarde.');
    }
    const email = text(record(request.data)['email'], 'El correo', 254).toLowerCase();
    try {
      const account = await auth.getUserByEmail(email);
      const index = record((await storeRef(`uidIndex/${account.uid}`).get()).val());
      const schoolId = String(index['schoolId'] ?? '');
      const profile = record((await storeRef(`schools/${schoolId}/users/${account.uid}`).get()).val());
      if (profile['active'] !== true) {
        return { message: 'Si la cuenta existe, recibirás un enlace para restablecer la contraseña.' };
      }
      const resetUrl = await auth.generatePasswordResetLink(email, {
        url: 'https://sistema-escolar-fec8f.web.app',
        handleCodeInApp: false,
      });
      await sendEmail(
        email,
        'Restablece tu contraseña – Aula',
        emailHtml(
          'Restablecer contraseña',
          `<p>Hola <strong>${escapeHtml(String(profile['name'] ?? ''))}</strong>,</p><p>Solicitaste restablecer la contraseña de tu cuenta.</p><p style="text-align:center;margin:28px"><a href="${escapeHtml(resetUrl)}" style="background:#2A7BE4;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold">Crear nueva contraseña</a></p><p>Si no solicitaste este cambio, ignora este mensaje.</p>`,
        ),
        `Restablece tu contraseña: ${resetUrl}`,
      );
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'auth/user-not-found')) {
        throw error;
      }
    }
    return { message: 'Si la cuenta existe, recibirás un enlace para restablecer la contraseña.' };
  },
);

export const schoolApi = onCall(
  { secrets: [smtpPassword], maxInstances: 20 },
  async (request) => {
    const user = await currentUser(request);
    const input = record(request.data);
    const action = text(input['action'], 'La acción', 80);
    const root = schoolRef(user.schoolId);
    const [studentRows, groupRows, subjectRows, gradeRows, reportRows, cycleRows, userRows] =
      await Promise.all([
        values(user, 'students'),
        values(user, 'groups'),
        values(user, 'subjects'),
        values(user, 'grades'),
        values(user, 'reports'),
        values(user, 'cycles'),
        values(user, 'users'),
      ]);
    const studentsById = byId(studentRows);
    const groupsById = byId(groupRows);
    const usersById = byId(userRows);
    const studentsInScope = () =>
      studentRows.filter((student) => {
        if (user.role === 'PARENT' || user.role === 'STUDENT') return student['parentUserId'] === user.uid;
        if (user.role === 'TEACHER') {
          const group = groupsById.get(String(student['groupId']));
          return group?.['teacherId'] === user.uid;
        }
        return user.role === 'ADMIN';
      });
    const groupDto = (group: Values) => ({
      ...group,
      teacher: usersById.get(String(group['teacherId']))?.['name'] ?? null,
      students: studentRows.filter((student) => student['groupId'] === group['id']).length,
    });
    const studentDto = (student: Values) => {
      const group = groupsById.get(String(student['groupId']));
      return {
        ...student,
        group: String(group?.['name'] ?? ''),
        grade: String(group?.['grade'] ?? ''),
        parentUserId: student['parentUserId'] ?? null,
      };
    };

    switch (action) {
      case 'getDashboard': {
        const scoped = studentsInScope();
        if (user.role === 'PARENT') {
          const children = scoped.map((student) => {
            const group = groupsById.get(String(student['groupId']));
            const grades = gradeRows.filter((grade) => grade['studentId'] === student['id']);
            const average = grades.length
              ? Math.round((grades.reduce((sum, grade) => sum + Number(grade['value']), 0) / grades.length) * 10) / 10
              : null;
            return {
              id: student['id'], name: student['name'],
              registrationNumber: student['registrationNumber'],
              groupName: group?.['name'] ?? '', groupGrade: group?.['grade'] ?? '',
              status: student['status'], gradesCount: grades.length, average,
            };
          });
          return {
            role: 'PARENT', children, totalChildren: children.length,
            students: children.length, pendingStudents: 0, groups: 0, users: 0,
            groupOccupancy: [],
          };
        }
        if (user.role === 'STUDENT') {
          const student = scoped[0];
          const ownGrades = student
            ? gradeRows.filter((grade) => grade['studentId'] === student['id'])
            : [];
          const average = ownGrades.length
            ? Math.round((ownGrades.reduce((sum, grade) => sum + Number(grade['value']), 0) / ownGrades.length) * 10) / 10
            : null;
          return {
            role: user.role, gradesCount: ownGrades.length, average,
            students: 0, pendingStudents: 0, groups: 0, users: 0,
            groupOccupancy: [], children: [], totalChildren: 0,
          };
        }
        const scopedGroups = groupRows.filter((group) =>
          user.role === 'ADMIN' || group['teacherId'] === user.uid,
        );
        const visibleStudents = user.role === 'ADMIN' ? studentRows : scoped;
        const ownGrades = user.role === 'TEACHER'
          ? gradeRows.filter((grade) => grade['teacherId'] === user.uid)
          : [];
        const avg = ownGrades.length
          ? Math.round((ownGrades.reduce((sum, grade) => sum + Number(grade['value']), 0) / ownGrades.length) * 10) / 10
          : null;
        return {
          role: user.role,
          students: visibleStudents.length,
          pendingStudents: visibleStudents.filter((student) => student['status'] === 'PENDING').length,
          groups: scopedGroups.length,
          users: user.role === 'ADMIN' ? userRows.filter((row) => row['active'] === true).length : 0,
          teacherGradeAvg: avg,
          children: [], totalChildren: 0,
          groupOccupancy: sortBy(scopedGroups, 'name').map((group) => ({
            id: group['id'], name: group['name'], grade: group['grade'],
            capacity: group['capacity'],
            students: studentRows.filter((student) => student['groupId'] === group['id']).length,
          })),
        };
      }
      case 'getCurrentUser': {
        const profile = record((await root.child(`users/${user.uid}`).get()).val());
        return {
          id: user.uid,
          schoolId: user.schoolId,
          schoolName: String((await root.child('name').get()).val() ?? schoolName.value()),
          name: String(profile['name'] ?? ''),
          email: String(profile['email'] ?? ''),
          role: user.role,
        };
      }
      case 'getStudents': {
        const query = String(input['search'] ?? '').trim().toLocaleLowerCase('es-MX');
        return studentsInScope()
          .filter((student) => !query || [
            student['name'],
            student['registrationNumber'],
            student['guardian'],
            groupsById.get(String(student['groupId']))?.['name'],
            groupsById.get(String(student['groupId']))?.['grade'],
          ].some((value) => String(value ?? '').toLocaleLowerCase('es-MX').includes(query)))
          .map(studentDto);
      }
      case 'getMyChildren':
        return studentRows.filter((student) => student['parentUserId'] === user.uid).map(studentDto);
      case 'getGroups':
        return sortBy(
          groupRows.filter((group) => user.role === 'ADMIN' || group['teacherId'] === user.uid),
          'name',
        ).map(groupDto);
      case 'getUsers':
        requireRole(user, 'ADMIN');
        return sortBy(userRows, 'name');
      case 'createUser': {
        requireRole(user, 'ADMIN');
        const email = text(input['email'], 'El correo', 254).toLowerCase();
        const password = text(input['password'], 'La contraseña', 128);
        const role = text(input['role'], 'El rol', 12);
        if (!['ADMIN', 'TEACHER', 'PARENT', 'STUDENT'].includes(role)) {
          throw new HttpsError('invalid-argument', 'El rol no es válido.');
        }
        if (record((await storeRef(`userIndexByEmail/${encodeURIComponent(email)}`).get()).val())['uid']) {
          throw new HttpsError('already-exists', 'Ese correo ya está registrado.');
        }
        const created = await auth.createUser({
          email,
          password,
          displayName: text(input['name'], 'El nombre', 120),
        });
        const profile = {
          id: created.uid,
          schoolId: user.schoolId,
          name: created.displayName,
          email,
          role,
          active: true,
        };
        try {
          await storeRef().update({
            [`schools/${user.schoolId}/users/${created.uid}`]: profile,
            [`userIndexByEmail/${encodeURIComponent(email)}`]: {
              uid: created.uid,
              schoolId: user.schoolId,
            },
            [`uidIndex/${created.uid}`]: { schoolId: user.schoolId },
          });
        } catch (error) {
          await auth.deleteUser(created.uid);
          throw error;
        }
        return profile;
      }
      case 'updateUser': {
        requireRole(user, 'ADMIN');
        const id = text(input['id'], 'La cuenta', 128);
        const profileRef = root.child(`users/${id}`);
        const snapshot = await profileRef.get();
        if (!snapshot.exists()) throw new HttpsError('not-found', 'No se encontró el usuario.');
        const oldProfile = record(snapshot.val());
        const updates = record(input['changes']);
        const data: Values = {};
        if (typeof updates['active'] === 'boolean') data['active'] = updates['active'];
        if (typeof updates['name'] === 'string') data['name'] = text(updates['name'], 'El nombre', 120);
        if (typeof updates['email'] === 'string') data['email'] = text(updates['email'], 'El correo', 254).toLowerCase();
        if (typeof updates['role'] === 'string' && ['ADMIN', 'TEACHER', 'PARENT', 'STUDENT'].includes(updates['role'])) data['role'] = updates['role'];
        if (typeof updates['role'] === 'string' && !['ADMIN', 'TEACHER', 'PARENT', 'STUDENT'].includes(updates['role'])) {
          throw new HttpsError('invalid-argument', 'El rol no es válido.');
        }
        if (id === user.uid && data['active'] === false) {
          throw new HttpsError('failed-precondition', 'No puedes desactivar tu propia cuenta.');
        }
        if (
          oldProfile['role'] === 'ADMIN' &&
          oldProfile['active'] === true &&
          (data['role'] !== undefined && data['role'] !== 'ADMIN' || data['active'] === false)
        ) {
          const activeAdmins = userRows.filter((row) => row['role'] === 'ADMIN' && row['active'] === true);
          if (activeAdmins.length <= 1) {
            throw new HttpsError('failed-precondition', 'El colegio debe conservar al menos un administrador activo.');
          }
        }
        const oldEmail = String(oldProfile['email']);
        if (data['email'] && data['email'] !== oldEmail) {
          await storeRef(`userIndexByEmail/${encodeURIComponent(oldEmail)}`).remove();
          await storeRef(`userIndexByEmail/${encodeURIComponent(String(data['email']))}`).set({ uid: id, schoolId: user.schoolId });
        }
        if (data['active'] !== undefined || data['email'] || data['name']) {
          await auth.updateUser(id, {
            ...(typeof data['active'] === 'boolean' ? { disabled: !data['active'] } : {}),
            ...(typeof data['email'] === 'string' ? { email: data['email'] } : {}),
            ...(typeof data['name'] === 'string' ? { displayName: data['name'] } : {}),
          });
        }
        await profileRef.update(data);
        return { ...oldProfile, ...data };
      }
      case 'deleteUser': {
        requireRole(user, 'ADMIN');
        const id = text(input['id'], 'La cuenta', 128);
        if (id === user.uid) throw new HttpsError('failed-precondition', 'No puedes eliminar tu propia cuenta.');
        const profile = record((await root.child(`users/${id}`).get()).val());
        if (!profile['email']) throw new HttpsError('not-found', 'No se encontró el usuario.');
        if (profile['role'] === 'ADMIN' && profile['active'] === true &&
            userRows.filter((row) => row['role'] === 'ADMIN' && row['active'] === true).length <= 1) {
          throw new HttpsError('failed-precondition', 'El colegio debe conservar al menos un administrador activo.');
        }
        await auth.deleteUser(id);
        await root.child(`users/${id}`).remove();
        await storeRef(`uidIndex/${id}`).remove();
        await storeRef(`userIndexByEmail/${encodeURIComponent(String(profile['email']))}`).remove();
        return null;
      }
      case 'createStudent':
      case 'updateStudent':
      case 'deleteStudent': {
        requireRole(user, 'ADMIN');
        const id = action === 'createStudent' ? randomUUID() : text(input['id'], 'El estudiante', 128);
        const data = record(input['data']);
        const old = record((await root.child(`students/${id}`).get()).val());
        if (action === 'deleteStudent') {
          if (!old['id']) throw new HttpsError('not-found', 'No se encontró el estudiante.');
          const related: Record<string, null> = {};
          const attendanceRows = list(await root.child('attendance').get());
          for (const grade of gradeRows.filter((row) => row['studentId'] === id)) related[`grades/${grade['id']}`] = null;
          for (const attendance of attendanceRows.filter((row) => row['studentId'] === id)) related[`attendance/${attendance['id']}`] = null;
          await root.update({ [`students/${id}`]: null, ...related });
          return null;
        }
        const groupId = data['groupId'] === undefined ? String(old['groupId'] ?? '') : text(data['groupId'], 'El grupo', 128);
        const group = groupsById.get(groupId);
        if (!group) throw new HttpsError('not-found', 'No se encontró el grupo.');
        const groupCount = studentRows.filter((student) => student['groupId'] === groupId && student['id'] !== id).length;
        if (groupCount >= Number(group['capacity'])) throw new HttpsError('failed-precondition', 'El grupo llegó a su capacidad máxima.');
        let registrationNumber = old['registrationNumber'];
        if (action === 'createStudent') {
          registrationNumber = `AL-${randomInt(0, 0x100000000).toString(16).padStart(8, '0').toUpperCase()}`;
        }
        const parentUserId = data['parentUserId'] === null || data['parentUserId'] === ''
          ? null
          : String(data['parentUserId'] ?? old['parentUserId'] ?? '') || null;
        if (parentUserId) {
          const parent = record((await root.child(`users/${parentUserId}`).get()).val());
          if (parent['role'] !== 'PARENT' || parent['active'] !== true) {
            throw new HttpsError('invalid-argument', 'Selecciona una cuenta activa de padre o tutor.');
          }
        }
        const updated = {
          ...old,
          id,
          schoolId: user.schoolId,
          registrationNumber,
          name: data['name'] === undefined ? old['name'] : text(data['name'], 'El nombre', 120),
          guardian: data['guardian'] === undefined ? old['guardian'] : text(data['guardian'], 'El tutor', 120),
          groupId,
          status: data['status'] ?? old['status'] ?? 'ENROLLED',
          parentUserId,
          ...(action === 'createStudent' ? { createdAt: new Date().toISOString() } : {}),
        };
        await root.child(`students/${id}`).set(updated);
        return studentDto(updated);
      }
      case 'createGroup':
      case 'updateGroup':
      case 'deleteGroup': {
        requireRole(user, 'ADMIN');
        const id = action === 'createGroup' ? randomUUID() : text(input['id'], 'El grupo', 128);
        const data = record(input['data']);
        const old = groupsById.get(id);
        if (action !== 'createGroup' && !old) throw new HttpsError('not-found', 'No se encontró el grupo.');
        if (action === 'deleteGroup') {
          if (studentRows.some((student) => student['groupId'] === id)) {
            throw new HttpsError('failed-precondition', 'No se puede eliminar un grupo con estudiantes inscritos.');
          }
          await root.child(`groups/${id}`).remove();
          return null;
        }
        const capacity = Number(data['capacity'] ?? old?.['capacity']);
        const studentCount = studentRows.filter((student) => student['groupId'] === id).length;
        if (!Number.isInteger(capacity) || capacity < 1 || capacity < studentCount) {
          throw new HttpsError('invalid-argument', 'La capacidad debe cubrir a los alumnos inscritos.');
        }
        const teacherId = data['teacherId'] || null;
        if (teacherId) {
          const teacher = record((await root.child(`users/${teacherId}`).get()).val());
          if (teacher['role'] !== 'TEACHER' || teacher['active'] !== true) {
            throw new HttpsError('invalid-argument', 'Selecciona un docente activo.');
          }
        }
        const groupName = text(data['name'] ?? old?.['name'], 'El grupo', 80);
        if (groupRows.some((item) => item['name'] === groupName && item['id'] !== id)) {
          throw new HttpsError('already-exists', 'Ya existe un grupo con ese nombre.');
        }
        const updated = {
          ...old,
          id,
          schoolId: user.schoolId,
          name: groupName,
          grade: text(data['grade'] ?? old?.['grade'], 'El grado', 80),
          room: text(data['room'] ?? old?.['room'], 'El salón', 80),
          capacity,
          teacherId,
        };
        await root.child(`groups/${id}`).set(updated);
        return groupDto(updated);
      }
      case 'getSubjects':
        return sortBy(subjectRows, 'name');
      case 'createSubject':
      case 'deleteSubject': {
        requireRole(user, 'ADMIN');
        const id = text(input['id'] ?? randomUUID(), 'La materia', 128);
        if (action === 'deleteSubject') {
          await root.child(`subjects/${id}`).remove();
          const updates: Record<string, null> = {};
          for (const grade of gradeRows.filter((row) => row['subjectId'] === id)) updates[`grades/${grade['id']}`] = null;
          await root.update(updates);
          return null;
        }
        const name = text(input['name'], 'La materia', 80);
        if (subjectRows.some((subject) => subject['name'] === name)) throw new HttpsError('already-exists', 'Ya existe esa materia.');
        const subject = { id, name, schoolId: user.schoolId };
        await root.child(`subjects/${id}`).set(subject);
        return subject;
      }
      case 'getGrades': {
        const requestedGroup = String(input['groupId'] ?? '');
        const requestedPeriod = String(input['period'] ?? '');
        const requestedStudent = String(input['studentId'] ?? '');
        const scopedStudents = studentsInScope();
        return gradeRows.filter((grade) => {
          const student = studentsById.get(String(grade['studentId']));
          return student && (!requestedStudent || grade['studentId'] === requestedStudent) &&
            (!requestedGroup || student['groupId'] === requestedGroup) &&
            (!requestedPeriod || grade['period'] === requestedPeriod) &&
            (user.role !== 'TEACHER' || grade['teacherId'] === user.uid) &&
            scopedStudents.some((candidate) => candidate['id'] === student['id']);
        }).map((grade) => ({
          ...grade,
          studentName: studentsById.get(String(grade['studentId']))?.['name'] ?? '',
          registrationNumber: studentsById.get(String(grade['studentId']))?.['registrationNumber'] ?? '',
          subjectName: byId(subjectRows).get(String(grade['subjectId']))?.['name'] ?? '',
          teacherName: usersById.get(String(grade['teacherId']))?.['name'] ?? '',
        }));
      }
      case 'createGrade':
      case 'updateGrade':
      case 'deleteGrade':
      case 'bulkUpsertGrades': {
        requireRole(user, 'ADMIN', 'TEACHER');
        const permittedStudent = (studentId: string) => {
          const student = studentsById.get(studentId);
          if (!student) throw new HttpsError('not-found', 'No se encontró el estudiante.');
          if (user.role === 'TEACHER' && groupsById.get(String(student['groupId']))?.['teacherId'] !== user.uid) {
            throw new HttpsError('permission-denied', 'El estudiante no pertenece a tus grupos.');
          }
          return student;
        };
        const save = async (studentId: string, subjectId: string, period: string, value: unknown, notes: unknown, id?: string) => {
          const student = permittedStudent(studentId);
          if (!subjectRows.some((subject) => subject['id'] === subjectId)) throw new HttpsError('not-found', 'No se encontró la materia.');
          const numeric = Number(value);
          const config = record((await root.child('config').get()).val());
          const scale = Number(config['gradingScale'] ?? 10);
          if (!Number.isFinite(numeric) || numeric < 0 || numeric > scale) throw new HttpsError('invalid-argument', `La calificación debe estar entre 0 y ${scale}.`);
          if (!['Q1', 'Q2', 'Q3', 'Q4', 'FINAL'].includes(period)) throw new HttpsError('invalid-argument', 'El periodo no es válido.');
          const existingGrade = gradeRows.find((grade) => grade['studentId'] === studentId && grade['subjectId'] === subjectId && grade['period'] === period);
          if (action === 'createGrade' && existingGrade) {
            throw new HttpsError('already-exists', 'Ya existe una calificación para este alumno, materia y periodo.');
          }
          const key = id ?? (existingGrade?.['id'] as string | undefined) ?? randomUUID();
          const grade = {
            id: key, schoolId: user.schoolId, studentId, subjectId,
            teacherId: user.uid, period, value: numeric, notes: optionalText(notes, 500),
            createdAt: new Date().toISOString(),
          };
          await root.child(`grades/${key}`).set(grade);
          return { id: key, studentId, value: numeric, period };
        };
        if (action === 'deleteGrade') {
          const id = text(input['id'], 'La calificación', 128);
          const grade = gradeRows.find((row) => row['id'] === id);
          if (!grade) throw new HttpsError('not-found', 'No se encontró la calificación.');
          permittedStudent(String(grade['studentId']));
          if (user.role === 'TEACHER' && grade['teacherId'] !== user.uid) throw new HttpsError('permission-denied', 'Solo puedes eliminar calificaciones que tú registraste.');
          await root.child(`grades/${id}`).remove();
          return null;
        }
        if (action === 'updateGrade') {
          const grade = gradeRows.find((row) => row['id'] === input['id']);
          if (!grade) throw new HttpsError('not-found', 'No se encontró la calificación.');
          permittedStudent(String(grade['studentId']));
          if (user.role === 'TEACHER' && grade['teacherId'] !== user.uid) throw new HttpsError('permission-denied', 'Solo puedes editar calificaciones que tú registraste.');
          const value = Number(input['value'] ?? grade['value']);
          const scale = Number(record((await root.child('config').get()).val())['gradingScale'] ?? 10);
          if (!Number.isFinite(value) || value < 0 || value > scale) throw new HttpsError('invalid-argument', `La calificación debe estar entre 0 y ${scale}.`);
          const updated = { ...grade, value, notes: input['notes'] === undefined ? grade['notes'] : optionalText(input['notes'], 500) };
          await root.child(`grades/${grade['id']}`).set(updated);
          return updated;
        }
        if (action === 'createGrade') {
          const data = record(input['data']);
          return save(
            text(data['studentId'], 'El estudiante', 128),
            text(data['subjectId'], 'La materia', 128),
            text(data['period'], 'El periodo', 10),
            data['value'],
            data['notes'],
          );
        }
        const groupId = text(input['groupId'], 'El grupo', 128);
        if (user.role === 'TEACHER' && groupsById.get(groupId)?.['teacherId'] !== user.uid) {
          throw new HttpsError('permission-denied', 'No tienes permiso sobre este grupo.');
        }
        const entries = input['grades'];
        if (!Array.isArray(entries) || !entries.length) throw new HttpsError('invalid-argument', 'No hay calificaciones para guardar.');
        const results = [];
        for (const raw of entries) {
          const entry = record(raw);
          const student = permittedStudent(text(entry['studentId'], 'El estudiante', 128));
          if (student['groupId'] !== groupId) throw new HttpsError('invalid-argument', 'Hay estudiantes fuera del grupo seleccionado.');
          results.push(await save(String(student['id']), text(input['subjectId'], 'La materia', 128), text(input['period'], 'El periodo', 10), entry['value'], undefined));
        }
        return { saved: results.length, grades: results };
      }
      case 'getReports':
        return reportRows.filter((report) =>
          (user.role === 'ADMIN' || user.role === 'PARENT' ||
            report['teacherId'] === user.uid ||
            (user.role === 'TEACHER' && groupsById.get(String(report['groupId']))?.['teacherId'] === user.uid)) &&
          (user.role !== 'PARENT' || studentsInScope().some((student) => student['groupId'] === report['groupId'])) &&
          (!input['groupId'] || report['groupId'] === input['groupId']),
        ).map((report) => ({
          ...report,
          teacherName: usersById.get(String(report['teacherId']))?.['name'] ?? user.name,
          groupName: groupsById.get(String(report['groupId']))?.['name'] ?? null,
          groupGrade: groupsById.get(String(report['groupId']))?.['grade'] ?? null,
        }));
      case 'createReport':
      case 'updateReport':
      case 'deleteReport': {
        requireRole(user, 'ADMIN', 'TEACHER');
        const id = action === 'createReport' ? randomUUID() : text(input['id'], 'El reporte', 128);
        const old = reportRows.find((row) => row['id'] === id);
        if (action !== 'createReport' && !old) throw new HttpsError('not-found', 'No se encontró el reporte.');
        if (old && user.role === 'TEACHER' && old['teacherId'] !== user.uid) throw new HttpsError('permission-denied', 'No puedes modificar este reporte.');
        if (action === 'deleteReport') {
          await root.child(`reports/${id}`).remove();
          return null;
        }
        const data = record(input['data']);
        const groupId = data['groupId'] === undefined ? old?.['groupId'] ?? null : data['groupId'] || null;
        if (groupId && !groupsById.has(String(groupId))) throw new HttpsError('not-found', 'No se encontró el grupo.');
        if (groupId && user.role === 'TEACHER' && groupsById.get(String(groupId))?.['teacherId'] !== user.uid) throw new HttpsError('permission-denied', 'No tienes permiso sobre este grupo.');
        const now = new Date().toISOString();
        const report = {
          ...old,
          id, schoolId: user.schoolId,
          teacherId: old?.['teacherId'] ?? user.uid,
          groupId,
          title: data['title'] === undefined ? old?.['title'] : text(data['title'], 'El título', 120),
          body: data['body'] === undefined ? old?.['body'] : text(data['body'], 'El texto', 5000),
          createdAt: old?.['createdAt'] ?? now,
          updatedAt: now,
        };
        await root.child(`reports/${id}`).set(report);
        return { ...report, teacherName: user.name, groupName: groupsById.get(String(groupId))?.['name'] ?? null, groupGrade: groupsById.get(String(groupId))?.['grade'] ?? null };
      }
      case 'getConfig': {
        const config = record((await root.child('config').get()).val());
        return {
          levelType: config['levelType'] ?? 'PRIMARY',
          gradingScale: config['gradingScale'] ?? 10,
          periods: config['periods'] ?? 'Q1,Q2,Q3,Q4,FINAL',
          address: config['address'] ?? '',
          phone: config['phone'] ?? '',
          directorName: config['directorName'] ?? '',
        };
      }
      case 'updateConfig': {
        requireRole(user, 'ADMIN');
        const data = record(input['data']);
        const current = record((await root.child('config').get()).val());
        const config = {
          levelType: data['levelType'] ?? current['levelType'] ?? 'PRIMARY',
          gradingScale: Number(data['gradingScale'] ?? current['gradingScale'] ?? 10),
          periods: data['periods'] ?? current['periods'] ?? 'Q1,Q2,Q3,Q4,FINAL',
          address: data['address'] ?? current['address'] ?? '',
          phone: data['phone'] ?? current['phone'] ?? '',
          directorName: data['directorName'] ?? current['directorName'] ?? '',
        };
        if (!['PRIMARY', 'SECONDARY', 'BACHILLERATO'].includes(String(config.levelType)) || ![10, 100].includes(config.gradingScale)) {
          throw new HttpsError('invalid-argument', 'La configuración escolar no es válida.');
        }
        await root.child('config').set(config);
        return config;
      }
      case 'getCycles':
        return sortBy(cycleRows, 'startDate').reverse();
      case 'createCycle':
      case 'updateCycle':
      case 'deleteCycle': {
        requireRole(user, 'ADMIN');
        const id = action === 'createCycle' ? randomUUID() : text(input['id'], 'El ciclo', 128);
        const old = cycleRows.find((row) => row['id'] === id);
        if (action !== 'createCycle' && !old) throw new HttpsError('not-found', 'Ciclo no encontrado.');
        if (action === 'deleteCycle') {
          if (list(await root.child('attendance').get()).some((row) => row['cycleId'] === id)) {
            throw new HttpsError('failed-precondition', 'El ciclo tiene asistencias registradas.');
          }
          await root.child(`cycles/${id}`).remove();
          return null;
        }
        const data = record(input['data']);
        const name = data['name'] === undefined ? String(old?.['name'] ?? '') : text(data['name'], 'El nombre', 40);
        if (cycleRows.some((cycle) => cycle['name'] === name && cycle['id'] !== id)) throw new HttpsError('already-exists', 'Ya existe un ciclo con ese nombre.');
        const cycle = {
          ...old,
          id,
          name,
          startDate: data['startDate'] ?? old?.['startDate'],
          endDate: data['endDate'] ?? old?.['endDate'],
          active: data['active'] ?? old?.['active'] ?? false,
        };
        if (
          typeof cycle['startDate'] !== 'string' ||
          typeof cycle['endDate'] !== 'string' ||
          Number.isNaN(Date.parse(String(cycle['startDate']))) ||
          Number.isNaN(Date.parse(String(cycle['endDate']))) ||
          Date.parse(String(cycle['endDate'])) < Date.parse(String(cycle['startDate']))
        ) {
          throw new HttpsError('invalid-argument', 'Las fechas del ciclo escolar no son válidas.');
        }
        if (cycle['active']) {
          const updates: Record<string, unknown> = {};
          cycleRows.forEach((item) => { if (item['id'] !== id) updates[`cycles/${item['id']}/active`] = false; });
          updates[`cycles/${id}`] = cycle;
          await root.update(updates);
        } else await root.child(`cycles/${id}`).set(cycle);
        return cycle;
      }
      case 'getAttendance':
      case 'getAttendanceSummary':
      case 'bulkAttendance': {
        requireRole(user, 'ADMIN', 'TEACHER');
        const allAttendance = list(await root.child('attendance').get());
        if (action === 'bulkAttendance') {
          const data = record(input['data']);
          const cycleId = text(data['cycleId'], 'El ciclo', 128);
          if (!cycleRows.some((cycle) => cycle['id'] === cycleId)) throw new HttpsError('not-found', 'Ciclo no encontrado.');
          const date = text(data['date'], 'La fecha', 10);
          const parsedDate = new Date(`${date}T00:00:00.000Z`);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || parsedDate.toISOString().slice(0, 10) !== date) {
            throw new HttpsError('invalid-argument', 'La fecha de asistencia no es válida.');
          }
          if (!Array.isArray(data['records']) || !(data['records'] as unknown[]).length) throw new HttpsError('invalid-argument', 'No hay asistencias para guardar.');
          const updates: Record<string, unknown> = {};
          const allowedStudents = new Set(studentsInScope().map((student) => String(student['id'])));
          for (const raw of data['records'] as unknown[]) {
            const entry = record(raw);
            const student = permittedAttendanceStudent(user, entry['studentId'], studentsById, groupsById);
            const id = `${student['id']}_${date}`;
            if (updates[`attendance/${id}`] !== undefined) {
              throw new HttpsError('invalid-argument', 'La lista contiene estudiantes repetidos.');
            }
            if (!allowedStudents.has(String(student['id']))) {
              throw new HttpsError('permission-denied', 'No puedes modificar asistencias fuera del alcance de tu cuenta.');
            }
            const previousForDate = allAttendance.find(
              (row) => row['studentId'] === student['id'] && row['date'] === date,
            );
            if (previousForDate && previousForDate['cycleId'] !== cycleId) {
              throw new HttpsError('failed-precondition', 'El estudiante ya tiene asistencia para esta fecha en otro ciclo.');
            }
            const status = text(entry['status'], 'El estado', 20);
            if (!['PRESENT', 'ABSENT', 'LATE', 'JUSTIFIED'].includes(status)) throw new HttpsError('invalid-argument', 'El estado de asistencia no es válido.');
            const previous = record((await root.child(`attendance/${id}`).get()).val());
            updates[`attendance/${id}`] = {
              ...previous, id, schoolId: user.schoolId, studentId: student['id'], cycleId, date,
              status, notes: optionalText(entry['notes'], 300),
            };
          }
          await root.update(updates);
          return { saved: Object.keys(updates).length };
        }
        const groupId = String(input['groupId'] ?? '');
        const cycleId = String(input['cycleId'] ?? '');
        if (action === 'getAttendance') {
          return allAttendance.filter((row) => {
            const student = studentsById.get(String(row['studentId']));
            return student && (!cycleId || row['cycleId'] === cycleId) &&
              (!input['date'] || row['date'] === input['date']) &&
              (!input['studentId'] || row['studentId'] === input['studentId']) &&
              (!groupId || student['groupId'] === groupId) &&
              (user.role === 'ADMIN' || groupsById.get(String(student['groupId']))?.['teacherId'] === user.uid);
          }).map((row) => ({
            ...row,
            studentName: studentsById.get(String(row['studentId']))?.['name'] ?? '',
            registrationNumber: studentsById.get(String(row['studentId']))?.['registrationNumber'] ?? '',
            groupId: studentsById.get(String(row['studentId']))?.['groupId'] ?? '',
          }));
        }
        const targetStudents = studentsInScope().filter((student) => !groupId || student['groupId'] === groupId);
        const counts = new Map<string, Record<string, number>>();
        for (const row of allAttendance.filter((item) => item['cycleId'] === cycleId)) {
          const studentId = String(row['studentId']);
          const map = counts.get(studentId) ?? { PRESENT: 0, ABSENT: 0, LATE: 0, JUSTIFIED: 0 };
          const status = String(row['status']);
          map[status] = (map[status] ?? 0) + 1;
          counts.set(studentId, map);
        }
        return targetStudents.map((student) => {
          const count = counts.get(String(student['id'])) ?? { PRESENT: 0, ABSENT: 0, LATE: 0, JUSTIFIED: 0 };
          const total = count['PRESENT'] + count['ABSENT'] + count['LATE'] + count['JUSTIFIED'];
          return {
            studentId: student['id'], studentName: student['name'],
            registrationNumber: student['registrationNumber'], groupId: student['groupId'],
            present: count['PRESENT'], absent: count['ABSENT'], late: count['LATE'],
            justified: count['JUSTIFIED'], total,
            attendanceRate: total ? Math.round((count['PRESENT'] / total) * 100) : null,
          };
        });
      }
      case 'sendCommunique': {
        requireRole(user, 'ADMIN', 'TEACHER');
        const groupId = String(input['groupId'] ?? '');
        if (groupId && user.role === 'TEACHER' && groupsById.get(groupId)?.['teacherId'] !== user.uid) {
          throw new HttpsError('permission-denied', 'No tienes permiso sobre ese grupo.');
        }
        const parents = new Set(studentsInScope()
          .filter((student) => !groupId || student['groupId'] === groupId)
          .map((student) => String(student['parentUserId'] ?? ''))
          .filter(Boolean));
        const recipients = userRows.filter((row) => parents.has(String(row['id'])) && row['role'] === 'PARENT' && row['active'] === true);
        const subject = text(input['subject'], 'El asunto', 200);
        const body = text(input['body'], 'El mensaje', 3000);
        if (!recipients.length) throw new HttpsError('failed-precondition', 'No hay padres activos vinculados al grupo seleccionado.');
        const { transport, from } = await mailTransport();
        try {
          for (const recipient of recipients) {
            const email = text(recipient['email'], 'El correo', 254);
            await transport.sendMail({
              from, to: email, subject,
              html: emailHtml(subject, `<div>${escapeHtml(body).split('\n').map((line) => `<p>${line}</p>`).join('')}</div><p>— ${escapeHtml(user.name)}</p>`),
              text: body,
            });
          }
        } finally {
          transport.close();
        }
        return { sent: recipients.length };
      }
      case 'sendBoleta': {
        requireRole(user, 'ADMIN', 'TEACHER', 'PARENT');
        const student = studentsById.get(text(input['studentId'], 'El estudiante', 128));
        if (!student) throw new HttpsError('not-found', 'No se encontró el estudiante.');
        const group = groupsById.get(String(student['groupId']));
        if (user.role === 'PARENT' && student['parentUserId'] !== user.uid) throw new HttpsError('not-found', 'No se encontró el estudiante.');
        if (user.role === 'TEACHER' && group?.['teacherId'] !== user.uid) throw new HttpsError('not-found', 'No se encontró el estudiante.');
        const parent = userRows.find((row) => row['id'] === student['parentUserId'] && row['role'] === 'PARENT' && row['active'] === true);
        if (!parent) throw new HttpsError('failed-precondition', 'El estudiante no tiene un padre activo vinculado.');
        const period = String(input['period'] ?? '');
        const grades = gradeRows.filter((grade) => grade['studentId'] === student['id'] && (!period || grade['period'] === period));
        if (!grades.length) throw new HttpsError('failed-precondition', 'No hay calificaciones para incluir en la boleta.');
        const subjects = byId(subjectRows);
        const rows = grades.map((grade) => ({
          subject: `${String(subjects.get(String(grade['subjectId']))?.['name'] ?? 'Materia')}${period ? '' : ` (${grade['period']})`}`,
          value: Number(grade['value']),
          notes: String(grade['notes'] ?? ''),
        }));
        const recipient = text(parent['email'], 'El correo del tutor', 254);
        const name = text(student['name'], 'El estudiante', 120);
        const periodLabel = period || 'Todos los periodos';
        const average = (rows.reduce((total, grade) => total + grade.value, 0) / rows.length).toFixed(2);
        const table = rows.map((grade) =>
          `<tr><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(grade.subject)}</td><td style="padding:8px;text-align:center;border-bottom:1px solid #eee">${grade.value}</td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(grade.notes)}</td></tr>`,
        ).join('');
        await sendEmail(
          recipient,
          `Boleta de calificaciones – ${name} – ${periodLabel}`,
          emailHtml(`Boleta: ${name}`, `<p>Hola ${escapeHtml(String(parent['name'] ?? ''))},</p><p>Calificaciones de <strong>${escapeHtml(name)}</strong>, periodo <strong>${escapeHtml(periodLabel)}</strong>:</p><table style="width:100%;border-collapse:collapse"><tr><th>Materia</th><th>Calificación</th><th>Notas</th></tr>${table}</table><p>Promedio: <strong>${average}</strong></p>`),
          `Boleta de ${name}, ${periodLabel}. Promedio: ${average}`,
        );
        return { sent: true };
      }
      default:
        throw new HttpsError('not-found', `Acción desconocida: ${action}.`);
    }
  },
);

function permittedAttendanceStudent(
  user: UserContext,
  rawId: unknown,
  students: Map<string, Values>,
  groups: Map<string, Values>,
): Values {
  const id = text(rawId, 'El estudiante', 128);
  const student = students.get(id);
  if (!student) throw new HttpsError('not-found', 'No se encontró el estudiante.');
  if (user.role === 'TEACHER' && groups.get(String(student['groupId']))?.['teacherId'] !== user.uid) {
    throw new HttpsError('permission-denied', 'El estudiante no pertenece a tus grupos.');
  }
  return student;
}
