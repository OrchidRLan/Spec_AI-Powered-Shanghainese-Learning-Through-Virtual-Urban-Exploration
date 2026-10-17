import content from '../../../content/batch-bc.json';
import type { LearningEntry } from '../components/LearningText';
import type { LessonStationId, Locale } from './api';

type Bilingual = Record<Locale, string>;
export type StationPlan = {
  id: LessonStationId; title: Bilingual; shortTitle: Bilingual; theme: Bilingual; description: Bilingual; completion: Bilingual;
  completedEntryId: string; reviewEntryIds: string[];
  steps: Array<{id: string; title: Bilingual; hostEntryId: string | null; options: Array<{id: string; entryId: string}>; summaryEntryIds?: Record<string, string | undefined>}>;
  items: Array<{id: string; title: Bilingual; description: Bilingual; entryId: string}>;
};
export const stationEntries = content.entries as LearningEntry[];
export const stationPlans: StationPlan[] = content.stationPlans.map(plan=>({
  ...plan, id: plan.id as LessonStationId, shortTitle: plan.title, theme: plan.taskTitle, description: plan.taskDescription,
  completion: stationEntries.find(entry=>entry.id === plan.completionEntryId)?.meaning || plan.taskDescription,
  completedEntryId: plan.completionEntryId,
  items: plan.id === 'restaurant' ? content.dishes : plan.id === 'candy' ? content.flavors : [],
}));
export function stationPlanFor(id: string): StationPlan { return stationPlans.find(plan=>plan.id === id)!; }
export function stationEntryFor(id: string | null | undefined): LearningEntry | undefined { return stationEntries.find(entry=>entry.id === id); }
export function stationSummary(id: LessonStationId, answers: Record<string, string>, locale: Locale): string {
  const plan = stationPlanFor(id);
  if (id === 'restaurant') return [answers.preference ? (locale === 'zh' ? '不辣' : 'Non-spicy') : '', plan.items.find(item=>item.id === answers.dish)?.title[locale]].filter(Boolean).join(' · ');
  if (id === 'candy') return [plan.items.find(item=>item.id === answers.flavor)?.title[locale], answers.quantity === 'two_packs' ? (locale === 'zh' ? '两包' : 'Two packs') : ''].filter(Boolean).join(' · ');
  return plan.steps.filter(step=>answers[step.id]).map(step=>stationEntryFor(step.options.find(option=>option.id === answers[step.id])?.entryId)?.meaning[locale]).filter(Boolean).join(' · ');
}
export function completedAttemptFor(attempts: import('./api').Attempt[], station: string) {
  return [...attempts].reverse().find(attempt=>attempt.station_id === station && attempt.status === 'completed');
}
