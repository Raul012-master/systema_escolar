export type StudentStatus = 'ENROLLED' | 'PENDING';
export type SchoolRole = 'ADMIN' | 'TEACHER' | 'PARENT' | 'STUDENT';
export type GradePeriod = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'FINAL';
export type AttendanceStatus = 'PRESENT' | 'ABSENT' | 'LATE' | 'JUSTIFIED';
export type LevelType = 'PRIMARY' | 'SECONDARY' | 'BACHILLERATO';

export interface SchoolConfig {
  levelType: LevelType;
  gradingScale: number;
  periods: string;
  address: string;
  phone: string;
  directorName: string;
}

export interface AcademicCycle {
  id: string; name: string; startDate: string; endDate: string; active: boolean;
}

export interface AttendanceRecord {
  id: string; studentId: string; studentName: string; registrationNumber: string;
  groupId: string; cycleId: string; date: string; status: AttendanceStatus; notes: string | null;
}

export interface AttendanceSummary {
  studentId: string; studentName: string; registrationNumber: string; groupId: string;
  present: number; absent: number; late: number; justified: number; total: number; attendanceRate: number | null;
}

export interface Student {
  id: string; registrationNumber: string; name: string; grade: string;
  groupId: string; group: string; guardian: string; status: StudentStatus; parentUserId: string | null;
}

export interface SchoolGroup {
  id: string; name: string; grade: string; teacherId: string | null;
  teacher: string | null; students: number; capacity: number; room: string;
}

export interface SchoolUser {
  id: string; name: string; email: string; role: SchoolRole; active: boolean;
}

export interface ChildSummary {
  id: string; name: string; registrationNumber: string; groupName: string;
  groupGrade: string; status: string; gradesCount: number; average: number | null;
}

export interface DashboardSummary {
  role?: string; students: number; pendingStudents: number; groups: number; users: number;
  groupOccupancy: { id: string; name: string; grade: string; capacity: number; students: number }[];
  children?: ChildSummary[]; totalChildren?: number; teacherGradeAvg?: number | null;
}

export interface Subject { id: string; name: string; }

export interface Grade {
  id: string; studentId: string; studentName: string; registrationNumber: string;
  subjectId: string; subjectName: string; teacherId: string; teacherName: string;
  period: GradePeriod; value: number; notes: string | null; createdAt: string;
}

export interface Report {
  id: string; title: string; body: string; teacherId: string; teacherName: string;
  groupId: string | null; groupName: string | null; groupGrade: string | null;
  createdAt: string; updatedAt: string;
}
