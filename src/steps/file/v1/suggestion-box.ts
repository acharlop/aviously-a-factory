import { existsSync, readFileSync } from "node:fs";

import type { PaperTrail } from "../../../config/schema.ts";
import type { Exec } from "../../../runtime/exec.ts";
import { ghJson } from "../../../runtime/github.ts";
import { shiftCount } from "../../../runtime/machine.ts";
import { type Filing, localDate, localTime, type Stamp } from "./record.ts";
import { readFile, saveFile } from "./repo.ts";

/** One performance review, a line of `reviews.jsonl`: the box entries it read through, and the PRs it opened. */
export type Review = Stamp & { at: string; through: string; prs: string[] };

const reviewsPath = (trail: PaperTrail) => `${trail.suggestionBox}/reviews.jsonl`;

/** Where a shift's notes land: a folder per day, named so that paths sort in the order they were dropped. */
export const entryPath = (trail: PaperTrail, at: Date, machine: string, shift: number) =>
  `${trail.suggestionBox}/${localDate(at)}/${localTime(at).replace(":", "")}-${machine}-shift${shift}.md`;

export const parseReviews = (text: string): Review[] =>
  text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Review);

export const readReviews = (trail: PaperTrail, sh: Exec) =>
  parseReviews(readFile(trail.repo, reviewsPath(trail), sh)?.content ?? "");

/** Every entry in the box, oldest first. */
export function entries(trail: PaperTrail, sh: Exec): string[] {
  const { tree } = ghJson<{ tree: { path: string; type: string }[] }>(
    ["api", `repos/${trail.repo}/git/trees/HEAD?recursive=1`],
    sh,
  );
  const inBox = new RegExp(`^${trail.suggestionBox}/\\d{4}-\\d{2}-\\d{2}/[^/]+\\.md$`);
  return tree
    .filter(({ path, type }) => type === "blob" && inBox.test(path))
    .map(({ path }) => path)
    .sort();
}

/** The entries dropped after the last review read through, oldest first. */
export const unreviewed = (all: readonly string[], reviews: readonly Review[]) => {
  const through = reviews.at(-1)?.through ?? "";
  return all.filter((path) => path > through);
};

/** Drops the shift's notes in the box, stamped; a rerun of the same shift replaces its entry. */
export function drop(notes: string, filing: Filing, at = new Date()): string {
  const { trail, stamp, sh } = filing;
  const shift = shiftCount(filing.project, filing.home);
  const path = entryPath(trail, at, stamp.machine, shift);
  const header = `<!-- ${stamp.person} on ${stamp.machine}, shift ${shift}, ${stamp.step}, factory ${stamp.factory} -->`;
  saveFile(
    trail.repo,
    path,
    () => `${header}\n\n${notes.trim()}\n`,
    `Suggestion box: ${localDate(at)} ${stamp.person}@${stamp.machine} shift ${shift}`,
    sh,
  );
  return path;
}

/** Records a performance review: what it read through and the PRs it opened. */
export function recordReview(
  through: string,
  prs: readonly string[],
  filing: Filing,
  at = new Date(),
): Review {
  const { trail, stamp, sh } = filing;
  const review: Review = { ...stamp, at: at.toISOString(), through, prs: [...prs] };
  saveFile(
    trail.repo,
    reviewsPath(trail),
    (current) =>
      `${current}${current && !current.endsWith("\n") ? "\n" : ""}${JSON.stringify(review)}\n`,
    `Performance review: ${localDate(at)} ${stamp.person}@${stamp.machine}`,
    sh,
  );
  return review;
}

const USAGE = "usage: factory suggestion-box drop <notes.md> | list";

/** `factory suggestion-box drop <notes.md>` drops a shift's notes in the box; `list` prints the entries no review has read yet. */
export function fileSuggestions([what, file, ...rest]: readonly string[], filing: Filing): number {
  if (what === "drop" && file && rest.length === 0) {
    if (!existsSync(file)) {
      console.log(`no notes at ${file}; nothing dropped`);
      return 0;
    }
    const notes = readFileSync(file, "utf8");
    if (!notes.trim()) {
      console.log(`${file} is empty; nothing dropped`);
      return 0;
    }
    const path = drop(notes, filing);
    console.log(`suggestion box: https://github.com/${filing.trail.repo}/blob/HEAD/${path}`);
    return 0;
  }
  if (what === "list" && !file) {
    const { trail, sh } = filing;
    const fresh = unreviewed(entries(trail, sh), readReviews(trail, sh));
    console.log(`# through: ${fresh.at(-1) ?? "-"}`);
    for (const path of fresh) {
      console.log(`## ${path}`);
      console.log(readFile(trail.repo, path, sh)?.content.trim() ?? "");
    }
    return 0;
  }
  console.log(USAGE);
  return 2;
}
