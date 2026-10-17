export type Locale = 'zh' | 'en';
export type Order = { item: string | null; quantity: number | null; unit: 'serving' | 'basket' | 'piece' | 'unknown' | null; normalized_servings: number | null; takeaway: boolean | null };
export type PracticeStep = 'item' | 'quantity' | 'mode' | 'confirm';
export type PracticeResult = { request_id: string; transcript: string | null; status: 'correct' | 'incorrect' | 'unrecognized' | 'technical'; reason: string; channel: 'voice' | 'technical'; reported_by: 'server' | 'client' };
export type Practice = { step: PracticeStep; step_id: string; target: Action | null; result: PracticeResult | null; can_choose: boolean };
export type Attempt = { id: string; station_id: string; status: 'collecting' | 'confirming' | 'completed' | 'skipped'; revision: number; order: Order; unresolved_issues: string[]; summary_revision: number | null; confirmed_revision: number | null; prompt_id: string; pending_request_id: string | null; metrics: { voice_attempts: number; help_used: number }; turns: unknown[]; created_at: string; updated_at: string; practice?: Practice | null };
export type Session = { id: string; locale: Locale; show_romanization: boolean; reduced_motion: boolean; attempts: Attempt[]; completed_station_ids: string[]; services: { text: string; asr: string }; content_version: string; rule_version: string };
export type Action = { type: 'set_order'; item?: string; quantity?: number; unit?: string; takeaway?: boolean } | { type: 'confirm' | 'repeat' };
export type TurnRequest = { request_id: string; expected_revision: number; channel: 'buttons' | 'text' | 'voice' | 'voice_edited'; asr_request_id?: string; action?: Action; text?: string; summary_revision?: number | null };
export type TurnResult = { request_id: string; status: string; attempt: Attempt; interpretation_source: string; speech_feedback?: { outcome: 'accepted' | 'retry'; reason: 'understood' | 'unrecognized' | 'needs_clarification' | 'repeat_requested' | 'confirmation_required' } | null };
export type PracticeRequest = { request_id: string; expected_revision: number; operation: 'select' | 'evaluate' | 'continue' | 'edit'; action?: Action; text?: string; asr_request_id?: string; failure_kind?: 'recognition' | 'technical'; assisted?: boolean; result_request_id?: string; step?: Exclude<PracticeStep, 'confirm'> };
export type PracticeResponse = { request_id: string; status: 'applied' | 'cancelled'; attempt: Attempt };
export class ApiError extends Error {
  constructor(public code: string, message: string, public attempt?: Attempt, public terminal = false, public retryable = false) { super(message); }
}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.detail;
    throw new ApiError(detail?.code || `http_${response.status}`, typeof detail === 'string' ? detail : detail?.message || 'Request failed', detail?.attempt, detail?.terminal === true, detail?.retryable === true);
  }
  return body as T;
}
export const post = <T,>(path: string, body: unknown, signal?: AbortSignal) => api<T>(path, { method: 'POST', body: JSON.stringify(body), signal });
