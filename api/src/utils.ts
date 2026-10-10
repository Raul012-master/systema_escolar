import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firebase.js';
import nodemailer from 'nodemailer';

export type Values = Record<string, unknown>;
export type Role = 'ADMIN' | 'TEACHER' | 'PARENT' | 'STUDENT';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function record(v: unknown): Values {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Values) : {};
}

export function text(v: unknown, label: string, max = 300): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw new ApiError(400, `${label} no es válido.`);
  return v.trim();
}

export function optionalText(v: unknown, max = 300): string | null {
  if (v === undefined || v === null || v === '') return null;
  return text(v, 'El texto', max);
}

// ── Firestore store abstraction ──────────────────────────────────────────────

interface Snap { val(): unknown; exists(): boolean; }
function snap(value: unknown, exists = value !== null && value !== undefined): Snap {
  return { val: () => value, exists: () => exists };
}

function docPath(path: string): string {
  const s = path.split('/').filter(Boolean);
  if (s.length === 3 && s[0] === 'schools' && s[2] === 'config')
    return `${s[0]}/${s[1]}/config/settings`;
  if (s.length === 2 || (s.length === 4 && s[0] === 'schools'))
    return s.join('/');
  throw new Error(`Invalid path: ${path}`);
}

export function storeRef(path = '') {
  const p = path.replace(/^\/+|\/+$/g, '');
  return {
    child(seg: string) { return storeRef([p, seg].filter(Boolean).join('/')); },
    async get(): Promise<Snap> {
      const s = p.split('/').filter(Boolean);
      if (!s.length) return snap(null, false);
      if (s.length === 3 && s[0] === 'schools' && s[2] === 'name') {
        const d = await db.doc(`schools/${s[1]}`).get();
        return snap(d.get('name'), d.exists && d.get('name') !== undefined);
      }
      if (s.length <= 1 || (s.length === 3 && s[0] === 'schools' && s[2] !== 'config')) {
        const r = await db.collection(p).get();
        return snap(Object.fromEntries(r.docs.map(d => [d.id, d.data()])), !r.empty);
      }
      const r = await db.doc(docPath(p)).get();
      return snap(r.exists ? r.data() : null, r.exists);
    },
    async set(value: Record<string, unknown>): Promise<void> {
      await db.doc(docPath(p)).set(value);
    },
    async update(updates: Record<string, unknown>): Promise<void> {
      const entries = Object.entries(updates);
      for (let i = 0; i < entries.length; i += 450) {
        const batch = db.batch();
        for (const [rel, val] of entries.slice(i, i + 450)) {
          const full = [p, rel].filter(Boolean).join('/');
          const segs = full.split('/').filter(Boolean);
          if (segs.length === 5 && segs[0] === 'schools') {
            const ref = db.doc(segs.slice(0, 4).join('/'));
            val === null ? batch.update(ref, { [segs[4]]: FieldValue.delete() }) : batch.update(ref, { [segs[4]]: val });
          } else {
            const ref = db.doc(docPath(full));
            val === null ? batch.delete(ref) : batch.set(ref, val as Record<string, unknown>);
          }
        }
        await batch.commit();
      }
    },
    async remove(): Promise<void> { await db.doc(docPath(p)).delete(); },
    async transaction(fn: (cur: unknown) => unknown): Promise<{ committed: boolean; snapshot: Snap }> {
      return db.runTransaction(async t => {
        const ref = db.doc(docPath(p));
        const cur = await t.get(ref);
        const next = fn(cur.exists ? cur.data() : null);
        if (next === undefined) return { committed: false, snapshot: snap(cur.exists ? cur.data() : null, cur.exists) };
        next === null ? t.delete(ref) : t.set(ref, next as Record<string, unknown>);
        return { committed: true, snapshot: snap(next, next !== null) };
      });
    },
  };
}

export function list(s: Snap): Values[] {
  const v = s.val();
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v).map(([id, item]) => ({ id, ...record(item) }));
}

export function byId(rows: Values[]): Map<string, Values> {
  return new Map(rows.map(r => [String(r['id']), r]));
}

export function sortBy(rows: Values[], key: string): Values[] {
  return rows.sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? ''), 'es-MX'));
}

// ── Mail ─────────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function emailHtml(title: string, content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#f6f7fb;font-family:Arial,sans-serif"><div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden"><h1 style="margin:0;padding:28px;background:#2A7BE4;text-align:center;color:#fff;font-size:22px">${escapeHtml(title)}</h1><div style="padding:32px;line-height:1.6">${content}</div><p style="padding:16px;text-align:center;background:#f6f7fb;color:#8a93a6;font-size:12px">Sistema Escolar Aula</p></div></body></html>`;
}

export async function sendEmail(to: string, subject: string, html: string, textBody: string): Promise<void> {
  const host = process.env['SMTP_HOST']!;
  const port = Number(process.env['SMTP_PORT'] ?? 465);
  const user = process.env['SMTP_USER']!;
  const pass = process.env['SMTP_PASSWORD']!;
  const from = process.env['SMTP_FROM'] || user;
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  try {
    await transport.sendMail({ from, to, subject, html, text: textBody });
  } finally {
    transport.close();
  }
}
