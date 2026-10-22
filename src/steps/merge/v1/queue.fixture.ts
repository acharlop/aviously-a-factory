import type { Check, Need, Verdict } from "../../../runtime/checks.ts";
import { markerOf } from "../../../runtime/markers.ts";
import type { SignOff } from "../../file/v1/sign-off.ts";
import type { Built, Pr, QueueDeps, Reason } from "./queue.ts";
import type { Removals } from "./removals.ts";

export const pr = (number: number, overrides: Partial<Pr> = {}): Pr => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/app/pull/${number}`,
  headRefName: `topic/${number}`,
  headRefOid: `head${number}`,
  enabledAt: `2026-10-12T0${number}:00:00Z`,
  labels: [],
  ...overrides,
});

export const VERIFIED = markerOf("checks");

const fakeCheck = (name: string, command: string, tries: number, marker = false): Check => ({
  name,
  command,
  timeout: "TIMEOUT_VERIFY",
  tries,
  marker,
  needs: async () => undefined,
  run: async () => ({ failed: [] }),
});

// A fake GitHub and queue checkout with three checks: `checks` runs whole, `web` runs the specs each head selects with one rerun, `device` runs the flows each head reaches with up to three runs, where this machine can. Main is named by what landed on it ("m+1+2"); a commit's tree is main plus the pull requests merged onto it, and its sha is "s:" and its tree, so building the same heads twice makes the same commits.
export function queue({
  prs = [pr(1)] as Pr[],
  specs = {} as Record<number, string[]>,
  conflictsWithMain = [] as number[],
  conflictsWithEarlier = [] as number[],
  breaksVerify = [] as number[],
  breaksSpec = {} as Record<number, string>,
  flakyRuns = 0,
  landing = {} as Record<number, Awaited<ReturnType<QueueDeps["land"]>>[]>,
  merging = {} as Record<number, Awaited<ReturnType<QueueDeps["merged"]>>[]>,
  mainMovesAfterLanding = false,
  /** Merged on GitHub by someone else while this run runs web, or while it waits on GitHub, which then answers "behind". */
  mergedOutside = {} as Record<number, "web" | "waiting">,
  markers = new Map<string, string>(),
  removes = {} as Record<number, Partial<Removals>>,
  /** Each pull request's review blockers; none by default. */
  reviews = {} as Record<number, string[]>,
  /** The flows each pull request reaches; none by default. */
  flows = {} as Record<number, string[]>,
  /** This machine's device runs in turn, when it can run them; a run past the list passes. */
  device = undefined as Verdict[] | undefined,
} = {}) {
  let main = "m";
  const open = [...prs];
  const ran: string[] = [];
  const dropped: { number: number; reason: Reason }[] = [];
  const lines: string[] = [];
  const flaky: { unit: string; prs: readonly number[] }[] = [];
  const failed: string[] = [];
  const records: SignOff[] = [];
  let flakes = flakyRuns;
  const onGitHub = new Set<number>();
  const mergeOnGitHub = (number: number) => {
    onGitHub.add(number);
    open.splice(
      open.findIndex((queued) => queued.number === number),
      1,
    );
    main = `${main}+${number}`;
  };
  const mergeOutside = (when: "web" | "waiting") => {
    for (const [number, at] of Object.entries(mergedOutside))
      if (at === when && !onGitHub.has(Number(number))) mergeOnGitHub(Number(number));
  };
  const inside = (sha: string) =>
    sha
      .split("+")
      .slice(1)
      .map(Number)
      .filter((n) => Number.isFinite(n));
  const commit = (tree: string) => ({ sha: `s:${tree}`, tree });

  const verify = fakeCheck("checks", "pnpm verify", 1, true);
  const web = { ...fakeCheck("web", "e2e", 2), flaky: (found) => flaky.push(...found) } as Check;
  const onDevice: Check = {
    ...fakeCheck("device", "flows", 3),
    unavailable: () => (device ? undefined : "it runs no device flows (studio does)"),
    describe: (units) =>
      units.length > 0 ? `flows passed: ${units.join(", ")}` : "no flow reached",
  };
  const need = (units: readonly string[] | undefined): Need =>
    units?.length ? { units } : undefined;

  const deps: QueueDeps = {
    log: (line) => lines.push(line),
    checks: [verify, web, onDevice],
    markers: {
      read: (marker) => markers.get(marker),
      write: (marker, content) => markers.set(marker, content),
    },
    fetchMain: () => main,
    queued: () => [...open],
    reviews: (pr) => reviews[pr.number] ?? [],
    removals: (pr) => ({ scripts: [], files: [], label: "removal-ok", ...removes[pr.number] }),
    mergeMain: async (pr, onto) => {
      ran.push(`merge #${pr.number} onto ${onto}`);
      if (conflictsWithMain.includes(pr.number)) return { conflict: "conflicts with main in a.ts" };
      return {
        pr,
        ...commit(`${onto}+${pr.number}`),
        needs: new Map([
          ["checks", { units: [] }],
          ["web", need(specs[pr.number])],
          ["device", need(flows[pr.number])],
        ]),
      };
    },
    testBranch: (onto, built) => {
      let tree = onto;
      const trees: string[] = [];
      const left: Built[] = [];
      for (const step of built) {
        if (conflictsWithEarlier.includes(step.pr.number) && built.length > 1) left.push(step);
        else trees.push((tree = `${tree}+${step.pr.number}`));
      }
      return { tip: commit(tree).sha, trees, left };
    },
    runCheck: async (check, sha, _main, units, attempt) => {
      if (check === verify) {
        ran.push(`verify ${sha}`);
        return { failed: inside(sha).some((n) => breaksVerify.includes(n)) ? ["checks"] : [] };
      }
      if (check === web) {
        ran.push(`specs ${sha} ${units.join(" ")}`);
        mergeOutside("web");
        if (flakes > 0) {
          flakes--;
          return { failed: units };
        }
        const broken = inside(sha).flatMap((n) => (breaksSpec[n] ? [breaksSpec[n]] : []));
        return { failed: units.filter((spec) => broken.includes(spec)) };
      }
      ran.push(`flows ${sha} ${units.join(" ")} (attempt ${attempt})`);
      return device?.shift() ?? { failed: [], notRun: [] };
    },
    record: (signOff) => records.push(signOff),
    failed: (pr, check, description) => failed.push(`#${pr.number} ${check.name}: ${description}`),
    land: async (built) => {
      ran.push(`land ${built.sha}`);
      return landing[built.pr.number]?.shift() ?? "landed";
    },
    merged: async (pr) => {
      if (mergedOutside[pr.number] === "waiting") {
        mergeOutside("waiting");
        return "behind";
      }
      const outcome = merging[pr.number]?.shift() ?? "merged";
      if (outcome === "merged") {
        mergeOnGitHub(pr.number);
        if (mainMovesAfterLanding) main = `${main}+99`;
      }
      if (outcome === "dequeued")
        open.splice(
          open.findIndex(({ number }) => number === pr.number),
          1,
        );
      return outcome;
    },
    state: (pr) => (onGitHub.has(pr.number) ? "merged" : "open"),
    drop: (pr, reason) => {
      dropped.push({ number: pr.number, reason });
      open.splice(
        open.findIndex(({ number }) => number === pr.number),
        1,
      );
    },
  };
  return { deps, ran, dropped, lines, markers, flaky, failed, records };
}
