import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { ApiError, record, storeRef, text, optionalText, list, byId, sortBy, escapeHtml, emailHtml, sendEmail, type Values } from './utils.js';
import { requireAuth, getUser, requireRole, type UserContext } from './middleware.js';

export const extRouter = Router();
extRouter.use(requireAuth);

function studentsInScope(user: UserContext, studentRows: Values[], groupsById: Map<string, Values>) {
  return studentRows.filter(s => {
    if (user.role === 'PARENT' || user.role === 'STUDENT') return s['parentUserId'] === user.uid;
    if (user.role === 'TEACHER') return groupsById.get(String(s['groupId']))?.['teacherId'] === user.uid;
    return true;
  });
}

// ── Reports ──────────────────────────────────────────────────────────────────

// GET /ext/reports
extRouter.get('/reports', async (req, res) => {
  try {
    const user = getUser(req);
    const root = storeRef(`schools/${user.schoolId}`);
    const [repSnap, grpSnap, stuSnap, usrSnap] = await Promise.all([root.child('reports').get(), root.child('groups').get(), root.child('students').get(), root.child('users').get()]);
    const reportRows = list(repSnap); const groupRows = list(grpSnap); const studentRows = list(stuSnap); const userRows = list(usrSnap);
    const groupsById = byId(groupRows); const usersById = byId(userRows);
    const scoped = studentsInScope(user, studentRows, groupsById);
    res.json(reportRows.filter(r =>
      (user.role === 'ADMIN' || user.role === 'PARENT' || r['teacherId'] === user.uid || (user.role === 'TEACHER' && groupsById.get(String(r['groupId']))?.['teacherId'] === user.uid)) &&
      (user.role !== 'PARENT' || scoped.some(s => s['groupId'] === r['groupId'])) &&
      (!req.query['groupId'] || r['groupId'] === req.query['groupId'])
    ).map(r => ({ ...r, teacherName: usersById.get(String(r['teacherId']))?.['name'] ?? user.name, groupName: groupsById.get(String(r['groupId']))?.['name'] ?? null, groupGrade: groupsById.get(String(r['groupId']))?.['grade'] ?? null })));
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// POST /ext/reports
extRouter.post('/reports', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN', 'TEACHER');
    const root = storeRef(`schools/${user.schoolId}`);
    const groupRows = list(await root.child('groups').get());
    const groupsById = byId(groupRows);
    const data = record(req.body);
    const groupId = data['groupId'] || null;
    if (groupId && !groupsById.has(String(groupId))) throw new ApiError(404, 'No se encontró el grupo.');
    if (groupId && user.role === 'TEACHER' && groupsById.get(String(groupId))?.['teacherId'] !== user.uid) throw new ApiError(403, 'No tienes permiso sobre este grupo.');
    const now = new Date().toISOString();
    const id = randomUUID();
    const report = { id, schoolId: user.schoolId, teacherId: user.uid, groupId, title: text(data['title'], 'El título', 120), body: text(data['body'], 'El texto', 5000), createdAt: now, updatedAt: now };
    await root.child(`reports/${id}`).set(report);
    res.json({ ...report, teacherName: user.name, groupName: groupsById.get(String(groupId))?.['name'] ?? null, groupGrade: groupsById.get(String(groupId))?.['grade'] ?? null });
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// PATCH /ext/reports/:id
extRouter.patch('/reports/:id', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN', 'TEACHER');
    const root = storeRef(`schools/${user.schoolId}`);
    const groupRows = list(await root.child('groups').get());
    const groupsById = byId(groupRows);
    const id = req.params['id']!;
    const old = record((await root.child(`reports/${id}`).get()).val());
    if (!old['id']) throw new ApiError(404, 'No se encontró el reporte.');
    if (user.role === 'TEACHER' && old['teacherId'] !== user.uid) throw new ApiError(403, 'No puedes modificar este reporte.');
    const data = record(req.body);
    const updated: Values = { ...old, title: data['title'] === undefined ? old['title'] : text(data['title'], 'El título', 120), body: data['body'] === undefined ? old['body'] : text(data['body'], 'El texto', 5000), updatedAt: new Date().toISOString() };
    await root.child(`reports/${id}`).set(updated);
    res.json({ ...updated, teacherName: user.name, groupName: groupsById.get(String(updated['groupId']))?.['name'] ?? null, groupGrade: groupsById.get(String(updated['groupId']))?.['grade'] ?? null });
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// DELETE /ext/reports/:id
extRouter.delete('/reports/:id', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN', 'TEACHER');
    const root = storeRef(`schools/${user.schoolId}`);
    const id = req.params['id']!;
    const old = record((await root.child(`reports/${id}`).get()).val());
    if (!old['id']) throw new ApiError(404, 'No se encontró el reporte.');
    if (user.role === 'TEACHER' && old['teacherId'] !== user.uid) throw new ApiError(403, 'No puedes modificar este reporte.');
    await root.child(`reports/${id}`).remove();
    res.json(null);
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// ── Cycles ───────────────────────────────────────────────────────────────────

extRouter.get('/cycles', async (req, res) => {
  try {
    const user = getUser(req);
    const root = storeRef(`schools/${user.schoolId}`);
    const rows = list(await root.child('cycles').get());
    res.json(sortBy(rows, 'startDate').reverse());
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

extRouter.post('/cycles', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN');
    const root = storeRef(`schools/${user.schoolId}`);
    const rows = list(await root.child('cycles').get());
    const data = record(req.body);
    const name = text(data['name'], 'El nombre', 40);
    if (rows.some(c => c['name'] === name)) throw new ApiError(409, 'Ya existe un ciclo con ese nombre.');
    const id = randomUUID();
    const cycle = { id, name, startDate: data['startDate'], endDate: data['endDate'], active: data['active'] ?? false };
    if (typeof cycle['startDate'] !== 'string' || typeof cycle['endDate'] !== 'string' || isNaN(Date.parse(String(cycle['startDate']))) || isNaN(Date.parse(String(cycle['endDate']))) || Date.parse(String(cycle['endDate'])) < Date.parse(String(cycle['startDate']))) throw new ApiError(400, 'Las fechas del ciclo escolar no son válidas.');
    if (cycle['active']) {
      const updates: Record<string, unknown> = {};
      rows.forEach(c => { updates[`cycles/${c['id']}/active`] = false; });
      updates[`cycles/${id}`] = cycle;
      await root.update(updates);
    } else await root.child(`cycles/${id}`).set(cycle);
    res.json(cycle);
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

extRouter.patch('/cycles/:id', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN');
    const root = storeRef(`schools/${user.schoolId}`);
    const rows = list(await root.child('cycles').get());
    const id = req.params['id']!;
    const old = rows.find(c => c['id'] === id);
    if (!old) throw new ApiError(404, 'Ciclo no encontrado.');
    const data = record(req.body);
    const name = data['name'] === undefined ? String(old['name']) : text(data['name'], 'El nombre', 40);
    if (rows.some(c => c['name'] === name && c['id'] !== id)) throw new ApiError(409, 'Ya existe un ciclo con ese nombre.');
    const cycle = { ...old, name, startDate: data['startDate'] ?? old['startDate'], endDate: data['endDate'] ?? old['endDate'], active: data['active'] ?? old['active'] ?? false };
    if (typeof cycle['startDate'] !== 'string' || typeof cycle['endDate'] !== 'string' || isNaN(Date.parse(String(cycle['startDate']))) || isNaN(Date.parse(String(cycle['endDate']))) || Date.parse(String(cycle['endDate'])) < Date.parse(String(cycle['startDate']))) throw new ApiError(400, 'Las fechas del ciclo escolar no son válidas.');
    if (cycle['active']) {
      const updates: Record<string, unknown> = {};
      rows.forEach(c => { if (c['id'] !== id) updates[`cycles/${c['id']}/active`] = false; });
      updates[`cycles/${id}`] = cycle;
      await root.update(updates);
    } else await root.child(`cycles/${id}`).set(cycle);
    res.json(cycle);
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

extRouter.delete('/cycles/:id', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN');
    const root = storeRef(`schools/${user.schoolId}`);
    const id = req.params['id']!;
    const attRows = list(await root.child('attendance').get());
    if (attRows.some(a => a['cycleId'] === id)) throw new ApiError(400, 'El ciclo tiene asistencias registradas.');
    await root.child(`cycles/${id}`).remove();
    res.json(null);
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// ── Config ───────────────────────────────────────────────────────────────────

extRouter.get('/config', async (req, res) => {
  try {
    const user = getUser(req);
    const root = storeRef(`schools/${user.schoolId}`);
    const cfg = record((await root.child('config').get()).val());
    res.json({ levelType: cfg['levelType'] ?? 'PRIMARY', gradingScale: cfg['gradingScale'] ?? 10, periods: cfg['periods'] ?? 'Q1,Q2,Q3,Q4,FINAL', address: cfg['address'] ?? '', phone: cfg['phone'] ?? '', directorName: cfg['directorName'] ?? '' });
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

extRouter.put('/config', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN');
    const root = storeRef(`schools/${user.schoolId}`);
    const cur = record((await root.child('config').get()).val());
    const data = record(req.body);
    const cfg = { levelType: data['levelType'] ?? cur['levelType'] ?? 'PRIMARY', gradingScale: Number(data['gradingScale'] ?? cur['gradingScale'] ?? 10), periods: data['periods'] ?? cur['periods'] ?? 'Q1,Q2,Q3,Q4,FINAL', address: data['address'] ?? cur['address'] ?? '', phone: data['phone'] ?? cur['phone'] ?? '', directorName: data['directorName'] ?? cur['directorName'] ?? '' };
    if (!['PRIMARY','SECONDARY','BACHILLERATO'].includes(String(cfg.levelType)) || ![10,100].includes(cfg.gradingScale)) throw new ApiError(400, 'La configuración escolar no es válida.');
    await root.child('config').set(cfg);
    res.json(cfg);
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// ── Attendance ───────────────────────────────────────────────────────────────

extRouter.get('/attendance', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN', 'TEACHER');
    const root = storeRef(`schools/${user.schoolId}`);
    const [attSnap, stuSnap, grpSnap] = await Promise.all([root.child('attendance').get(), root.child('students').get(), root.child('groups').get()]);
    const attRows = list(attSnap); const studentRows = list(stuSnap); const groupRows = list(grpSnap);
    const studentsById = byId(studentRows); const groupsById = byId(groupRows);
    const cycleId = String(req.query['cycleId'] ?? ''); const groupId = String(req.query['groupId'] ?? '');
    res.json(attRows.filter(a => {
      const s = studentsById.get(String(a['studentId']));
      return s && (!cycleId || a['cycleId'] === cycleId) && (!req.query['date'] || a['date'] === req.query['date']) && (!req.query['studentId'] || a['studentId'] === req.query['studentId']) && (!groupId || s['groupId'] === groupId) && (user.role === 'ADMIN' || groupsById.get(String(s['groupId']))?.['teacherId'] === user.uid);
    }).map(a => ({ ...a, studentName: studentsById.get(String(a['studentId']))?.['name'] ?? '', registrationNumber: studentsById.get(String(a['studentId']))?.['registrationNumber'] ?? '', groupId: studentsById.get(String(a['studentId']))?.['groupId'] ?? '' })));
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

extRouter.get('/attendance/summary', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN', 'TEACHER');
    const root = storeRef(`schools/${user.schoolId}`);
    const [attSnap, stuSnap, grpSnap] = await Promise.all([root.child('attendance').get(), root.child('students').get(), root.child('groups').get()]);
    const attRows = list(attSnap); const studentRows = list(stuSnap); const groupRows = list(grpSnap);
    const groupsById = byId(groupRows);
    const cycleId = String(req.query['cycleId'] ?? ''); const groupId = String(req.query['groupId'] ?? '');
    const scoped = studentRows.filter(s => (!groupId || s['groupId'] === groupId) && (user.role === 'ADMIN' || groupsById.get(String(s['groupId']))?.['teacherId'] === user.uid));
    const counts = new Map<string, Record<string, number>>();
    for (const a of attRows.filter(a => a['cycleId'] === cycleId)) {
      const sid = String(a['studentId']);
      const m = counts.get(sid) ?? { PRESENT: 0, ABSENT: 0, LATE: 0, JUSTIFIED: 0 };
      const st = String(a['status']); m[st] = (m[st] ?? 0) + 1; counts.set(sid, m);
    }
    res.json(scoped.map(s => {
      const c = counts.get(String(s['id'])) ?? { PRESENT: 0, ABSENT: 0, LATE: 0, JUSTIFIED: 0 };
      const total = c['PRESENT'] + c['ABSENT'] + c['LATE'] + c['JUSTIFIED'];
      return { studentId: s['id'], studentName: s['name'], registrationNumber: s['registrationNumber'], groupId: s['groupId'], present: c['PRESENT'], absent: c['ABSENT'], late: c['LATE'], justified: c['JUSTIFIED'], total, attendanceRate: total ? Math.round(c['PRESENT'] / total * 100) : null };
    }));
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

extRouter.post('/attendance/bulk', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN', 'TEACHER');
    const root = storeRef(`schools/${user.schoolId}`);
    const [attSnap, stuSnap, grpSnap, cycSnap] = await Promise.all([root.child('attendance').get(), root.child('students').get(), root.child('groups').get(), root.child('cycles').get()]);
    const allAtt = list(attSnap); const studentRows = list(stuSnap); const groupRows = list(grpSnap); const cycleRows = list(cycSnap);
    const studentsById = byId(studentRows); const groupsById = byId(groupRows);
    const data = record(req.body);
    const cycleId = text(data['cycleId'], 'El ciclo', 128);
    if (!cycleRows.some(c => c['id'] === cycleId)) throw new ApiError(404, 'Ciclo no encontrado.');
    const date = text(data['date'], 'La fecha', 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'La fecha de asistencia no es válida.');
    const records = data['records'];
    if (!Array.isArray(records) || !records.length) throw new ApiError(400, 'No hay asistencias para guardar.');
    const scoped = new Set(studentsInScope(user, studentRows, groupsById).map(s => String(s['id'])));
    const updates: Record<string, unknown> = {};
    for (const raw of records) {
      const entry = record(raw);
      const studentId = text(entry['studentId'], 'El estudiante', 128);
      const student = studentsById.get(studentId);
      if (!student) throw new ApiError(404, 'No se encontró el estudiante.');
      if (user.role === 'TEACHER' && groupsById.get(String(student['groupId']))?.['teacherId'] !== user.uid) throw new ApiError(403, 'El estudiante no pertenece a tus grupos.');
      if (!scoped.has(studentId)) throw new ApiError(403, 'No puedes modificar asistencias fuera de tu alcance.');
      const id = `${studentId}_${date}`;
      if (updates[`attendance/${id}`] !== undefined) throw new ApiError(400, 'La lista contiene estudiantes repetidos.');
      const prev = allAtt.find(a => a['studentId'] === studentId && a['date'] === date);
      if (prev && prev['cycleId'] !== cycleId) throw new ApiError(400, 'El estudiante ya tiene asistencia para esta fecha en otro ciclo.');
      const status = text(entry['status'], 'El estado', 20);
      if (!['PRESENT','ABSENT','LATE','JUSTIFIED'].includes(status)) throw new ApiError(400, 'El estado de asistencia no es válido.');
      updates[`attendance/${id}`] = { id, schoolId: user.schoolId, studentId, cycleId, date, status, notes: optionalText(entry['notes'], 300) };
    }
    await root.update(updates);
    res.json({ saved: Object.keys(updates).length });
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// ── Mail ─────────────────────────────────────────────────────────────────────

extRouter.post('/send-communique', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN', 'TEACHER');
    const root = storeRef(`schools/${user.schoolId}`);
    const [stuSnap, grpSnap, usrSnap] = await Promise.all([root.child('students').get(), root.child('groups').get(), root.child('users').get()]);
    const studentRows = list(stuSnap); const groupRows = list(grpSnap); const userRows = list(usrSnap);
    const groupsById = byId(groupRows);
    const groupId = String(req.body['groupId'] ?? '');
    if (groupId && user.role === 'TEACHER' && groupsById.get(groupId)?.['teacherId'] !== user.uid) throw new ApiError(403, 'No tienes permiso sobre ese grupo.');
    const scoped = studentsInScope(user, studentRows, groupsById);
    const parents = new Set(scoped.filter(s => !groupId || s['groupId'] === groupId).map(s => String(s['parentUserId'] ?? '')).filter(Boolean));
    const recipients = userRows.filter(u => parents.has(String(u['id'])) && u['role'] === 'PARENT' && u['active'] === true);
    if (!recipients.length) throw new ApiError(400, 'No hay padres activos vinculados al grupo seleccionado.');
    const subject = text(req.body['subject'], 'El asunto', 200);
    const body = text(req.body['body'], 'El mensaje', 3000);
    for (const r of recipients) {
      await sendEmail(text(r['email'], 'El correo', 254), subject, emailHtml(subject, `<div>${escapeHtml(body).split('\n').map(l => `<p>${l}</p>`).join('')}</div><p>— ${escapeHtml(user.name)}</p>`), body);
    }
    res.json({ sent: recipients.length });
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

extRouter.post('/send-boleta', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN', 'TEACHER', 'PARENT');
    const root = storeRef(`schools/${user.schoolId}`);
    const [stuSnap, grpSnap, subSnap, gradeSnap, usrSnap] = await Promise.all([root.child('students').get(), root.child('groups').get(), root.child('subjects').get(), root.child('grades').get(), root.child('users').get()]);
    const studentRows = list(stuSnap); const groupRows = list(grpSnap); const subjectRows = list(subSnap); const gradeRows = list(gradeSnap); const userRows = list(usrSnap);
    const studentsById = byId(studentRows); const groupsById = byId(groupRows);
    const studentId = text(req.body['studentId'], 'El estudiante', 128);
    const student = studentsById.get(studentId);
    if (!student) throw new ApiError(404, 'No se encontró el estudiante.');
    const group = groupsById.get(String(student['groupId']));
    if (user.role === 'PARENT' && student['parentUserId'] !== user.uid) throw new ApiError(404, 'No se encontró el estudiante.');
    if (user.role === 'TEACHER' && group?.['teacherId'] !== user.uid) throw new ApiError(404, 'No se encontró el estudiante.');
    const parent = userRows.find(u => u['id'] === student['parentUserId'] && u['role'] === 'PARENT' && u['active'] === true);
    if (!parent) throw new ApiError(400, 'El estudiante no tiene un padre activo vinculado.');
    const period = String(req.body['period'] ?? '');
    const grades = gradeRows.filter(g => g['studentId'] === studentId && (!period || g['period'] === period));
    if (!grades.length) throw new ApiError(400, 'No hay calificaciones para incluir en la boleta.');
    const subjectsById = byId(subjectRows);
    const rows = grades.map(g => ({ subject: `${String(subjectsById.get(String(g['subjectId']))?.['name'] ?? 'Materia')}${period ? '' : ` (${g['period']})`}`, value: Number(g['value']), notes: String(g['notes'] ?? '') }));
    const name = text(student['name'], 'El estudiante', 120);
    const periodLabel = period || 'Todos los periodos';
    const average = (rows.reduce((t, g) => t + g.value, 0) / rows.length).toFixed(2);
    const table = rows.map(g => `<tr><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(g.subject)}</td><td style="padding:8px;text-align:center;border-bottom:1px solid #eee">${g.value}</td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(g.notes)}</td></tr>`).join('');
    await sendEmail(text(parent['email'], 'El correo del tutor', 254), `Boleta de calificaciones – ${name} – ${periodLabel}`, emailHtml(`Boleta: ${name}`, `<p>Hola ${escapeHtml(String(parent['name'] ?? ''))},</p><p>Calificaciones de <strong>${escapeHtml(name)}</strong>, periodo <strong>${escapeHtml(periodLabel)}</strong>:</p><table style="width:100%;border-collapse:collapse"><tr><th>Materia</th><th>Calificación</th><th>Notas</th></tr>${table}</table><p>Promedio: <strong>${average}</strong></p>`), `Boleta de ${name}, ${periodLabel}. Promedio: ${average}`);
    res.json({ sent: true });
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});
