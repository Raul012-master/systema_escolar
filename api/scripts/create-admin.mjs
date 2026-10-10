import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { cert, initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const projectId = process.env.FIREBASE_PROJECT_ID || 'sistema-escolar-fec8f';
const schoolId = process.env.FIREBASE_SCHOOL_ID || projectId;
const schoolName = process.env.SCHOOL_NAME || 'Colegio del Valle';

if (!getApps().length) {
  const credJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (credJson) {
    initializeApp({ credential: cert(JSON.parse(credJson)) });
  } else {
    initializeApp({ projectId });
  }
}

const auth = getAuth();
const db = getFirestore();
const prompt = createInterface({ input: stdin, output: stdout });

async function readHidden(label) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Ejecuta este comando desde una terminal interactiva.');
  }
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\u0003') { cleanup(); reject(new Error('Cancelado.')); return; }
        if (ch === '\r' || ch === '\n') { cleanup(); stdout.write('\n'); resolve(value); return; }
        if (ch === '\u0008' || ch === '\u007f') { value = value.slice(0, -1); continue; }
        if (ch >= ' ') value += ch;
      }
    };
    const cleanup = () => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); };
    stdin.on('data', onData);
  });
}

async function main() {
  const email = ((await prompt.question('Correo administrador [admin@colegio.mx]: ')).trim().toLowerCase()) || 'admin@colegio.mx';
  const name = ((await prompt.question('Nombre administrador [admin]: ')).trim()) || 'admin';
  prompt.close();
  const password = await readHidden('Contraseña (mínimo 12 caracteres): ');
  const confirm = await readHidden('Confirma la contraseña: ');
  if (password.length < 12) throw new Error('La contraseña debe tener al menos 12 caracteres.');
  if (password !== confirm) throw new Error('Las contraseñas no coinciden.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('El correo no es válido.');

  const schoolRef = db.doc(`schools/${schoolId}`);
  const existing = await schoolRef.collection('users').where('role', '==', 'ADMIN').where('active', '==', true).limit(1).get();
  if (!existing.empty) throw new Error(`El colegio ${schoolId} ya tiene un administrador activo.`);

  try {
    await auth.getUserByEmail(email);
    throw new Error('Ya existe una cuenta con ese correo en Firebase Authentication.');
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'auth/user-not-found')) throw err;
  }

  const account = await auth.createUser({ email, password, displayName: name, emailVerified: false, disabled: false });
  try {
    const batch = db.batch();
    batch.set(schoolRef, { name: schoolName }, { merge: true });
    batch.set(schoolRef.collection('users').doc(account.uid), { id: account.uid, schoolId, name, email, role: 'ADMIN', active: true });
    batch.set(db.doc(`uidIndex/${account.uid}`), { schoolId });
    batch.set(db.doc(`userIndexByEmail/${encodeURIComponent(email)}`), { uid: account.uid, schoolId });
    await batch.commit();
  } catch (err) {
    await auth.deleteUser(account.uid);
    throw err;
  }
  console.info(`✓ Administrador creado: ${email} (colegio: ${schoolId})`);
}

main()
  .catch((err) => { console.error(`Error: ${err.message}`); process.exitCode = 1; })
  .finally(() => prompt.close());
