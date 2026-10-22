# Modes

How much a person watches a shift, and what that changes in the steps of [SKILL.md](SKILL.md). The pipeline is the same in every mode; what changes is who answers questions, who pushes, and whether auto-merge goes on.

|                | Supervised                           | Unsupervised                           | Lights-out                      |
| -------------- | ------------------------------------ | -------------------------------------- | ------------------------------- |
| Who is there   | A person watches the session         | A person started it and may look in    | Nobody: the runner started it   |
| Open questions | Asked in the session                 | On the ticket, and said in the session | On the ticket; parked           |
| Push           | After a person's yes, auto-merge off | Rework pushes, auto-merge on           | Rework pushes, auto-merge on    |
| `RUN_COUNT`    | You bump it                          | You bump it                            | The runner bumped it            |
| Ends           | The person says drain, or the shift  | The person says drain, or the shift    | The shift (SKILL.md, The shift) |

A shift you bump yourself: add one to `RUN_COUNT` in `~/.factory/<project>/state` before step 1, creating the file with `RUN_COUNT=1` when it's missing. A lights-out shift's prompt says the runner started it.

## Supervised

- **Rules for this shift.** The person may say at the start which calls you may make yourself that this skill otherwise parks or waits on. None without that. Each one made goes under calls, with who gave the rule and when.
- **Questions.** Ask each in the session as a plain message the moment it comes up, one question per message, with its options and a recommendation, and act on the answer at your next turn. `AskUserQuestion` stops the pipeline until someone answers, so ask in text. A money, data, legal or schema question also goes on the ticket as a comment.
- **Rework.** With nothing confirmed, record "Reviewed at `<head sha>`" yourself, as a comment of its own.
- **Push.** Ask to push, listing every branch that is ready, all in one ask. On a yes, `pnpm factory push <n> --auto-merge off` per branch: the person turns auto-merge on for each they want queued. When rework changed strings, the copy desk runs again first.
- **Report.** Also hand back in the session per ticket: its PR or branch and status, the calls made, the follow-ups filed and proposed, and a "for later, not blocking" list.

## Unsupervised

- **Rules for this shift.** As supervised.
- **Questions.** Comment each on the ticket the moment it comes up, with its options and a recommendation, and say it in the session as a plain message; keep the rest of the pipeline moving and read the session at each turn for an answer. Still unanswered at the drain: a money, data, legal or schema ticket is parked, a removal's PR stays up without auto-merge, and both go in the memo.
- **Rework and push.** The rework temp's brief says to push with `auto-merge: on`; with nothing confirmed, you run `pnpm factory push <n> --auto-merge on`. A PR with an unexplained removal goes up with auto-merge off.
- **Drain.** "Drain" claims nothing new, finishes what is in flight, then step 10.

## Lights-out

- **Nobody answers.** Never ask; never wait. A money, data, legal or schema question is commented on the ticket and parked at once. An unexplained removal's PR goes up with auto-merge off. Both go in the memo.
- **Rework and push.** As unsupervised.
- **The cap.** The runner stops the shift and everything it started, the queue included, at the cap, so the last 20 minutes are for step 10 (SKILL.md, The shift).
