import type { Attempt, Session } from './api';

const FALLBACK_STORAGE = 'shanghai-speech-fallbacks-r2';
const QUESTION_STORAGE = 'shanghai-question-cursors-r2';
const EDIT_STORAGE = 'shanghai-order-edit-r2';
export type QuestionCursor = { signature: string; key: string };

/** A clarification remains the same question. A revised confirmation is a new one. */
export function questionKeyFor(attempt: Pick<Attempt, 'id' | 'summary_revision'> | null, focus: string, editing = false): string {
  if (!attempt) return '';
  return `${attempt.id}:${editing ? 'edit:' : ''}${focus}${focus === 'confirm' ? `:${attempt.summary_revision ?? 'pending'}` : ''}`;
}

/** Re-entering a question starts a fresh speaking attempt; retries keep their cursor. */
export function cursorForQuestion(attempt: Pick<Attempt, 'id' | 'revision' | 'summary_revision'> | null, focus: string, editing: boolean, previous?: QuestionCursor): QuestionCursor {
  const signature = questionKeyFor(attempt, focus, editing);
  return previous?.signature === signature ? previous : { signature, key: signature ? `${signature}:from-${attempt!.revision}` : '' };
}

export function readQuestionCursors(): Record<string, QuestionCursor> {
  try {
    const value = JSON.parse(sessionStorage.getItem(QUESTION_STORAGE) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, cursor]) => Boolean(cursor && typeof cursor === 'object' && 'signature' in cursor && 'key' in cursor && typeof cursor.signature === 'string' && typeof cursor.key === 'string'))) as Record<string, QuestionCursor>;
  } catch { return {}; }
}

export function saveQuestionCursors(cursors: Record<string, QuestionCursor>): void {
  try { sessionStorage.setItem(QUESTION_STORAGE, JSON.stringify(cursors)); } catch { /* Memory keeps the active question usable. */ }
}

export function readOrderEdit(attempt: Pick<Attempt, 'id' | 'status' | 'summary_revision'> | null): { focus: 'quantity' | 'mode' | null; summary: number | null } | null {
  if (!attempt || attempt.status === 'completed' || attempt.status === 'skipped') return null;
  try {
    const edit = JSON.parse(sessionStorage.getItem(`${EDIT_STORAGE}:${attempt.id}`) || 'null');
    if (!edit || ![null, 'quantity', 'mode'].includes(edit.focus)) return null;
    if (attempt.summary_revision !== null && edit.summary !== attempt.summary_revision) return null;
    return edit;
  } catch { return null; }
}

export function saveOrderEdit(id: string, edit: { focus: string | null; summary: number | null } | null): void {
  try {
    if (edit) sessionStorage.setItem(`${EDIT_STORAGE}:${id}`, JSON.stringify(edit));
    else sessionStorage.removeItem(`${EDIT_STORAGE}:${id}`);
  } catch { /* Editing remains available when storage is blocked. */ }
}

export function readFallbacks(): Record<string, boolean> {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(FALLBACK_STORAGE) || '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter(([key, value]) => key.length < 200 && value === true));
  } catch { return {}; }
}

export function writeFallback(current: Record<string, boolean>, key: string): Record<string, boolean> {
  if (!key) return current;
  const next = { ...current, [key]: true };
  try { sessionStorage.setItem(FALLBACK_STORAGE, JSON.stringify(next)); } catch { /* In-memory fallback still works. */ }
  return next;
}

export function canReviewNanxiang(session: Pick<Session, 'completed_station_ids'> | null): boolean {
  return Boolean(session?.completed_station_ids.includes('nanxiang'));
}
