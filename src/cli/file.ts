import { loadProject } from "../config/load.ts";
import { fileMemo } from "../steps/file/v1/memo.ts";
import { type Filing, filing } from "../steps/file/v1/record.ts";
import { fileSuggestions, readReviews, recordReview } from "../steps/file/v1/suggestion-box.ts";
import { fileTimesheet } from "../steps/file/v1/timesheet.ts";
import { reviewDue as reviewDueAt } from "../steps/performance-review/v1/step.ts";

/** A command that files one kind of record through the project's file step. */
const filed =
  (file: (args: readonly string[], where: Filing) => number) =>
  async (args: string[]): Promise<number> => {
    const where = filing(await loadProject());
    if (typeof where === "string") {
      console.log(where);
      return 0;
    }
    return file(args, where);
  };

export const timesheet = filed(fileTimesheet);
export const memo = filed(fileMemo);
export const suggestionBox = filed(fileSuggestions);

/** `factory review-due`: `due` when no performance review was recorded in the last 20 hours, else when the last one was. */
export const reviewDue = filed((_args, { trail, sh }) => {
  console.log(reviewDueAt(readReviews(trail, sh).at(-1)?.at, Date.now()));
  return 0;
});

/** `factory review-done --through <entry> [<pr-url>...]`: records a performance review, the box entries it read through and the PRs it opened. */
export const reviewDone = filed((args, where) => {
  const [flag, through, ...prs] = args;
  if (flag !== "--through" || !through || prs.some((pr) => !/^https:\/\/github\.com\//.test(pr))) {
    console.log("usage: factory review-done --through <entry> [<pr-url>...]");
    return 2;
  }
  const review = recordReview(through, prs, where);
  console.log(`performance review recorded: ${review.at}, through ${through}, ${prs.length} PRs`);
  return 0;
});
