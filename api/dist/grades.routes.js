import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { ApiError, record, storeRef, text, optionalText, list, byId } from './utils.js';
import { requireAuth, getUser, requireRole } from './middleware.js';
export const gradesRouter = Router();
gradesRouter.use(requireAuth);
function studentsInScope(user, studentRows, groupsById) {
    return studentRows.filter(s => {
        if (user.role === 'PARENT' || user.role === 'STUDENT')
            return s['parentUserId'] === user.uid;
        if (user.role === 'TEACHER')
            return groupsById.get(String(s['groupId']))?.['teacherId'] === user.uid;
        return true;
    });
}
async function loadGradeData(user) {
    const root = storeRef(`schools/${user.schoolId}`);
    const [stuSnap, grpSnap, subSnap, gradeSnap, usrSnap] = await Promise.all([
        root.child('students').get(), root.child('groups').get(),
        root.child('subjects').get(), root.child('grades').get(), root.child('users').get(),
    ]);
    return {
        root,
        studentRows: list(stuSnap), groupRows: list(grpSnap),
        subjectRows: list(subSnap), gradeRows: list(gradeSnap), userRows: list(usrSnap),
    };
}
// GET /grades
gradesRouter.get('/', async (req, res) => {
    try {
        const user = getUser(req);
        const { studentRows, groupRows, subjectRows, gradeRows, userRows } = await loadGradeData(user);
        const groupsById = byId(groupRows);
        const studentsById = byId(studentRows);
        const scoped = studentsInScope(user, studentRows, groupsById);
        const reqGroup = String(req.query['groupId'] ?? '');
        const reqPeriod = String(req.query['period'] ?? '');
        const reqStudent = String(req.query['studentId'] ?? '');
        res.json(gradeRows.filter(g => {
            const s = studentsById.get(String(g['studentId']));
            return s && (!reqStudent || g['studentId'] === reqStudent) &&
                (!reqGroup || s['groupId'] === reqGroup) &&
                (!reqPeriod || g['period'] === reqPeriod) &&
                (user.role !== 'TEACHER' || g['teacherId'] === user.uid) &&
                scoped.some(c => c['id'] === s['id']);
        }).map(g => ({
            ...g,
            studentName: studentsById.get(String(g['studentId']))?.['name'] ?? '',
            registrationNumber: studentsById.get(String(g['studentId']))?.['registrationNumber'] ?? '',
            subjectName: byId(subjectRows).get(String(g['subjectId']))?.['name'] ?? '',
            teacherName: byId(userRows).get(String(g['teacherId']))?.['name'] ?? '',
        })));
    }
    catch (e) {
        if (e instanceof ApiError) {
            res.status(e.status).json({ error: e.message });
            return;
        }
        res.status(500).json({ error: 'Error interno.' });
    }
});
// POST /grades
gradesRouter.post('/', async (req, res) => {
    try {
        const user = getUser(req);
        requireRole(user, 'ADMIN', 'TEACHER');
        const { root, studentRows, groupRows, subjectRows, gradeRows } = await loadGradeData(user);
        const groupsById = byId(groupRows);
        const studentsById = byId(studentRows);
        const data = record(req.body);
        const studentId = text(data['studentId'], 'El estudiante', 128);
        const student = studentsById.get(studentId);
        if (!student)
            throw new ApiError(404, 'No se encontró el estudiante.');
        if (user.role === 'TEACHER' && groupsById.get(String(student['groupId']))?.['teacherId'] !== user.uid)
            throw new ApiError(403, 'El estudiante no pertenece a tus grupos.');
        const subjectId = text(data['subjectId'], 'La materia', 128);
        if (!subjectRows.some(s => s['id'] === subjectId))
            throw new ApiError(404, 'No se encontró la materia.');
        const period = text(data['period'], 'El periodo', 10);
        if (!['Q1', 'Q2', 'Q3', 'Q4', 'FINAL'].includes(period))
            throw new ApiError(400, 'El periodo no es válido.');
        const config = record((await root.child('config').get()).val());
        const scale = Number(config['gradingScale'] ?? 10);
        const value = Number(data['value']);
        if (!Number.isFinite(value) || value < 0 || value > scale)
            throw new ApiError(400, `La calificación debe estar entre 0 y ${scale}.`);
        if (gradeRows.some(g => g['studentId'] === studentId && g['subjectId'] === subjectId && g['period'] === period))
            throw new ApiError(409, 'Ya existe una calificación para este alumno, materia y periodo.');
        const id = randomUUID();
        const grade = { id, schoolId: user.schoolId, studentId, subjectId, teacherId: user.uid, period, value, notes: optionalText(data['notes'], 500), createdAt: new Date().toISOString() };
        await root.child(`grades/${id}`).set(grade);
        res.json(grade);
    }
    catch (e) {
        if (e instanceof ApiError) {
            res.status(e.status).json({ error: e.message });
            return;
        }
        res.status(500).json({ error: 'Error interno.' });
    }
});
// PATCH /grades/:id
gradesRouter.patch('/:id', async (req, res) => {
    try {
        const user = getUser(req);
        requireRole(user, 'ADMIN', 'TEACHER');
        const { root, studentRows, groupRows, gradeRows } = await loadGradeData(user);
        const groupsById = byId(groupRows);
        const studentsById = byId(studentRows);
        const id = req.params['id'];
        const grade = gradeRows.find(g => g['id'] === id);
        if (!grade)
            throw new ApiError(404, 'No se encontró la calificación.');
        const student = studentsById.get(String(grade['studentId']));
        if (!student)
            throw new ApiError(404, 'No se encontró el estudiante.');
        if (user.role === 'TEACHER' && groupsById.get(String(student['groupId']))?.['teacherId'] !== user.uid)
            throw new ApiError(403, 'El estudiante no pertenece a tus grupos.');
        if (user.role === 'TEACHER' && grade['teacherId'] !== user.uid)
            throw new ApiError(403, 'Solo puedes editar calificaciones que tú registraste.');
        const config = record((await root.child('config').get()).val());
        const scale = Number(config['gradingScale'] ?? 10);
        const value = Number(req.body['value'] ?? grade['value']);
        if (!Number.isFinite(value) || value < 0 || value > scale)
            throw new ApiError(400, `La calificación debe estar entre 0 y ${scale}.`);
        const updated = { ...grade, value, notes: req.body['notes'] === undefined ? grade['notes'] : optionalText(req.body['notes'], 500) };
        await root.child(`grades/${id}`).set(updated);
        res.json(updated);
    }
    catch (e) {
        if (e instanceof ApiError) {
            res.status(e.status).json({ error: e.message });
            return;
        }
        res.status(500).json({ error: 'Error interno.' });
    }
});
// DELETE /grades/:id
gradesRouter.delete('/:id', async (req, res) => {
    try {
        const user = getUser(req);
        requireRole(user, 'ADMIN', 'TEACHER');
        const { root, studentRows, groupRows, gradeRows } = await loadGradeData(user);
        const groupsById = byId(groupRows);
        const studentsById = byId(studentRows);
        const id = req.params['id'];
        const grade = gradeRows.find(g => g['id'] === id);
        if (!grade)
            throw new ApiError(404, 'No se encontró la calificación.');
        const student = studentsById.get(String(grade['studentId']));
        if (!student)
            throw new ApiError(404, 'No se encontró el estudiante.');
        if (user.role === 'TEACHER' && groupsById.get(String(student['groupId']))?.['teacherId'] !== user.uid)
            throw new ApiError(403, 'El estudiante no pertenece a tus grupos.');
        if (user.role === 'TEACHER' && grade['teacherId'] !== user.uid)
            throw new ApiError(403, 'Solo puedes eliminar calificaciones que tú registraste.');
        await root.child(`grades/${id}`).remove();
        res.json(null);
    }
    catch (e) {
        if (e instanceof ApiError) {
            res.status(e.status).json({ error: e.message });
            return;
        }
        res.status(500).json({ error: 'Error interno.' });
    }
});
// POST /grades/bulk
gradesRouter.post('/bulk', async (req, res) => {
    try {
        const user = getUser(req);
        requireRole(user, 'ADMIN', 'TEACHER');
        const { root, studentRows, groupRows, subjectRows, gradeRows } = await loadGradeData(user);
        const groupsById = byId(groupRows);
        const studentsById = byId(studentRows);
        const groupId = text(req.body['groupId'], 'El grupo', 128);
        if (user.role === 'TEACHER' && groupsById.get(groupId)?.['teacherId'] !== user.uid)
            throw new ApiError(403, 'No tienes permiso sobre este grupo.');
        const subjectId = text(req.body['subjectId'], 'La materia', 128);
        if (!subjectRows.some(s => s['id'] === subjectId))
            throw new ApiError(404, 'No se encontró la materia.');
        const period = text(req.body['period'], 'El periodo', 10);
        if (!['Q1', 'Q2', 'Q3', 'Q4', 'FINAL'].includes(period))
            throw new ApiError(400, 'El periodo no es válido.');
        const entries = req.body['grades'];
        if (!Array.isArray(entries) || !entries.length)
            throw new ApiError(400, 'No hay calificaciones para guardar.');
        const config = record((await root.child('config').get()).val());
        const scale = Number(config['gradingScale'] ?? 10);
        const results = [];
        for (const raw of entries) {
            const entry = record(raw);
            const studentId = text(entry['studentId'], 'El estudiante', 128);
            const student = studentsById.get(studentId);
            if (!student)
                throw new ApiError(404, 'No se encontró el estudiante.');
            if (student['groupId'] !== groupId)
                throw new ApiError(400, 'Hay estudiantes fuera del grupo seleccionado.');
            const value = Number(entry['value']);
            if (!Number.isFinite(value) || value < 0 || value > scale)
                throw new ApiError(400, `La calificación debe estar entre 0 y ${scale}.`);
            const existing = gradeRows.find(g => g['studentId'] === studentId && g['subjectId'] === subjectId && g['period'] === period);
            const key = existing?.['id'] ?? randomUUID();
            const grade = { id: key, schoolId: user.schoolId, studentId, subjectId, teacherId: user.uid, period, value, notes: null, createdAt: new Date().toISOString() };
            await root.child(`grades/${key}`).set(grade);
            results.push({ id: key, studentId, value, period });
        }
        res.json({ saved: results.length, grades: results });
    }
    catch (e) {
        if (e instanceof ApiError) {
            res.status(e.status).json({ error: e.message });
            return;
        }
        res.status(500).json({ error: 'Error interno.' });
    }
});
