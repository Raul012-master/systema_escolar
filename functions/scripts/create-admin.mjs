import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stdin, stdout } from 'node:process';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const projectId = 'sistema-escolar-fec8f';
const schoolId = process.env.FIREBASE_SCHOOL_ID || projectId;
const functionsEnvPath = fileURLToPath(new URL('../.env.sistema-escolar-fec8f', import.meta.url));
const functionsEnv = existsSync(functionsEnvPath) ? readFileSync(functionsEnvPath, 'utf8') : '';
const configuredSchoolName = functionsEnv.match(/^SCHOOL_NAME=(.*)$/m)?.[1]?.trim();
const schoolName = process.env.SCHOOL_NAME ||
  (configuredSchoolName?.startsWith('"') ? JSON.parse(configuredSchoolName) : configuredSchoolName?.replace(/^['"]|['"]$/g, '')) ||
  'Colegio del Valle';
const prompt = createInterface({ input: stdin, output: stdout });

async function readHidden(label) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Ejecuta este comando desde una terminal interactiva para ingresar la contraseña de forma segura.');
  }
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (buffer) => {
      for (const character of buffer.toString('utf8')) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('Operación cancelada.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u0008' || character === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= ' ') value += character;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const email = (await prompt.question('Correo administrador [admin@colegio.mx]: '))
    .trim()
    .toLowerCase() || 'admin@colegio.mx';
  const name = (await prompt.question('Nombre administrador [admin]: '))
    .trim() || 'admin';
  prompt.close();
  const password = await readHidden('Contraseña (mínimo 12 caracteres): ');
  const confirmation = await readHidden('Confirma la contraseña: ');
  if (password.length < 12) throw new Error('La contraseña debe tener al menos 12 caracteres.');
  if (password !== confirmation) throw new Error('Las contraseñas no coinciden.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('El correo no es válido.');

  initializeApp({ projectId });
  const auth = getAuth();
  const firestore = getFirestore();
  const schoolRef = firestore.doc(`schools/${schoolId}`);
  const adminProfiles = await schoolRef.collection('users')
    .where('role', '==', 'ADMIN')
    .where('active', '==', true)
    .limit(1)
    .get();
  if (!adminProfiles.empty) throw new Error(`El colegio ${schoolId} ya tiene un administrador activo.`);
  try {
    await auth.getUserByEmail(email);
    throw new Error('Ya existe una cuenta de Firebase Authentication con ese correo.');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'auth/user-not-found')) {
      throw error;
    }
  }

  const account = await auth.createUser({
    email,
    password,
    displayName: name,
    emailVerified: false,
    disabled: false,
  });
  try {
    const batch = firestore.batch();
    batch.set(schoolRef, { name: schoolName }, { merge: true });
    batch.set(schoolRef.collection('users').doc(account.uid), {
      id: account.uid,
      schoolId,
      name,
      email,
      role: 'ADMIN',
      active: true,
    });
    batch.set(firestore.doc(`uidIndex/${account.uid}`), { schoolId });
    batch.set(firestore.doc(`userIndexByEmail/${encodeURIComponent(email)}`), {
      uid: account.uid,
      schoolId,
    });
    await batch.commit();
  } catch (error) {
    await auth.deleteUser(account.uid);
    throw error;
  }
  console.info(`Administrador creado: ${email} (colegio ${schoolId}).`);
  console.info('La contraseña no se guardó en archivos ni se mostró.');
}

main()
  .catch((error) => {
    console.error(`No se pudo crear el administrador: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => prompt.close());
