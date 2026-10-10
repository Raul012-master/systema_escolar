import { Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { API_URL } from './firebase';
import type {
  AcademicCycle, AttendanceRecord, AttendanceSummary, ChildSummary,
  DashboardSummary, Grade, GradePeriod, Report, SchoolConfig,
  SchoolGroup, SchoolRole, SchoolUser, Student, StudentStatus, Subject,
} from './school-api.types';

export type { AcademicCycle, AttendanceRecord, AttendanceSummary, ChildSummary, DashboardSummary, Grade, GradePeriod, Report, SchoolConfig, SchoolGroup, SchoolRole, SchoolUser, Student, StudentStatus, Subject };

@Injectable({ providedIn: 'root' })
export class SchoolApiService {
  private readonly auth = inject(AuthService);

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.auth.getToken();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data['error'] ?? 'Error desconocido.');
    return data as T;
  }

  private get<T>(path: string) { return this.req<T>('GET', path); }
  private post<T>(path: string, body: unknown) { return this.req<T>('POST', path, body); }
  private patch<T>(path: string, body: unknown) { return this.req<T>('PATCH', path, body); }
  private put<T>(path: string, body: unknown) { return this.req<T>('PUT', path, body); }
  private del<T>(path: string) { return this.req<T>('DELETE', path); }

  getDashboard() { return this.get<DashboardSummary>('/school/dashboard'); }

  getStudents(search = '') { return this.get<Student[]>(`/school/students${search ? `?search=${encodeURIComponent(search)}` : ''}`); }
  createStudent(input: { name: string; guardian: string; groupId: string; status: StudentStatus; parentUserId?: string | null }) { return this.post<Student>('/school/students', input); }
  updateStudent(id: string, input: Partial<{ name: string; guardian: string; groupId: string; status: StudentStatus; parentUserId: string | null }>) { return this.patch<Student>(`/school/students/${id}`, input); }
  deleteStudent(id: string) { return this.del<void>(`/school/students/${id}`); }

  getGroups() { return this.get<SchoolGroup[]>('/school/groups'); }
  createGroup(input: { name: string; grade: string; room: string; capacity: number; teacherId?: string | null }) { return this.post<SchoolGroup>('/school/groups', input); }
  updateGroup(id: string, input: { name: string; grade: string; room: string; capacity: number; teacherId: string | null }) { return this.patch<SchoolGroup>(`/school/groups/${id}`, input); }
  deleteGroup(id: string) { return this.del<void>(`/school/groups/${id}`); }

  getUsers() { return this.get<SchoolUser[]>('/school/users'); }
  createUser(input: { name: string; email: string; role: SchoolRole; password: string }) { return this.post<SchoolUser>('/school/users', input); }
  updateUser(id: string, input: { active?: boolean; role?: SchoolRole; name?: string; email?: string }) { return this.patch<SchoolUser>(`/school/users/${id}`, input); }
  deleteUser(id: string) { return this.del<void>(`/school/users/${id}`); }

  getSubjects() { return this.get<Subject[]>('/school/subjects'); }
  createSubject(name: string) { return this.post<Subject>('/school/subjects', { name }); }
  deleteSubject(id: string) { return this.del<void>(`/school/subjects/${id}`); }

  getGrades(filters: { studentId?: string; groupId?: string; period?: string } = {}) {
    const params = new URLSearchParams(filters as Record<string, string>).toString();
    return this.get<Grade[]>(`/grades${params ? `?${params}` : ''}`);
  }
  createGrade(input: { studentId: string; subjectId: string; period: GradePeriod; value: number; notes?: string }) { return this.post<Grade>('/grades', input); }
  updateGrade(id: string, input: { value?: number; notes?: string }) { return this.patch<Grade>(`/grades/${id}`, input); }
  deleteGrade(id: string) { return this.del<void>(`/grades/${id}`); }
  bulkUpsertGrades(input: { groupId: string; subjectId: string; period: GradePeriod; grades: { studentId: string; value: number }[] }) {
    return this.post<{ saved: number; grades: { id: string; studentId: string; value: number; period: string }[] }>('/grades/bulk', input);
  }

  getReports(filters: { groupId?: string } = {}) {
    const params = new URLSearchParams(filters as Record<string, string>).toString();
    return this.get<Report[]>(`/ext/reports${params ? `?${params}` : ''}`);
  }
  createReport(input: { title: string; body: string; groupId?: string }) { return this.post<Report>('/ext/reports', input); }
  updateReport(id: string, input: { title?: string; body?: string }) { return this.patch<Report>(`/ext/reports/${id}`, input); }
  deleteReport(id: string) { return this.del<void>(`/ext/reports/${id}`); }

  getCycles() { return this.get<AcademicCycle[]>('/ext/cycles'); }
  createCycle(input: { name: string; startDate: string; endDate: string; active?: boolean }) { return this.post<AcademicCycle>('/ext/cycles', input); }
  updateCycle(id: string, input: Partial<{ name: string; startDate: string; endDate: string; active: boolean }>) { return this.patch<AcademicCycle>(`/ext/cycles/${id}`, input); }
  deleteCycle(id: string) { return this.del<void>(`/ext/cycles/${id}`); }

  getConfig() { return this.get<SchoolConfig>('/ext/config'); }
  updateConfig(input: Partial<SchoolConfig>) { return this.put<SchoolConfig>('/ext/config', input); }

  getAttendance(filters: { cycleId?: string; groupId?: string; date?: string; studentId?: string } = {}) {
    const params = new URLSearchParams(filters as Record<string, string>).toString();
    return this.get<AttendanceRecord[]>(`/ext/attendance${params ? `?${params}` : ''}`);
  }
  getAttendanceSummary(cycleId: string, groupId?: string) {
    const params = new URLSearchParams({ cycleId, ...(groupId ? { groupId } : {}) }).toString();
    return this.get<AttendanceSummary[]>(`/ext/attendance/summary?${params}`);
  }
  bulkAttendance(input: { cycleId: string; date: string; records: { studentId: string; status: string; notes?: string }[] }) {
    return this.post<{ saved: number }>('/ext/attendance/bulk', input);
  }

  getMyChildren() { return this.getStudents(); }

  sendCommunique(input: { groupId?: string; subject: string; body: string }) { return this.post<{ sent: number }>('/ext/send-communique', input); }
  sendBoleta(studentId: string) { return this.post<void>('/ext/send-boleta', { studentId }); }
}
