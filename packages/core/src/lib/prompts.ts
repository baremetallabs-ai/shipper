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
import setupRemediatePrompt from '../prompts/claude/setup_remediate.md';

import codexNewPrompt from '../prompts/codex/new.md';
import codexGroomPrompt from '../prompts/codex/groom.md';
import codexDesignPrompt from '../prompts/codex/design.md';
import codexPlanPrompt from '../prompts/codex/plan.md';
import codexImplementPrompt from '../prompts/codex/implement.md';
import codexPrOpenPrompt from '../prompts/codex/pr_open.md';
import codexPrReviewPrompt from '../prompts/codex/pr_review.md';
import codexPrRemediatePrompt from '../prompts/codex/pr_remediate.md';
import codexUnblockPrompt from '../prompts/codex/unblock.md';
import codexSetupPrompt from '../prompts/codex/setup.md';
import codexSetupRemediatePrompt from '../prompts/codex/setup_remediate.md';

import copilotNewPrompt from '../prompts/copilot/new.md';
import copilotGroomPrompt from '../prompts/copilot/groom.md';
import copilotDesignPrompt from '../prompts/copilot/design.md';
import copilotPlanPrompt from '../prompts/copilot/plan.md';
import copilotImplementPrompt from '../prompts/copilot/implement.md';
import copilotPrOpenPrompt from '../prompts/copilot/pr_open.md';
import copilotPrReviewPrompt from '../prompts/copilot/pr_review.md';
import copilotPrRemediatePrompt from '../prompts/copilot/pr_remediate.md';
import copilotUnblockPrompt from '../prompts/copilot/unblock.md';
import copilotSetupPrompt from '../prompts/copilot/setup.md';
import copilotSetupRemediatePrompt from '../prompts/copilot/setup_remediate.md';

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
    'setup_remediate.md': setupRemediatePrompt,
  },
  codex: {
    'new.md': codexNewPrompt,
    'groom.md': codexGroomPrompt,
    'design.md': codexDesignPrompt,
    'plan.md': codexPlanPrompt,
    'implement.md': codexImplementPrompt,
    'pr_open.md': codexPrOpenPrompt,
    'pr_review.md': codexPrReviewPrompt,
    'pr_remediate.md': codexPrRemediatePrompt,
    'unblock.md': codexUnblockPrompt,
    'setup.md': codexSetupPrompt,
    'setup_remediate.md': codexSetupRemediatePrompt,
  },
  copilot: {
    'new.md': copilotNewPrompt,
    'groom.md': copilotGroomPrompt,
    'design.md': copilotDesignPrompt,
    'plan.md': copilotPlanPrompt,
    'implement.md': copilotImplementPrompt,
    'pr_open.md': copilotPrOpenPrompt,
    'pr_review.md': copilotPrReviewPrompt,
    'pr_remediate.md': copilotPrRemediatePrompt,
    'unblock.md': copilotUnblockPrompt,
    'setup.md': copilotSetupPrompt,
    'setup_remediate.md': copilotSetupRemediatePrompt,
  },
};
