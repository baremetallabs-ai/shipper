import newPrompt from '../prompts/new.md';
import groomPrompt from '../prompts/groom.md';
import designPrompt from '../prompts/design.md';
import planPrompt from '../prompts/plan.md';
import implementPrompt from '../prompts/implement.md';
import prOpenPrompt from '../prompts/pr_open.md';
import prReviewPrompt from '../prompts/pr_review.md';
import prRemediatePrompt from '../prompts/pr_remediate.md';
import unblockPrompt from '../prompts/unblock.md';

export const prompts: Record<string, string> = {
  'new.md': newPrompt,
  'groom.md': groomPrompt,
  'design.md': designPrompt,
  'plan.md': planPrompt,
  'implement.md': implementPrompt,
  'pr_open.md': prOpenPrompt,
  'pr_review.md': prReviewPrompt,
  'pr_remediate.md': prRemediatePrompt,
  'unblock.md': unblockPrompt,
};
