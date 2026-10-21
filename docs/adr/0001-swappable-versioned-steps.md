# Steps are swappable, versioned side by side, and talk only through GitHub state

The factory is meant to keep changing in ways we can't predict yet, while projects already using it keep working and still get every fix. So each stage of the pipeline is a Step with numbered Step versions (`review@1`, `review@2`). All versions ship together in one release, and each project pins a version per step in its config. A bug fix edits the existing version in place, so every project on it gets the fix with no backport. A new version is added only when the step's contract or behaviour breaks. An old version is deprecated first and removed only in a factory major. Steps never call each other: each one reads and leaves state on GitHub (labels, claim comment, branch, PR, statuses, review threads) plus a run folder. That way a step can be a script, an agent or a person, and a project can supply its own local step.

## Considered Options

- A tag or branch per step major, as GitHub Actions does: rejected, because every fix would need a backport to each live major.
- Versioning only the whole factory: rejected, because a project could not stay on an old review step while taking a new merge step.
- An in-process typed API between steps: rejected, because it locks steps into one runtime and breaks resume-from-GitHub.

## Consequences

- The shared runtime must stay compatible with every live step version, so the factory's CI runs a contract test per live version.
- Every paper trail records the factory release, the resolved config and the `step@version` that ran, so the performance review can compare projects that differ by one step.
