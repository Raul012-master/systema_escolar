import { Router } from 'express';
import { randomInt, randomUUID } from 'node:crypto';
import { auth } from './firebase.js';
import { ApiError, record, storeRef, text, optionalText, list, byId, sortBy, type Values } from './utils.js';
import { requireAuth, getUser, requireRole, type UserContext } from './middleware.js';

export const schoolRouter = Router();
schoolRouter.use(requireAuth);

type Role = 'ADMIN' | 'TEACHER' | 'PARENT' | 'STUDENT';

async function loadAll(user: UserContext) {
  const root = storeRef(`schools/${user.schoolId}`);
  const [stuSnap, grpSnap, subSnap, gradeSnap, repSnap, cycSnap, usrSnap] = await Promise.all([
    root.child('students').get(), root.child('groups').get(), root.child('subjects').get(),
    root.child('grades').get(), root.child('reports').get(), root.child('cycles').get(),
    root.child('users').get(),
  ]);
  return {
    root,
    studentRows: list(stuSnap), groupRows: list(grpSnap), subjectRows: list(subSnap),
    gradeRows: list(gradeSnap), reportRows: list(repSnap), cycleRows: list(cycSnap),
    userRows: list(usrSnap),
  };
}

function studentsInScope(user: UserContext, studentRows: Values[], groupsById: Map<string, Values>) {
  return studentRows.filter(s => {
    if (user.role === 'PARENT' || user.role === 'STUDENT') return s['parentUserId'] === user.uid;
    if (user.role === 'TEACHER') return groupsById.get(String(s['groupId']))?.['teacherId'] === user.uid;
    return true;
  });
}

function groupDto(g: Values, userRows: Values[], studentRows: Values[]) {
  return { ...g, teacher: byId(userRows).get(String(g['teacherId']))?.['name'] ?? null, students: studentRows.filter(s => s['groupId'] === g['id']).length };
}

function studentDto(s: Values, groupsById: Map<string, Values>) {
  const g = groupsById.get(String(s['groupId']));
  return { ...s, group: String(g?.['name'] ?? ''), grade: String(g?.['grade'] ?? ''), parentUserId: s['parentUserId'] ?? null };
}

