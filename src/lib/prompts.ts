import newPrompt from '../prompts/claude/new.md';
import groomPrompt from '../prompts/claude/groom.md';
import designPrompt from '../prompts/claude/design.md';
import planPrompt from '../prompts/claude/plan.md';
import implementPrompt from '../prompts/claude/implement.md';
import prOpenPrompt from '../prompts/claude/pr_open.md';
import prReviewPrompt from '../prompts/claude/pr_review.md';
import prRemediatePrompt from '../prompts/claude/pr_remediate.md';
import unblockPrompt from '../prompts/claude/unblock.md';
import setupPrompt from '../prompts/claude/setup.md';

export const agentPrompts: Record<string, Record<string, string>> = {
  claude: {
    'new.md': newPrompt,
    'groom.md': groomPrompt,
    'design.md': designPrompt,
    'plan.md': planPrompt,
    'implement.md': implementPrompt,
    'pr_open.md': prOpenPrompt,
    'pr_review.md': prReviewPrompt,
    'pr_remediate.md': prRemediatePrompt,
    'unblock.md': unblockPrompt,
    'setup.md': setupPrompt,
  },
};
