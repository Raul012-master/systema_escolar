import { Component, computed, signal } from '@angular/core';
import { inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService, type AuthUser } from './auth.service';
import { apiErrorMessage } from './api-error';
import { ToastService } from './toast.service';
import { ConfirmService } from './confirm.service';
import {
  SchoolApiService,
  type AcademicCycle,
  type AttendanceRecord,
  type AttendanceSummary,
  type ChildSummary,
  type DashboardSummary,
  type Grade,
  type GradePeriod,
  type Report,
  type SchoolConfig,
  type SchoolGroup,
  type SchoolRole,
  type SchoolUser,
  type Student,
  type StudentStatus,
  type Subject,
} from './school-api.service';

type Section = 'dashboard' | 'students' | 'groups' | 'users' | 'grades' | 'reports' | 'attendance' | 'cycles' | 'config';

@Component({
  imports: [FormsModule, DecimalPipe],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  private readonly auth = inject(AuthService);
  private readonly api = inject(SchoolApiService);
  readonly toast = inject(ToastService);
  readonly confirm = inject(ConfirmService);
  readonly authStatus = this.auth.status;
  readonly googleLinked = this.auth.googleLinked;
  readonly activeSection = signal<Section>('dashboard');
  readonly showForgotForm = signal(false);
  readonly showResetForm = signal(false);
  readonly resetToken = signal('');
  readonly loginEmail = signal('');
  readonly loginPassword = signal('');
  readonly forgotEmail = signal('');
  readonly resetPasswordValue = signal('');
  readonly authError = signal('');

  // ── Phoenix sidebar ───────────────────────────────────────────────────────
  readonly sidebarCollapsed = signal(false);
  readonly mobileSidebarOpen = signal(false);

  toggleSidebar(): void {
    this.sidebarCollapsed.update(v => !v);
  }

  toggleMobileSidebar(): void {
    this.mobileSidebarOpen.update(v => !v);
  }

  closeMobileSidebar(): void {
    this.mobileSidebarOpen.set(false);
  }

  // ── 2FA / OTP ─────────────────────────────────────────────────────────────
  readonly otpPending = signal<{ userId: string; email: string } | null>(null);
  readonly otpCode = signal('');
  readonly otpBusy = signal(false);
  readonly authNotice = signal('');
  readonly authBusy = signal(false);
  readonly apiError = signal('');
  readonly loadingData = signal(false);
  readonly todayLabel = new Intl.DateTimeFormat('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date()).toLocaleUpperCase('es-MX');
  readonly searchTerm = signal('');

  // Student form
  readonly showStudentForm = signal(false);
  readonly editingStudentId = signal<string | null>(null);
  readonly studentName = signal('');
  readonly studentGroupId = signal('');
  readonly studentGuardian = signal('');
  readonly studentStatus = signal<StudentStatus>('ENROLLED');
  readonly studentParentId = signal<string>('');

  // Group form
  readonly showGroupForm = signal(false);
  readonly editingGroupId = signal<string | null>(null);
  readonly groupName = signal('');
  readonly groupGrade = signal('');
  readonly groupRoom = signal('');
  readonly groupCapacity = signal(30);
  readonly groupTeacherId = signal('');

  // User form
  readonly showUserForm = signal(false);
  readonly userName = signal('');
  readonly userEmail = signal('');
  readonly userRole = signal<SchoolRole>('TEACHER');
  readonly userPassword = signal('');
  readonly showChangePassword = signal(false);
  readonly currentPassword = signal('');
  readonly newPassword = signal('');
  readonly formError = signal('');
  readonly mutationBusy = signal(false);

  // Grade form
  readonly showGradeForm = signal(false);
  readonly editingGradeId = signal<string | null>(null);
  readonly gradeStudentId = signal('');
  readonly gradeSubjectId = signal('');
  readonly gradePeriod = signal<GradePeriod>('Q1');
  readonly gradeValue = signal(0);
  readonly gradeNotes = signal('');
  readonly gradeFilterGroupId = signal('');
  readonly gradeFilterPeriod = signal('');

  // Report form
  readonly showReportForm = signal(false);
  readonly editingReportId = signal<string | null>(null);
  readonly reportTitle = signal('');
  readonly reportBody = signal('');
  readonly reportGroupId = signal('');

  // Subject form
  readonly showSubjectForm = signal(false);
  readonly subjectName = signal('');

  // Bulk grade capture
  readonly showBulkForm = signal(false);
  readonly bulkGroupId = signal('');
  readonly bulkSubjectId = signal('');
  readonly bulkPeriod = signal<GradePeriod>('Q1');
  readonly bulkValues = signal<Record<string, number>>({});
  readonly bulkBusy = signal(false);
  readonly bulkError = signal('');

  // Data signals
  readonly students = signal<Student[]>([]);
  readonly groups = signal<SchoolGroup[]>([]);
  readonly users = signal<SchoolUser[]>([]);
  readonly dashboard = signal<DashboardSummary | null>(null);
  readonly grades = signal<Grade[]>([]);
  readonly reports = signal<Report[]>([]);
  readonly subjects = signal<Subject[]>([]);
  readonly cycles = signal<AcademicCycle[]>([]);
  readonly schoolConfig = signal<SchoolConfig | null>(null);
  readonly attendanceRecords = signal<AttendanceRecord[]>([]);
  readonly attendanceSummary = signal<AttendanceSummary[]>([]);

  // Attendance form
  readonly attendanceCycleId = signal('');
  readonly attendanceGroupId = signal('');
  readonly attendanceDate = signal(new Date().toISOString().slice(0, 10));
  readonly attendanceDraft = signal<Record<string, string>>({});
  readonly attendanceBusy = signal(false);
  readonly showAttendanceSummary = signal(false);

  // Cycle form
  readonly showCycleForm = signal(false);
  readonly editingCycleId = signal<string | null>(null);
  readonly cycleName = signal('');
  readonly cycleStart = signal('');
  readonly cycleEnd = signal('');
  readonly cycleActive = signal(false);

  // Config form
  readonly configLevelType = signal('PRIMARY');
  readonly configGradingScale = signal(10);
  readonly configAddress = signal('');
  readonly configPhone = signal('');
  readonly configDirector = signal('');
  readonly configBusy = signal(false);

  readonly user = this.auth.user;

  readonly navItems = computed(() => {
    const role = this.auth.user()?.role;
    const items: { key: Section; label: string; icon: string }[] = [
      { key: 'dashboard', label: 'Panel principal', icon: 'bi-house' },
    ];
    if (role === 'ADMIN' || role === 'TEACHER') {
      items.push({ key: 'students', label: 'Estudiantes', icon: 'bi-person-lines-fill' });
      items.push({ key: 'groups', label: 'Grupos', icon: 'bi-collection' });
      items.push({ key: 'attendance', label: 'Asistencias', icon: 'bi-calendar-check' });
      items.push({ key: 'grades', label: 'Calificaciones', icon: 'bi-journal-check' });
      items.push({ key: 'reports', label: 'Reportes', icon: 'bi-file-earmark-text' });
    }
    if (role === 'ADMIN') {
      items.push({ key: 'cycles', label: 'Ciclos escolares', icon: 'bi-calendar3' });
      items.push({ key: 'users', label: 'Usuarios', icon: 'bi-people' });
      items.push({ key: 'config', label: 'Configuración', icon: 'bi-gear' });
    }
    if (role === 'PARENT' || role === 'STUDENT') {
      items.push({ key: 'grades', label: 'Calificaciones', icon: 'bi-journal-check' });
      items.push({ key: 'reports', label: 'Reportes', icon: 'bi-file-earmark-text' });
    }
    return items;
  });

  readonly teachers = computed(() =>
    this.users().filter((user) => user.role === 'TEACHER' && user.active),
  );

  readonly parentUsers = computed(() =>
    this.users().filter((u) => u.role === 'PARENT' && u.active),
  );

  readonly filteredStudents = computed(() => {
    const query = this.searchTerm().trim().toLocaleLowerCase('es-MX');
    if (!query) return this.students();
    return this.students().filter((student) =>
      [
        student.name,
        student.registrationNumber,
        student.grade,
        student.group,
        student.guardian,
      ].some((value) => value.toLocaleLowerCase('es-MX').includes(query)),
    );
  });

  readonly pageTitle = computed(
    () =>
      ({
        dashboard: 'Panel principal',
        students: 'Estudiantes',
        groups: 'Grupos',
        users: 'Usuarios',
        grades: 'Calificaciones',
        reports: 'Reportes',
        attendance: 'Asistencias',
        cycles: 'Ciclos escolares',
        config: 'Configuración',
      })[this.activeSection()],
  );

  readonly enrolledCount = computed(
    () => this.students().filter((student) => student.status === 'ENROLLED').length,
  );
  readonly pendingCount = computed(
    () => this.students().filter((student) => student.status === 'PENDING').length,
  );
  readonly activeUserCount = computed(() => this.users().filter((user) => user.active).length);
  readonly totalGroupCapacity = computed(() =>
    this.groups().reduce((total, group) => total + group.capacity, 0),
  );
  readonly totalGroupStudents = computed(() =>
    this.groups().reduce((total, group) => total + group.students, 0),
  );

  readonly groupStudents = computed(() => {
    const gid = this.gradeFilterGroupId();
    if (!gid) return this.students();
    return this.students().filter((s) => s.groupId === gid);
  });

  readonly bulkGroupStudents = computed(() => {
    const gid = this.bulkGroupId();
    if (!gid) return [];
    return this.students().filter((s) => s.groupId === gid);
  });

  readonly dashboardChildren = computed(() => {
    const d = this.dashboard() as (DashboardSummary & { children?: ChildSummary[] }) | null;
    return d?.children ?? [];
  });

  async ngOnInit(): Promise<void> {
    if (window.location.pathname === '/reset-password') {
      this.showResetForm.set(true);
      this.resetToken.set(new URLSearchParams(window.location.search).get('oobCode') ?? '');
    }
    await this.auth.initialize();
    if (this.auth.status() === 'authenticated') await this.refreshData();
  }

  isAdmin(): boolean {
    return this.auth.user()?.role === 'ADMIN';
  }

  isTeacher(): boolean {
    return this.auth.user()?.role === 'TEACHER';
  }

  isParent(): boolean {
    return this.auth.user()?.role === 'PARENT';
  }

  canEditGrades(): boolean {
    const role = this.auth.user()?.role;
    return role === 'ADMIN' || role === 'TEACHER';
  }

  setSection(section: Section): void {
    const role = this.auth.user()?.role;
    if (section === 'users' && role !== 'ADMIN') return;
    if (section === 'cycles' && role !== 'ADMIN') return;
    if (section === 'config' && role !== 'ADMIN') return;
    if ((section === 'students' || section === 'groups') && (role === 'PARENT' || role === 'STUDENT')) return;
    this.activeSection.set(section);
    this.searchTerm.set('');
    if (section === 'grades') this.loadGrades();
    if (section === 'reports') this.loadReports();
    if (section === 'attendance') this.loadAttendance();
    if (section === 'cycles') this.loadCycles();
    if (section === 'config') this.loadConfig();
  }

  async refreshData(): Promise<void> {
    this.loadingData.set(true);
    this.apiError.set('');
    const role = this.auth.user()?.role;
    try {
      const promises: Promise<unknown>[] = [this.api.getDashboard()];
      if (role === 'ADMIN' || role === 'TEACHER') {
        promises.push(this.api.getStudents(), this.api.getGroups(), this.api.getSubjects(), this.api.getCycles());
      }
      if (role === 'PARENT' || role === 'STUDENT') {
        promises.push(this.api.getStudents(), this.api.getSubjects());
      }
      const results = await Promise.all(promises);
      this.dashboard.set(results[0] as DashboardSummary);
      if (role === 'ADMIN' || role === 'TEACHER') {
        this.students.set(results[1] as Student[]);
        this.groups.set(results[2] as SchoolGroup[]);
        this.subjects.set(results[3] as Subject[]);
        this.cycles.set(results[4] as AcademicCycle[]);
        const active = (results[4] as AcademicCycle[]).find((c) => c.active);
        if (active && !this.attendanceCycleId()) this.attendanceCycleId.set(active.id);
      } else if (role === 'PARENT' || role === 'STUDENT') {
        this.students.set(results[1] as Student[]);
        this.subjects.set(results[2] as Subject[]);
      }
      if (role === 'ADMIN') {
        this.users.set(await this.api.getUsers());
      } else {
        this.users.set([]);
      }
    } catch (error) {
      this.apiError.set(apiErrorMessage(error));
    } finally {
      this.loadingData.set(false);
    }
  }

  async loadGrades(): Promise<void> {
    this.loadingData.set(true);
    try {
      const filters: { groupId?: string; period?: string } = {};
      if (this.gradeFilterGroupId()) filters.groupId = this.gradeFilterGroupId();
      if (this.gradeFilterPeriod()) filters.period = this.gradeFilterPeriod();
      this.grades.set(await this.api.getGrades(filters));
    } catch (error) {
      this.apiError.set(apiErrorMessage(error));
    } finally {
      this.loadingData.set(false);
    }
  }

  async loadReports(): Promise<void> {
    this.loadingData.set(true);
    try {
      this.reports.set(await this.api.getReports());
    } catch (error) {
      this.apiError.set(apiErrorMessage(error));
    } finally {
      this.loadingData.set(false);
    }
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  async submitLogin(): Promise<void> {
    this.authBusy.set(true);
    this.authError.set('');
    this.authNotice.set('');
    try {
      const otpResult = await this.auth.login(
        this.loginEmail().trim(),
        this.loginPassword(),
      );
      this.loginPassword.set('');
      if (otpResult) {
        // 2FA: show OTP screen
        this.otpPending.set({ userId: otpResult.userId, email: otpResult.email });
        this.otpCode.set('');
      } else {
        // No 2FA: session ready
        await this.refreshData();
      }
    } catch (error) {
      this.authError.set(apiErrorMessage(error));
    } finally {
      this.authBusy.set(false);
    }
  }

  async submitGoogleLogin(): Promise<void> {
    this.authBusy.set(true);
    this.authError.set('');
    this.authNotice.set('');
    try {
      const otpResult = await this.auth.loginWithGoogle();
      this.otpPending.set({ userId: otpResult.userId, email: otpResult.email });
      this.otpCode.set('');
    } catch (error) {
      this.authError.set(apiErrorMessage(error));
    } finally {
      this.authBusy.set(false);
    }
  }

  async linkGoogleAccount(): Promise<void> {
    this.authBusy.set(true);
    this.authError.set('');
    this.authNotice.set('');
    try {
      await this.auth.linkGoogleAccount();
      this.authNotice.set('Cuenta de Google vinculada. Ya podrás entrar con Google.');
    } catch (error) {
      this.authError.set(apiErrorMessage(error));
    } finally {
      this.authBusy.set(false);
    }
  }

  async submitOtp(): Promise<void> {
    const pending = this.otpPending();
    if (!pending) return;
    this.otpBusy.set(true);
    this.authError.set('');
    try {
      await this.auth.verifyOtp(pending.userId, this.otpCode().trim());
      this.otpPending.set(null);
      this.otpCode.set('');
      await this.refreshData();
    } catch (error) {
      this.authError.set(apiErrorMessage(error));
    } finally {
      this.otpBusy.set(false);
    }
  }

  cancelOtp(): void {
    this.otpPending.set(null);
    this.otpCode.set('');
    this.authError.set('');
    this.auth.status.set('unauthenticated');
  }

  async signOut(): Promise<void> {
    this.authBusy.set(true);
    this.authError.set('');
    try {
      await this.auth.logout();
    } catch (error) {
      if (apiErrorMessage(error).includes('No se pudo conectar')) {
        this.authError.set(apiErrorMessage(error));
        this.authBusy.set(false);
        return;
      }
      await this.auth.initialize();
    } finally {
      this.students.set([]);
      this.groups.set([]);
      this.users.set([]);
      this.dashboard.set(null);
      this.grades.set([]);
      this.reports.set([]);
      this.subjects.set([]);
      this.authBusy.set(false);
    }
  }

  async requestReset(): Promise<void> {
    this.authBusy.set(true);
    this.authError.set('');
    this.authNotice.set('');
    try {
      this.authNotice.set(await this.auth.forgotPassword(this.forgotEmail().trim()));
    } catch (error) {
      this.authError.set(apiErrorMessage(error));
    } finally {
      this.authBusy.set(false);
    }
  }

  async completeReset(): Promise<void> {
    this.authBusy.set(true);
    this.authError.set('');
    this.authNotice.set('');
    try {
      await this.auth.resetPassword(this.resetToken(), this.resetPasswordValue());
      this.showResetForm.set(false);
      this.authNotice.set('Contraseña actualizada. Ya puedes iniciar sesión.');
      window.history.replaceState({}, '', '/');
    } catch (error) {
      this.authError.set(apiErrorMessage(error));
    } finally {
      this.authBusy.set(false);
    }
  }

  openChangePassword(): void {
    this.authError.set('');
    this.formError.set('');
    this.currentPassword.set('');
    this.newPassword.set('');
    this.showChangePassword.set(true);
  }

  async submitPasswordChange(): Promise<void> {
    this.mutationBusy.set(true);
    this.formError.set('');
    try {
      await this.auth.changePassword(this.currentPassword(), this.newPassword());
      this.showChangePassword.set(false);
      this.authNotice.set('Contraseña actualizada. Inicia sesión de nuevo con tu nueva clave.');
      this.students.set([]);
      this.groups.set([]);
      this.users.set([]);
      this.dashboard.set(null);
    } catch (error) {
      this.formError.set(apiErrorMessage(error));
    } finally {
      this.mutationBusy.set(false);
    }
  }

  backToLogin(): void {
    this.showResetForm.set(false);
    this.authError.set('');
    this.authNotice.set('');
    window.history.replaceState({}, '', '/');
  }

  // ── Students ──────────────────────────────────────────────────────────────

  async submitStudent(): Promise<void> {
    this.mutationBusy.set(true);
    this.formError.set('');
    try {
      const input = {
        name: this.studentName().trim(),
        guardian: this.studentGuardian().trim(),
        groupId: this.studentGroupId(),
        status: this.studentStatus(),
        parentUserId: this.studentParentId() || null,
      };
      const id = this.editingStudentId();
      if (id) await this.api.updateStudent(id, input);
      else await this.api.createStudent(input);
      this.showStudentForm.set(false);
      this.toast.success(id ? 'Estudiante actualizado.' : 'Estudiante registrado correctamente.');
      await this.refreshData();
    } catch (error) {
      this.formError.set(apiErrorMessage(error));
    } finally {
      this.mutationBusy.set(false);
    }
  }

  openStudentForm(student?: Student): void {
    this.formError.set('');
    this.editingStudentId.set(student?.id ?? null);
    this.studentName.set(student?.name ?? '');
    this.studentGuardian.set(student?.guardian ?? '');
    this.studentGroupId.set(student?.groupId ?? this.groups()[0]?.id ?? '');
    this.studentStatus.set(student?.status ?? 'ENROLLED');
    this.studentParentId.set(student?.parentUserId ?? '');
    this.showStudentForm.set(true);
  }

  async deleteStudent(student: Student): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Eliminar estudiante',
      message: `¿Eliminar el registro de ${student.name}? Esta acción no se puede deshacer.`,
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    this.apiError.set('');
    try {
      await this.api.deleteStudent(student.id);
      this.toast.success(`Registro de ${student.name} eliminado.`);
      await this.refreshData();
    } catch (error) {
      this.toast.error(apiErrorMessage(error));
    }
  }

  // ── Groups ────────────────────────────────────────────────────────────────

  async submitGroup(): Promise<void> {
    this.mutationBusy.set(true);
    this.formError.set('');
    try {
      const input = {
        name: this.groupName().trim(),
        grade: this.groupGrade().trim(),
        room: this.groupRoom().trim(),
        capacity: Number(this.groupCapacity()),
        teacherId: this.groupTeacherId() || null,
      };
      const id = this.editingGroupId();
      if (id) await this.api.updateGroup(id, input);
      else
        await this.api.createGroup({
          ...input,
          ...(input.teacherId ? { teacherId: input.teacherId } : {}),
        });
      this.showGroupForm.set(false);
      this.toast.success(id ? 'Grupo actualizado.' : 'Grupo creado correctamente.');
      await this.refreshData();
    } catch (error) {
      this.formError.set(apiErrorMessage(error));
    } finally {
      this.mutationBusy.set(false);
    }
  }

  openGroupForm(group?: SchoolGroup): void {
    this.formError.set('');
    this.editingGroupId.set(group?.id ?? null);
    this.groupName.set(group?.name ?? '');
    this.groupGrade.set(group?.grade ?? '');
    this.groupRoom.set(group?.room ?? '');
    this.groupCapacity.set(group?.capacity ?? 30);
    this.groupTeacherId.set(group?.teacherId ?? '');
    this.showGroupForm.set(true);
  }

  async deleteGroup(group: SchoolGroup): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Eliminar grupo',
      message: `¿Eliminar el grupo ${group.name}? Se perderán sus datos asociados.`,
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    this.apiError.set('');
    try {
      await this.api.deleteGroup(group.id);
      this.toast.success(`Grupo ${group.name} eliminado.`);
      await this.refreshData();
    } catch (error) {
      this.toast.error(apiErrorMessage(error));
    }
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  async submitUser(): Promise<void> {
    this.mutationBusy.set(true);
    this.formError.set('');
    try {
      await this.api.createUser({
        name: this.userName().trim(),
        email: this.userEmail().trim(),
        role: this.userRole(),
        password: this.userPassword(),
      });
      this.showUserForm.set(false);
      this.toast.success('Usuario creado correctamente.');
      await this.refreshData();
    } catch (error) {
      this.formError.set(apiErrorMessage(error));
    } finally {
      this.mutationBusy.set(false);
    }
  }

  openUserForm(): void {
    this.formError.set('');
    this.userName.set('');
    this.userEmail.set('');
    this.userRole.set('TEACHER');
    this.userPassword.set('');
    this.showUserForm.set(true);
  }

  async toggleUser(user: SchoolUser): Promise<void> {
    this.apiError.set('');
    try {
      await this.api.updateUser(user.id, { active: !user.active });
      this.toast.info(`Usuario ${user.name} ${user.active ? 'desactivado' : 'activado'}.`);
      await this.refreshData();
    } catch (error) {
      this.toast.error(apiErrorMessage(error));
    }
  }

  async deleteUser(user: SchoolUser): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Eliminar usuario',
      message: `¿Eliminar a ${user.name} y cerrar sus sesiones activas?`,
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    this.apiError.set('');
    try {
      await this.api.deleteUser(user.id);
      this.toast.success(`Usuario ${user.name} eliminado.`);
      await this.refreshData();
    } catch (error) {
      this.toast.error(apiErrorMessage(error));
    }
  }

  // ── Grades ────────────────────────────────────────────────────────────────

  openGradeForm(grade?: Grade): void {
    this.formError.set('');
    this.editingGradeId.set(grade?.id ?? null);
    this.gradeStudentId.set(grade?.studentId ?? this.groupStudents()[0]?.id ?? '');
    this.gradeSubjectId.set(grade?.subjectId ?? this.subjects()[0]?.id ?? '');
    this.gradePeriod.set(grade?.period ?? 'Q1');
    this.gradeValue.set(grade?.value ?? 0);
    this.gradeNotes.set(grade?.notes ?? '');
    this.showGradeForm.set(true);
  }

  async submitGrade(): Promise<void> {
    this.mutationBusy.set(true);
    this.formError.set('');
    try {
      const id = this.editingGradeId();
      if (id) {
        await this.api.updateGrade(id, {
          value: this.gradeValue(),
          notes: this.gradeNotes().trim() || undefined,
        });
        this.toast.success('Calificación actualizada.');
      } else {
        await this.api.createGrade({
          studentId: this.gradeStudentId(),
          subjectId: this.gradeSubjectId(),
          period: this.gradePeriod(),
          value: this.gradeValue(),
          notes: this.gradeNotes().trim() || undefined,
        });
        this.toast.success('Calificación registrada.');
      }
      this.showGradeForm.set(false);
      await this.loadGrades();
    } catch (error) {
      this.formError.set(apiErrorMessage(error));
    } finally {
      this.mutationBusy.set(false);
    }
  }

  async deleteGrade(grade: Grade): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Eliminar calificación',
      message: `¿Eliminar la calificación de ${grade.studentName} en ${grade.subjectName}?`,
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.deleteGrade(grade.id);
      this.toast.success('Calificación eliminada.');
      await this.loadGrades();
    } catch (error) {
      this.toast.error(apiErrorMessage(error));
    }
  }

  // ── Reports ───────────────────────────────────────────────────────────────

  openReportForm(report?: Report): void {
    this.formError.set('');
    this.editingReportId.set(report?.id ?? null);
    this.reportTitle.set(report?.title ?? '');
    this.reportBody.set(report?.body ?? '');
    this.reportGroupId.set(report?.groupId ?? '');
    this.showReportForm.set(true);
  }

  async submitReport(): Promise<void> {
    this.mutationBusy.set(true);
    this.formError.set('');
    try {
      const id = this.editingReportId();
      if (id) {
        await this.api.updateReport(id, {
          title: this.reportTitle().trim(),
          body: this.reportBody().trim(),
        });
        this.toast.success('Reporte actualizado.');
      } else {
        await this.api.createReport({
          title: this.reportTitle().trim(),
          body: this.reportBody().trim(),
          groupId: this.reportGroupId() || undefined,
        });
        this.toast.success('Reporte creado correctamente.');
      }
      this.showReportForm.set(false);
      await this.loadReports();
    } catch (error) {
      this.formError.set(apiErrorMessage(error));
    } finally {
      this.mutationBusy.set(false);
    }
  }

  async deleteReport(report: Report): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Eliminar reporte',
      message: `¿Eliminar el reporte "${report.title}"?`,
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.deleteReport(report.id);
      this.toast.success('Reporte eliminado.');
      await this.loadReports();
    } catch (error) {
      this.toast.error(apiErrorMessage(error));
    }
  }

  // ── Subjects ──────────────────────────────────────────────────────────────

  openSubjectForm(): void {
    this.formError.set('');
    this.subjectName.set('');
    this.showSubjectForm.set(true);
  }

  async submitSubject(): Promise<void> {
    this.mutationBusy.set(true);
    this.formError.set('');
    try {
      await this.api.createSubject(this.subjectName().trim());
      this.showSubjectForm.set(false);
      this.toast.success('Materia creada correctamente.');
      this.subjects.set(await this.api.getSubjects());
    } catch (error) {
      this.formError.set(apiErrorMessage(error));
    } finally {
      this.mutationBusy.set(false);
    }
  }

  async deleteSubject(subject: Subject): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Eliminar materia',
      message: `¿Eliminar la materia "${subject.name}"? Se eliminarán sus calificaciones.`,
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.deleteSubject(subject.id);
      this.toast.success(`Materia ${subject.name} eliminada.`);
      this.subjects.set(await this.api.getSubjects());
    } catch (error) {
      this.toast.error(apiErrorMessage(error));
    }
  }

  // ── Bulk Grades ───────────────────────────────────────────────────────────

  openBulkForm(): void {
    this.bulkError.set('');
    this.bulkGroupId.set(this.groups()[0]?.id ?? '');
    this.bulkSubjectId.set(this.subjects()[0]?.id ?? '');
    this.bulkPeriod.set('Q1');
    this.bulkValues.set({});
    this.showBulkForm.set(true);
  }

  setBulkValue(studentId: string, value: number): void {
    this.bulkValues.update((prev) => ({ ...prev, [studentId]: value }));
  }

  getBulkValue(studentId: string): number {
    return this.bulkValues()[studentId] ?? 0;
  }

  async submitBulkGrades(): Promise<void> {
    this.bulkBusy.set(true);
    this.bulkError.set('');
    const grades = this.bulkGroupStudents().map((s) => ({
      studentId: s.id,
      value: this.getBulkValue(s.id),
    }));
    if (!grades.length) {
      this.bulkError.set('El grupo no tiene alumnos.');
      this.bulkBusy.set(false);
      return;
    }
    try {
      const result = await this.api.bulkUpsertGrades({
        groupId: this.bulkGroupId(),
        subjectId: this.bulkSubjectId(),
        period: this.bulkPeriod(),
        grades,
      });
      this.showBulkForm.set(false);
      this.toast.success(`${result.saved} calificaciones guardadas.`);
      await this.loadGrades();
    } catch (error) {
      this.bulkError.set(apiErrorMessage(error));
    } finally {
      this.bulkBusy.set(false);
    }
  }

  // ── Attendance ────────────────────────────────────────────────────────────

  async loadAttendance(): Promise<void> {
    if (!this.attendanceCycleId()) return;
    this.loadingData.set(true);
    try {
      const [records, summary] = await Promise.all([
        this.api.getAttendance({
          cycleId: this.attendanceCycleId(),
          groupId: this.attendanceGroupId() || undefined,
          date: this.attendanceDate(),
        }),
        this.api.getAttendanceSummary(
          this.attendanceCycleId(),
          this.attendanceGroupId() || undefined,
        ),
      ]);
      this.attendanceRecords.set(records);
      this.attendanceSummary.set(summary);
      const draft: Record<string, string> = {};
      for (const r of records) draft[r.studentId] = r.status;
      this.attendanceDraft.set(draft);
    } catch (error) {
      this.toast.error(apiErrorMessage(error));
    } finally {
      this.loadingData.set(false);
    }
  }

  setAttendanceDraft(studentId: string, status: string): void {
    this.attendanceDraft.update((d) => ({ ...d, [studentId]: status }));
  }

  getAttendanceDraft(studentId: string): string {
    return this.attendanceDraft()[studentId] ?? 'PRESENT';
  }

  async saveAttendance(): Promise<void> {
    if (!this.attendanceCycleId()) { this.toast.error('Selecciona un ciclo escolar.'); return; }
    this.attendanceBusy.set(true);
    const groupStudents = this.attendanceGroupId()
      ? this.students().filter((s) => s.groupId === this.attendanceGroupId())
      : this.students();
    const records = groupStudents.map((s) => ({ studentId: s.id, status: this.getAttendanceDraft(s.id) }));
    try {
      const result = await this.api.bulkAttendance({ cycleId: this.attendanceCycleId(), date: this.attendanceDate(), records });
      this.toast.success(`${result.saved} asistencias guardadas.`);
      await this.loadAttendance();
    } catch (error) {
      this.toast.error(apiErrorMessage(error));
    } finally {
      this.attendanceBusy.set(false);
    }
  }

  attendanceStatusLabel(s: string): string {
    return ({ PRESENT: 'Presente', ABSENT: 'Falta', LATE: 'Retardo', JUSTIFIED: 'Justificada' } as Record<string,string>)[s] ?? s;
  }

  attendanceStatusClass(s: string): string {
    return ({ PRESENT: 'badge-green', ABSENT: 'badge-red', LATE: 'badge-amber', JUSTIFIED: 'badge-blue' } as Record<string,string>)[s] ?? '';
  }

  // ── Cycles ────────────────────────────────────────────────────────────────

  async loadCycles(): Promise<void> {
    this.loadingData.set(true);
    try { this.cycles.set(await this.api.getCycles()); }
    catch (error) { this.toast.error(apiErrorMessage(error)); }
    finally { this.loadingData.set(false); }
  }

  openCycleForm(cycle?: AcademicCycle): void {
    this.formError.set('');
    this.editingCycleId.set(cycle?.id ?? null);
    this.cycleName.set(cycle?.name ?? '');
    this.cycleStart.set(cycle?.startDate?.slice(0, 10) ?? '');
    this.cycleEnd.set(cycle?.endDate?.slice(0, 10) ?? '');
    this.cycleActive.set(cycle?.active ?? false);
    this.showCycleForm.set(true);
  }

  async submitCycle(): Promise<void> {
    this.mutationBusy.set(true);
    this.formError.set('');
    try {
      const id = this.editingCycleId();
      if (id) {
        await this.api.updateCycle(id, { name: this.cycleName(), startDate: this.cycleStart(), endDate: this.cycleEnd(), active: this.cycleActive() });
        this.toast.success('Ciclo actualizado.');
      } else {
        await this.api.createCycle({ name: this.cycleName(), startDate: this.cycleStart(), endDate: this.cycleEnd(), active: this.cycleActive() });
        this.toast.success('Ciclo creado.');
      }
      this.showCycleForm.set(false);
      await this.loadCycles();
      const active = this.cycles().find((c) => c.active);
      if (active) this.attendanceCycleId.set(active.id);
    } catch (error) {
      this.formError.set(apiErrorMessage(error));
    } finally {
      this.mutationBusy.set(false);
    }
  }

  async deleteCycle(cycle: AcademicCycle): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Eliminar ciclo escolar',
      message: `¿Eliminar el ciclo "${cycle.name}"? Se perderán sus registros de asistencia.`,
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.deleteCycle(cycle.id);
      this.toast.success('Ciclo eliminado.');
      await this.loadCycles();
    } catch (error) { this.toast.error(apiErrorMessage(error)); }
  }

  async setActiveCycle(cycle: AcademicCycle): Promise<void> {
    try {
      await this.api.updateCycle(cycle.id, { active: true });
      this.toast.success(`Ciclo "${cycle.name}" activado.`);
      await this.loadCycles();
      this.attendanceCycleId.set(cycle.id);
    } catch (error) { this.toast.error(apiErrorMessage(error)); }
  }

  formatCycleDate(iso: string): string {
    return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  }

  // ── Config ────────────────────────────────────────────────────────────────

  async loadConfig(): Promise<void> {
    this.loadingData.set(true);
    try {
      const cfg = await this.api.getConfig();
      this.schoolConfig.set(cfg);
      this.configLevelType.set(cfg.levelType);
      this.configGradingScale.set(cfg.gradingScale);
      this.configAddress.set(cfg.address);
      this.configPhone.set(cfg.phone);
      this.configDirector.set(cfg.directorName);
    } catch (error) { this.toast.error(apiErrorMessage(error)); }
    finally { this.loadingData.set(false); }
  }

  async saveConfig(): Promise<void> {
    this.configBusy.set(true);
    try {
      await this.api.updateConfig({
        levelType: this.configLevelType() as SchoolConfig['levelType'],
        gradingScale: this.configGradingScale(),
        address: this.configAddress(),
        phone: this.configPhone(),
        directorName: this.configDirector(),
      });
      this.toast.success('Configuración guardada.');
    } catch (error) { this.toast.error(apiErrorMessage(error)); }
    finally { this.configBusy.set(false); }
  }

  levelTypeLabel(l: string): string {
    return ({ PRIMARY: 'Primaria', SECONDARY: 'Secundaria', BACHILLERATO: 'Bachillerato' } as Record<string,string>)[l] ?? l;
  }

  // ── PDF Boleta ────────────────────────────────────────────────────────────

  async downloadBoleta(child: ChildSummary): Promise<void> {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });
    const school = this.auth.user()?.schoolName ?? 'Colegio';
    const cfg = this.schoolConfig();
    const periods = ['Q1', 'Q2', 'Q3', 'Q4', 'FINAL'];
    const periodLabels: Record<string, string> = { Q1: '1er Bim', Q2: '2do Bim', Q3: '3er Bim', Q4: '4to Bim', FINAL: 'Final' };
    const childGrades = this.grades().filter((g) => g.studentId === child.id);

    doc.setFillColor(114, 91, 224);
    doc.rect(0, 0, 216, 28, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text(school, 14, 12);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text('BOLETA DE CALIFICACIONES', 14, 19);
    if (cfg?.directorName) doc.text(`Director(a): ${cfg.directorName}`, 14, 25);

    doc.setTextColor(40, 43, 62);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text(child.name, 14, 38);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 104, 120);
    doc.text(`Matrícula: ${child.registrationNumber}   Grupo: ${child.groupName}   Grado: ${child.groupGrade}`, 14, 44);
    const cycle = this.cycles().find((c) => c.active);
    if (cycle) doc.text(`Ciclo escolar: ${cycle.name}`, 14, 49);

    const startY = 56;
    const colWidths = [60, ...periods.map(() => 22), 24];
    const headers = ['MATERIA', ...periods.map((p) => periodLabels[p]), 'PROMEDIO'];
    let x = 14;
    doc.setFillColor(240, 237, 255);
    doc.rect(14, startY - 5, 188, 7, 'F');
    doc.setTextColor(114, 91, 224);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    headers.forEach((h, i) => { doc.text(h, x + 1, startY); x += colWidths[i]; });

    let y = startY + 6;
    doc.setFont('helvetica', 'normal');
    for (const subject of this.subjects()) {
      const sg = childGrades.filter((g) => g.subjectId === subject.id);
      const avg = sg.length ? sg.reduce((a, g) => a + g.value, 0) / sg.length : null;
      x = 14;
      doc.setTextColor(60, 64, 80);
      doc.setFontSize(8);
      doc.text(subject.name.slice(0, 28), x + 1, y);
      x += colWidths[0];
      periods.forEach((p, i) => {
        const g = sg.find((gr) => gr.period === p);
        const val = g ? String(g.value) : '—';
        if (g) { const c = g.value >= 7 ? [72,160,129] : [208,92,92]; doc.setTextColor(c[0],c[1],c[2]); }
        else doc.setTextColor(180, 182, 195);
        doc.text(val, x + colWidths[i + 1] / 2, y, { align: 'center' });
        x += colWidths[i + 1];
      });
      if (avg !== null) {
        const c = avg >= 7 ? [72,160,129] : [208,92,92];
        doc.setTextColor(c[0],c[1],c[2]);
        doc.setFont('helvetica', 'bold');
        doc.text(avg.toFixed(1), x + colWidths[colWidths.length - 1] / 2, y, { align: 'center' });
        doc.setFont('helvetica', 'normal');
      }
      y += 7;
      doc.setDrawColor(240, 241, 245);
      doc.line(14, y - 2, 202, y - 2);
    }

    if (child.average !== null) {
      y += 4;
      doc.setFillColor(114, 91, 224);
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.roundedRect(14, y, 188, 9, 2, 2, 'F');
      doc.text(`Promedio general: ${child.average}`, 108, y + 6, { align: 'center' });
    }

    doc.save(`boleta-${child.name.replace(/\s+/g, '-').toLowerCase()}.pdf`);
    this.toast.success('Boleta descargada.');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  teacherInitials(name: string | null): string {
    if (!name) return '—';
    return name
      .split(/\s+/)
      .map((part) => part[0])
      .slice(0, 2)
      .join('')
      .toLocaleUpperCase('es-MX');
  }

  initials(name: string): string {
    const parts = name.trim().split(/\s+/);
    return (
      parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : name.slice(0, 2)
    ).toLocaleUpperCase('es-MX');
  }

  studentStatusLabel(status: StudentStatus): string {
    return status === 'ENROLLED' ? 'Inscrito' : 'Pendiente';
  }

  selectedStudentGrade(): string {
    return this.groups().find((group) => group.id === this.studentGroupId())?.grade ?? '';
  }

  userRoleLabel(role: SchoolRole): string {
    const labels: Record<SchoolRole, string> = {
      ADMIN: 'Administrador',
      TEACHER: 'Docente',
      PARENT: 'Padre/Tutor',
      STUDENT: 'Estudiante',
    };
    return labels[role] ?? role;
  }

  activeUserLabel(user: AuthUser | null): string {
    if (!user) return '';
    return this.userRoleLabel(user.role as SchoolRole);
  }

  firstName(user: AuthUser | null): string {
    return user?.name.trim().split(/\s+/)[0] ?? '';
  }

  chartOccupancy(group: SchoolGroup): number {
    return group.capacity ? Math.min(100, (group.students / group.capacity) * 100) : 0;
  }

  periodLabel(period: string): string {
    const map: Record<string, string> = {
      Q1: '1er Bimestre',
      Q2: '2do Bimestre',
      Q3: '3er Bimestre',
      Q4: '4to Bimestre',
      FINAL: 'Final',
    };
    return map[period] ?? period;
  }

  gradeColor(value: number): string {
    if (value >= 8) return 'grade-high';
    if (value >= 6) return 'grade-mid';
    return 'grade-low';
  }

  formatDate(iso: string): string {
    return new Intl.DateTimeFormat('es-MX', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(iso));
  }

  // ── Mail / Comunicados ────────────────────────────────────────────────────
  readonly showMailForm = signal(false);
  readonly mailSubject = signal('');
  readonly mailBody = signal('');
  readonly mailGroupId = signal('');
  readonly mailBusy = signal(false);
  readonly mailSuccess = signal('');
  readonly boletaEmailBusyStudentId = signal<string | null>(null);

  async emailBoleta(child: ChildSummary): Promise<void> {
    this.boletaEmailBusyStudentId.set(child.id);
    try {
      await this.api.sendBoleta(child.id);
      this.toast.success(`Boleta enviada al correo vinculado de ${child.name}.`);
    } catch (error) {
      this.toast.error(apiErrorMessage(error));
    } finally {
      this.boletaEmailBusyStudentId.set(null);
    }
  }

  async submitCommunique(): Promise<void> {
    this.mailBusy.set(true);
    this.formError.set('');
    this.mailSuccess.set('');
    try {
      const result = await this.api.sendCommunique({
        ...(this.mailGroupId() ? { groupId: this.mailGroupId() } : {}),
        subject: this.mailSubject().trim(),
        body: this.mailBody().trim(),
      });
      this.mailSuccess.set(`Comunicado enviado a ${result.sent} destinatario(s).`);
      this.mailSubject.set('');
      this.mailBody.set('');
      this.toast.success(`Comunicado enviado a ${result.sent} destinatario(s).`);
    } catch (error) {
      this.formError.set(apiErrorMessage(error));
    } finally {
      this.mailBusy.set(false);
    }
  }
}
