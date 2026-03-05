import safePush from '../scripts/safe-push.sh';
import installDeps from '../scripts/install-deps.sh';
import ghApiGetReviews from '../scripts/gh-api-get-reviews.sh';
import ghApiReplyThread from '../scripts/gh-api-reply-thread.sh';
import ghApiGetPrFiles from '../scripts/gh-api-get-pr-files.sh';
import ghApiGetUser from '../scripts/gh-api-get-user.sh';
import ghApiPostReview from '../scripts/gh-api-post-review.sh';

export const scripts: Record<string, string> = {
  'safe-push.sh': safePush,
  'install-deps.sh': installDeps,
  'gh-api-get-reviews.sh': ghApiGetReviews,
  'gh-api-reply-thread.sh': ghApiReplyThread,
  'gh-api-get-pr-files.sh': ghApiGetPrFiles,
  'gh-api-get-user.sh': ghApiGetUser,
  'gh-api-post-review.sh': ghApiPostReview,
};
