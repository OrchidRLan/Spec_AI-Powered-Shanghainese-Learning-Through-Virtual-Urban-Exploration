import confirmationContent from '../../../content/nanxiang-confirmations-r4.json';
import type { Order } from './api';
import type { LearningEntry } from '../components/LearningText';

type SavedOrder = Pick<Order, 'item' | 'normalized_servings' | 'quantity' | 'takeaway'>;

/** A draft sentence may describe only a complete, normalized saved order. */
export function orderConfirmationFor(order: SavedOrder): LearningEntry | null {
  if (order.item !== 'xiaolongbao' || typeof order.takeaway !== 'boolean'
    || !Number.isInteger(order.normalized_servings)
    || ![1, 2, 3].includes(order.normalized_servings as number)) return null;
  return confirmationContent.dialogues.find(entry => entry.order.item === order.item
    && entry.order.normalized_servings === order.normalized_servings
    && entry.order.takeaway === order.takeaway) ?? null;
}