// GET /school/dashboard
schoolRouter.get('/dashboard', async (req, res) => {
  try {
    const user = getUser(req);
    const { studentRows, groupRows, gradeRows, userRows } = await loadAll(user);
    const groupsById = byId(groupRows);
    const scoped = studentsInScope(user, studentRows, groupsById);
    if (user.role === 'PARENT') {
      const children = scoped.map(s => {
        const g = groupsById.get(String(s['groupId']));
        const grades = gradeRows.filter(gr => gr['studentId'] === s['id']);
        const avg = grades.length ? Math.round(grades.reduce((a, gr) => a + Number(gr['value']), 0) / grades.length * 10) / 10 : null;
        return { id: s['id'], name: s['name'], registrationNumber: s['registrationNumber'], groupName: g?.['name'] ?? '', groupGrade: g?.['grade'] ?? '', status: s['status'], gradesCount: grades.length, average: avg };
      });
      res.json({ role: 'PARENT', children, totalChildren: children.length, students: children.length, pendingStudents: 0, groups: 0, users: 0, groupOccupancy: [] }); return;
    }
    if (user.role === 'STUDENT') {
      const s = scoped[0];
      const og = s ? gradeRows.filter(gr => gr['studentId'] === s['id']) : [];
      const avg = og.length ? Math.round(og.reduce((a, gr) => a + Number(gr['value']), 0) / og.length * 10) / 10 : null;
      res.json({ role: 'STUDENT', gradesCount: og.length, average: avg, students: 0, pendingStudents: 0, groups: 0, users: 0, groupOccupancy: [], children: [], totalChildren: 0 }); return;
    }
    const scopedGroups = groupRows.filter(g => user.role === 'ADMIN' || g['teacherId'] === user.uid);
    const visible = user.role === 'ADMIN' ? studentRows : scoped;
    const ownGrades = user.role === 'TEACHER' ? gradeRows.filter(gr => gr['teacherId'] === user.uid) : [];
    const avg = ownGrades.length ? Math.round(ownGrades.reduce((a, gr) => a + Number(gr['value']), 0) / ownGrades.length * 10) / 10 : null;
    res.json({
      role: user.role, students: visible.length, pendingStudents: visible.filter(s => s['status'] === 'PENDING').length,
      groups: scopedGroups.length, users: user.role === 'ADMIN' ? userRows.filter(u => u['active'] === true).length : 0,
      teacherGradeAvg: avg, children: [], totalChildren: 0,
      groupOccupancy: sortBy(scopedGroups, 'name').map(g => ({ id: g['id'], name: g['name'], grade: g['grade'], capacity: g['capacity'], students: studentRows.filter(s => s['groupId'] === g['id']).length })),
    });
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// GET /school/students
schoolRouter.get('/students', async (req, res) => {
  try {
    const user = getUser(req);
    const { studentRows, groupRows } = await loadAll(user);
    const groupsById = byId(groupRows);
    const query = String(req.query['search'] ?? '').trim().toLocaleLowerCase('es-MX');
    const scoped = studentsInScope(user, studentRows, groupsById);
    res.json(scoped.filter(s => !query || [s['name'], s['registrationNumber'], s['guardian'], groupsById.get(String(s['groupId']))?.['name'], groupsById.get(String(s['groupId']))?.['grade']].some(v => String(v ?? '').toLocaleLowerCase('es-MX').includes(query))).map(s => studentDto(s, groupsById)));
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// POST /school/students
schoolRouter.post('/students', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN');
    const { root, studentRows, groupRows } = await loadAll(user);
    const groupsById = byId(groupRows);
    const data = record(req.body);
    const id = randomUUID();
    const groupId = text(data['groupId'], 'El grupo', 128);
    const group = groupsById.get(groupId);
    if (!group) throw new ApiError(404, 'No se encontró el grupo.');
    if (studentRows.filter(s => s['groupId'] === groupId).length >= Number(group['capacity'])) throw new ApiError(400, 'El grupo llegó a su capacidad máxima.');
    const parentUserId = data['parentUserId'] ? String(data['parentUserId']) : null;
    if (parentUserId) {
      const parent = record((await root.child(`users/${parentUserId}`).get()).val());
      if (parent['role'] !== 'PARENT' || parent['active'] !== true) throw new ApiError(400, 'Selecciona una cuenta activa de padre o tutor.');
    }
    const registrationNumber = `AL-${randomInt(0, 0x100000000).toString(16).padStart(8, '0').toUpperCase()}`;
    const student = { id, schoolId: user.schoolId, registrationNumber, name: text(data['name'], 'El nombre', 120), guardian: text(data['guardian'], 'El tutor', 120), groupId, status: data['status'] ?? 'ENROLLED', parentUserId, createdAt: new Date().toISOString() };
    await root.child(`students/${id}`).set(student);
    res.json(studentDto(student, groupsById));
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// PATCH /school/students/:id
schoolRouter.patch('/students/:id', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN');
    const { root, studentRows, groupRows } = await loadAll(user);
    const groupsById = byId(groupRows);
    const id = req.params['id']!;
    const old = record((await root.child(`students/${id}`).get()).val());
    if (!old['id']) throw new ApiError(404, 'No se encontró el estudiante.');
    const data = record(req.body);
    const groupId = data['groupId'] === undefined ? String(old['groupId'] ?? '') : text(data['groupId'], 'El grupo', 128);
    const group = groupsById.get(groupId);
    if (!group) throw new ApiError(404, 'No se encontró el grupo.');
    if (studentRows.filter(s => s['groupId'] === groupId && s['id'] !== id).length >= Number(group['capacity'])) throw new ApiError(400, 'El grupo llegó a su capacidad máxima.');
    const parentUserId = data['parentUserId'] === null || data['parentUserId'] === '' ? null : String(data['parentUserId'] ?? old['parentUserId'] ?? '') || null;
    if (parentUserId) {
      const parent = record((await root.child(`users/${parentUserId}`).get()).val());
      if (parent['role'] !== 'PARENT' || parent['active'] !== true) throw new ApiError(400, 'Selecciona una cuenta activa de padre o tutor.');
    }
    const updated = { ...old, name: data['name'] === undefined ? old['name'] : text(data['name'], 'El nombre', 120), guardian: data['guardian'] === undefined ? old['guardian'] : text(data['guardian'], 'El tutor', 120), groupId, status: data['status'] ?? old['status'], parentUserId };
    await root.child(`students/${id}`).set(updated);
    res.json(studentDto(updated, groupsById));
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// DELETE /school/students/:id
schoolRouter.delete('/students/:id', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN');
    const { root, gradeRows } = await loadAll(user);
    const id = req.params['id']!;
    const old = record((await root.child(`students/${id}`).get()).val());
    if (!old['id']) throw new ApiError(404, 'No se encontró el estudiante.');
    const related: Record<string, null> = {};
    const attRows = list(await root.child('attendance').get());
    for (const g of gradeRows.filter(r => r['studentId'] === id)) related[`grades/${g['id']}`] = null;
    for (const a of attRows.filter(r => r['studentId'] === id)) related[`attendance/${a['id']}`] = null;
    await root.update({ [`students/${id}`]: null, ...related });
    res.json(null);
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// GET /school/groups
schoolRouter.get('/groups', async (req, res) => {
  try {
    const user = getUser(req);
    const { groupRows, userRows, studentRows } = await loadAll(user);
    res.json(sortBy(groupRows.filter(g => user.role === 'ADMIN' || g['teacherId'] === user.uid), 'name').map(g => groupDto(g, userRows, studentRows)));
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// POST /school/groups
schoolRouter.post('/groups', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN');
    const { root, studentRows, groupRows, userRows } = await loadAll(user);
    const data = record(req.body);
    const id = randomUUID();
    const capacity = Number(data['capacity']);
    if (!Number.isInteger(capacity) || capacity < 1) throw new ApiError(400, 'La capacidad debe ser un número positivo.');
    const teacherId = data['teacherId'] || null;
    if (teacherId) {
      const t = record((await root.child(`users/${teacherId}`).get()).val());
      if (t['role'] !== 'TEACHER' || t['active'] !== true) throw new ApiError(400, 'Selecciona un docente activo.');
    }
    const name = text(data['name'], 'El grupo', 80);
    if (groupRows.some(g => g['name'] === name)) throw new ApiError(409, 'Ya existe un grupo con ese nombre.');
    const group = { id, schoolId: user.schoolId, name, grade: text(data['grade'], 'El grado', 80), room: text(data['room'], 'El salón', 80), capacity, teacherId };
    await root.child(`groups/${id}`).set(group);
    res.json(groupDto(group, userRows, studentRows));
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// PATCH /school/groups/:id
schoolRouter.patch('/groups/:id', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN');
    const { root, studentRows, groupRows, userRows } = await loadAll(user);
    const id = req.params['id']!;
    const old = byId(groupRows).get(id);
    if (!old) throw new ApiError(404, 'No se encontró el grupo.');
    const data = record(req.body);
    const capacity = Number(data['capacity'] ?? old['capacity']);
    const studentCount = studentRows.filter(s => s['groupId'] === id).length;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity < studentCount) throw new ApiError(400, 'La capacidad debe cubrir a los alumnos inscritos.');
    const teacherId = data['teacherId'] !== undefined ? (data['teacherId'] || null) : old['teacherId'];
    if (teacherId) {
      const t = record((await root.child(`users/${teacherId}`).get()).val());
      if (t['role'] !== 'TEACHER' || t['active'] !== true) throw new ApiError(400, 'Selecciona un docente activo.');
    }
    const name = text(data['name'] ?? old['name'], 'El grupo', 80);
    if (groupRows.some(g => g['name'] === name && g['id'] !== id)) throw new ApiError(409, 'Ya existe un grupo con ese nombre.');
    const updated = { ...old, name, grade: text(data['grade'] ?? old['grade'], 'El grado', 80), room: text(data['room'] ?? old['room'], 'El salón', 80), capacity, teacherId };
    await root.child(`groups/${id}`).set(updated);
    res.json(groupDto(updated, userRows, studentRows));
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// DELETE /school/groups/:id
schoolRouter.delete('/groups/:id', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN');
    const { root, studentRows } = await loadAll(user);
    const id = req.params['id']!;
    if (studentRows.some(s => s['groupId'] === id)) throw new ApiError(400, 'No se puede eliminar un grupo con estudiantes inscritos.');
    await root.child(`groups/${id}`).remove();
    res.json(null);
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// GET /school/users
schoolRouter.get('/users', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN');
    const { userRows } = await loadAll(user);
    res.json(sortBy(userRows, 'name'));
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// POST /school/users
schoolRouter.post('/users', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN');
    const data = record(req.body);
    const email = text(data['email'], 'El correo', 254).toLowerCase();
    const password = text(data['password'], 'La contraseña', 128);
    const role = text(data['role'], 'El rol', 12) as Role;
    if (!['ADMIN', 'TEACHER', 'PARENT', 'STUDENT'].includes(role)) throw new ApiError(400, 'El rol no es válido.');
    if (record((await storeRef(`userIndexByEmail/${encodeURIComponent(email)}`).get()).val())['uid']) throw new ApiError(409, 'Ese correo ya está registrado.');
    const created = await auth.createUser({ email, password, displayName: text(data['name'], 'El nombre', 120) });
    const profile = { id: created.uid, schoolId: user.schoolId, name: created.displayName, email, role, active: true };
    try {
      await storeRef().update({
        [`schools/${user.schoolId}/users/${created.uid}`]: profile,
        [`userIndexByEmail/${encodeURIComponent(email)}`]: { uid: created.uid, schoolId: user.schoolId },
        [`uidIndex/${created.uid}`]: { schoolId: user.schoolId },
      });
    } catch (err) { await auth.deleteUser(created.uid); throw err; }
    res.json(profile);
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// PATCH /school/users/:id
schoolRouter.patch('/users/:id', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN');
    const { root, userRows } = await loadAll(user);
    const id = req.params['id']!;
    const snap = await root.child(`users/${id}`).get();
    if (!snap.exists()) throw new ApiError(404, 'No se encontró el usuario.');
    const old = record(snap.val());
    const updates = record(req.body);
    const data: Values = {};
    if (typeof updates['active'] === 'boolean') data['active'] = updates['active'];
    if (typeof updates['name'] === 'string') data['name'] = text(updates['name'], 'El nombre', 120);
    if (typeof updates['email'] === 'string') data['email'] = text(updates['email'], 'El correo', 254).toLowerCase();
    if (typeof updates['role'] === 'string') {
      if (!['ADMIN', 'TEACHER', 'PARENT', 'STUDENT'].includes(updates['role'])) throw new ApiError(400, 'El rol no es válido.');
      data['role'] = updates['role'];
    }
    if (id === user.uid && data['active'] === false) throw new ApiError(400, 'No puedes desactivar tu propia cuenta.');
    if (old['role'] === 'ADMIN' && old['active'] === true && (data['role'] !== undefined && data['role'] !== 'ADMIN' || data['active'] === false)) {
      if (userRows.filter(u => u['role'] === 'ADMIN' && u['active'] === true).length <= 1) throw new ApiError(400, 'El colegio debe conservar al menos un administrador activo.');
    }
    const oldEmail = String(old['email']);
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
    await root.child(`users/${id}`).update(data);
    res.json({ ...old, ...data });
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// DELETE /school/users/:id
schoolRouter.delete('/users/:id', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN');
    const { root, userRows } = await loadAll(user);
    const id = req.params['id']!;
    if (id === user.uid) throw new ApiError(400, 'No puedes eliminar tu propia cuenta.');
    const profile = record((await root.child(`users/${id}`).get()).val());
    if (!profile['email']) throw new ApiError(404, 'No se encontró el usuario.');
    if (profile['role'] === 'ADMIN' && profile['active'] === true && userRows.filter(u => u['role'] === 'ADMIN' && u['active'] === true).length <= 1) throw new ApiError(400, 'El colegio debe conservar al menos un administrador activo.');
    await auth.deleteUser(id);
    await root.child(`users/${id}`).remove();
    await storeRef(`uidIndex/${id}`).remove();
    await storeRef(`userIndexByEmail/${encodeURIComponent(String(profile['email']))}`).remove();
    res.json(null);
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// GET /school/subjects
schoolRouter.get('/subjects', async (req, res) => {
  try {
    const user = getUser(req);
    const { subjectRows } = await loadAll(user);
    res.json(sortBy(subjectRows, 'name'));
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// POST /school/subjects
schoolRouter.post('/subjects', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN');
    const { root, subjectRows } = await loadAll(user);
    const name = text(req.body['name'], 'La materia', 80);
    if (subjectRows.some(s => s['name'] === name)) throw new ApiError(409, 'Ya existe esa materia.');
    const id = randomUUID();
    const subject = { id, name, schoolId: user.schoolId };
    await root.child(`subjects/${id}`).set(subject);
    res.json(subject);
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});

// DELETE /school/subjects/:id
schoolRouter.delete('/subjects/:id', async (req, res) => {
  try {
    const user = getUser(req); requireRole(user, 'ADMIN');
    const { root, gradeRows } = await loadAll(user);
    const id = req.params['id']!;
    await root.child(`subjects/${id}`).remove();
    const updates: Record<string, null> = {};
    for (const g of gradeRows.filter(r => r['subjectId'] === id)) updates[`grades/${g['id']}`] = null;
    if (Object.keys(updates).length) await root.update(updates);
    res.json(null);
  } catch (e) { if (e instanceof ApiError) { res.status(e.status).json({ error: e.message }); return; } res.status(500).json({ error: 'Error interno.' }); }
});
