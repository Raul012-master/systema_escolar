import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('creates the school application', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('switches between the school sections', () => {
    const app = TestBed.createComponent(App).componentInstance;
    app.setSection('students');
    expect(app.pageTitle()).toBe('Estudiantes');
    app.setSection('groups');
    expect(app.pageTitle()).toBe('Grupos');
  });

  it('keeps administration-only navigation hidden for unauthenticated users', () => {
    const app = TestBed.createComponent(App).componentInstance;
    expect(app.navItems().map((item) => item.key)).not.toContain('users');
  });
});
