import { Router } from 'express';
import { createHash, randomInt } from 'node:crypto';
import { auth } from './firebase.js';
import { ApiError, record, storeRef, text, escapeHtml, emailHtml, sendEmail } from './utils.js';
export const authRouter = Router();
const OTP_TTL = 10 * 60 * 1000;
async function sendLoginOtp(uid, email, profile) {
    const now = Date.now();
    let throttled = false;
    await storeRef(`loginLimits/${uid}`).transaction((cur) => {
        const p = record(cur);
        if (Number(p['windowStart'] ?? 0) + 60_000 > now && Number(p['attempts'] ?? 0) >= 5) {
            throttled = true;
            return;
        }
        const ws = Number(p['windowStart'] ?? 0);
        const att = ws + 60_000 > now ? Number(p['attempts'] ?? 0) : 0;
        return { windowStart: ws + 60_000 > now ? ws : now, attempts: att + 1 };
    });
    if (throttled)
        throw new ApiError(429, 'Demasiados códigos solicitados. Espera un minuto.');
    const code = randomInt(100_000, 1_000_000).toString();
    const codeHash = createHash('sha256').update(`${uid}:${code}`).digest('hex');
    await storeRef(`loginOtps/${uid}`).set({ codeHash, expiresAt: now + OTP_TTL, attempts: 0, locked: false });
    await sendEmail(email, 'Tu código de verificación – Aula', emailHtml('Código de verificación', `<p>Hola <strong>${escapeHtml(String(profile['name'] ?? ''))}</strong>,</p><p>Tu código para ingresar es:</p><p style="text-align:center;font-size:38px;font-weight:bold;letter-spacing:10px;color:#2A7BE4">${code}</p><p>Este código expira en 10 minutos.</p>`), `Tu código de verificación es: ${code}. Expira en 10 minutos.`);
}
// POST /auth/login
authRouter.post('/login', async (req, res) => {
    try {
        const ip = req.ip ?? '';
        if (ip) {
            const key = createHash('sha256').update(ip).digest('hex');
            let blocked = false;
            const now = Date.now();
            await storeRef(`loginIpLimits/${key}`).transaction((cur) => {
                const c = record(cur);
                const ws = Number(c['windowStart'] ?? 0);
                const att = ws + 60_000 > now ? Number(c['attempts'] ?? 0) : 0;
                if (att >= 20) {
                    blocked = true;
                    return;
                }
                return { windowStart: ws + 60_000 > now ? ws : now, attempts: att + 1 };
            });
            if (blocked)
                throw new ApiError(429, 'Demasiados intentos. Espera un minuto.');
        }
        const email = text(req.body['email'], 'El correo', 254).toLowerCase();
        const password = text(req.body['password'], 'La contraseña', 128);
        const resp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(process.env['FIREBASE_WEB_API_KEY'])}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
        if (!resp.ok)
            throw new ApiError(401, 'Correo o contraseña incorrectos.');
        const creds = record(await resp.json());
        const uid = String(creds['localId'] ?? '');
        const indexSnap = await storeRef(`userIndexByEmail/${encodeURIComponent(email)}`).get();
        const index = record(indexSnap.val());
        if (!uid || index['uid'] !== uid || typeof index['schoolId'] !== 'string')
            throw new ApiError(401, 'Correo o contraseña incorrectos.');
        const profileSnap = await storeRef(`schools/${index['schoolId']}/users/${uid}`).get();
        const profile = record(profileSnap.val());
        if (profile['active'] !== true || profile['email'] !== email)
            throw new ApiError(401, 'Correo o contraseña incorrectos.');
        await sendLoginOtp(uid, email, profile);
        res.json({ otpSent: true, userId: uid, email });
    }
    catch (e) {
        if (e instanceof ApiError) {
            res.status(e.status).json({ error: e.message });
            return;
        }
        res.status(500).json({ error: 'Error interno.' });
    }
});
// POST /auth/google-login  (cliente ya hizo signInWithPopup, manda el idToken)
authRouter.post('/google-login', async (req, res) => {
    try {
        const idToken = text(req.body['idToken'], 'El token', 4096);
        const decoded = await auth.verifyIdToken(idToken);
        const uid = decoded.uid;
        const account = await auth.getUser(uid);
        if (account.disabled || !account.email || !account.providerData.some(p => p.providerId === 'google.com'))
            throw new ApiError(403, 'Usa una cuenta de Google verificada autorizada por tu colegio.');
        const index = record((await storeRef(`uidIndex/${uid}`).get()).val());
        const schoolId = String(index['schoolId'] ?? '');
        if (!schoolId)
            throw new ApiError(403, 'Esta cuenta no está registrada en el sistema escolar.');
        const profile = record((await storeRef(`schools/${schoolId}/users/${uid}`).get()).val());
        if (profile['active'] !== true || String(profile['email'] ?? '').toLowerCase() !== account.email.toLowerCase())
            throw new ApiError(403, 'Esta cuenta no está registrada en el sistema escolar.');
        await sendLoginOtp(uid, account.email, profile);
        res.json({ otpSent: true, userId: uid, email: account.email });
    }
    catch (e) {
        if (e instanceof ApiError) {
            res.status(e.status).json({ error: e.message });
            return;
        }
        res.status(500).json({ error: 'Error interno.' });
    }
});
// POST /auth/verify-otp
authRouter.post('/verify-otp', async (req, res) => {
    try {
        const ip = req.ip ?? '';
        if (ip) {
            const key = createHash('sha256').update(ip).digest('hex');
            let blocked = false;
            const now = Date.now();
            await storeRef(`otpIpLimits/${key}`).transaction((cur) => {
                const c = record(cur);
                const ws = Number(c['windowStart'] ?? 0);
                const cnt = ws + 60_000 > now ? Number(c['attempts'] ?? 0) : 0;
                if (cnt >= 30) {
                    blocked = true;
                    return;
                }
                return { windowStart: ws + 60_000 > now ? ws : now, attempts: cnt + 1 };
            });
            if (blocked)
                throw new ApiError(429, 'Demasiados intentos. Espera un minuto.');
        }
        const uid = text(req.body['userId'], 'La cuenta', 128);
        const code = text(req.body['code'], 'El código', 6);
        const codeHash = createHash('sha256').update(`${uid}:${code}`).digest('hex');
        const result = await storeRef(`loginOtps/${uid}`).transaction((cur) => {
            const otp = record(cur);
            if (typeof otp['codeHash'] !== 'string' || otp['locked'] === true || Number(otp['expiresAt']) <= Date.now())
                return;
            if (otp['codeHash'] === codeHash)
                return null;
            const att = Number(otp['attempts'] ?? 0) + 1;
            return { ...otp, attempts: att, locked: att >= 5 };
        });
        if (!result.committed || result.snapshot.exists())
            throw new ApiError(401, 'Código incorrecto, expirado o ya utilizado.');
        const index = record((await storeRef(`uidIndex/${uid}`).get()).val());
        const schoolId = String(index['schoolId'] ?? '');
        if (!schoolId)
            throw new ApiError(403, 'La cuenta no está vinculada a un colegio.');
        const profile = record((await storeRef(`schools/${schoolId}/users/${uid}`).get()).val());
        const account = await auth.getUser(uid);
        if (profile['active'] !== true || account.disabled)
            throw new ApiError(403, 'La cuenta está desactivada.');
        const role = String(profile['role']);
        if (!['ADMIN', 'TEACHER', 'PARENT', 'STUDENT'].includes(role))
            throw new ApiError(403, 'Rol no válido.');
        const schoolNameSnap = await storeRef(`schools/${schoolId}/name`).get();
        const customToken = await auth.createCustomToken(uid, {
            otpVerified: true, schoolId, role,
            schoolName: String(schoolNameSnap.val() ?? process.env['SCHOOL_NAME'] ?? 'Colegio'),
        });
        res.json({ customToken });
    }
    catch (e) {
        if (e instanceof ApiError) {
            res.status(e.status).json({ error: e.message });
            return;
        }
        res.status(500).json({ error: 'Error interno.' });
    }
});
// POST /auth/request-reset
authRouter.post('/request-reset', async (req, res) => {
    try {
        const ip = req.ip ?? '';
        if (ip) {
            const key = createHash('sha256').update(ip).digest('hex');
            let blocked = false;
            const now = Date.now();
            await storeRef(`resetIpLimits/${key}`).transaction((cur) => {
                const c = record(cur);
                const ws = Number(c['windowStart'] ?? 0);
                const att = ws + 60_000 > now ? Number(c['attempts'] ?? 0) : 0;
                if (att >= 5) {
                    blocked = true;
                    return;
                }
                return { windowStart: ws + 60_000 > now ? ws : now, attempts: att + 1 };
            });
            if (blocked)
                throw new ApiError(429, 'Demasiadas solicitudes. Intenta más tarde.');
        }
        const email = text(req.body['email'], 'El correo', 254).toLowerCase();
        try {
            const account = await auth.getUserByEmail(email);
            const index = record((await storeRef(`uidIndex/${account.uid}`).get()).val());
            const schoolId = String(index['schoolId'] ?? '');
            const profile = record((await storeRef(`schools/${schoolId}/users/${account.uid}`).get()).val());
            if (profile['active'] !== true) {
                res.json({ message: 'Si la cuenta existe, recibirás un enlace.' });
                return;
            }
            const origin = process.env['WEB_ORIGIN'] ?? 'http://localhost:4200';
            const firebaseLink = await auth.generatePasswordResetLink(email, { url: origin, handleCodeInApp: false });
            const oobCode = new URL(firebaseLink).searchParams.get('oobCode') ?? '';
            const resetUrl = `${origin}/reset-password?oobCode=${encodeURIComponent(oobCode)}`;
            await sendEmail(email, 'Restablece tu contraseña – Aula', emailHtml('Restablecer contraseña', `<p>Hola <strong>${escapeHtml(String(profile['name'] ?? ''))}</strong>,</p><p>Solicitaste restablecer tu contraseña.</p><p style="text-align:center;margin:28px"><a href="${escapeHtml(resetUrl)}" style="background:#2A7BE4;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold">Crear nueva contraseña</a></p><p>Si no solicitaste este cambio, ignora este mensaje.</p>`), `Restablece tu contraseña: ${resetUrl}`);
        }
        catch (err) {
            if (!(err instanceof Error && 'code' in err && err.code === 'auth/user-not-found'))
                throw err;
        }
        res.json({ message: 'Si la cuenta existe, recibirás un enlace para restablecer la contraseña.' });
    }
    catch (e) {
        if (e instanceof ApiError) {
            res.status(e.status).json({ error: e.message });
            return;
        }
        res.status(500).json({ error: 'Error interno.' });
    }
});
