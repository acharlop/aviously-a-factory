# Aviously, a Factory

A software factory: agents that take a project's tickets to merged PRs, with people in the loop only where a decision is theirs. One factory serves many projects.

## Language

**Factory**:
The generic pipeline and its rules, shared by every project that installs it.
_Avoid_: babysit, yarcone-factory, fanout

**Project**:
A repository the factory works on, which declares its own specifics and nothing the factory already owns.
_Avoid_: consumer, repo, app

**Core**:
What every project gets: tickets, claims, agents, review, the merge queue, the paper trail.
_Avoid_: base, layer

**Module**:
An optional capability a project switches on, such as mobile, end-to-end specs or translations.
_Avoid_: plugin, lane, extension

**Check**:
One verdict the gate reports on a change, such as web or mobile.
_Avoid_: lane, signoff lane

**Onboarding**:
Setting a project up for the factory for the first time.
_Avoid_: install, agent layer, bootstrap

## Tickets

**Department**:
A part of a project's codebase that tickets and branches are filed under, such as web, mobile or api.
_Avoid_: area, scope, package

**Kind**:
What sort of work a ticket is: feature, bug, debt, security or tooling.
_Avoid_: type, category

**Recall**:
A ticket that fixes or undoes something the factory shipped.
_Avoid_: factory-escape, regression

**Odd jobs**:
A standing ticket that collects small chores of one sort, such as cleanups or flaky specs, until it is worth a shift.
_Avoid_: batch ticket

## Work

**Shift**:
A session that works the tickets its filter admits, in one mode, until it runs out of tickets or time.
_Avoid_: lane, run, loop, wave

**Rota**:
The ordered list of shifts a machine works through in turn.
_Avoid_: schedule, rotation, plan

**Mode**:
How much a person watches a shift: supervised, unsupervised or lights-out.
_Avoid_: careful, autopilot, conductor, lane

**Meeting**:
A session that cannot happen without a person present, where tickets get decided.
_Avoid_: decide lane, triage session

**Water cooler**:
A slow conversation on a ticket held in comments, one person's turn at a time.
_Avoid_: discuss, to-discuss lane

**Lost and found**:
A session that revisits blocked and parked tickets to see whether they can move again.
_Avoid_: sweep

**Foreman**:
The session that runs a shift: it assigns tickets, watches agents and decides when work is pushed, but builds nothing itself.
_Avoid_: lead, conductor, orchestrator

**Temp**:
A fresh agent hired for one job on one ticket, with no memory of earlier jobs.
_Avoid_: coder, worker, subagent

**Inspector**:
An agent that judges a change along one axis, such as spec, standards, security or looks.
_Avoid_: reviewer, ui-reviewer

**Copy desk**:
The agent that settles a change's final English and its translations.
_Avoid_: strings agent, translator

**Receptionist**:
The agent that gives each untriaged ticket its route.
_Avoid_: triager

**Consultant**:
An agent that produces a plan and writes no code.
_Avoid_: architect

**Intern**:
An agent that goes and finds facts, with sources.
_Avoid_: researcher

**Lunch break**:
A slot in a rota where the machine deliberately does nothing.
_Avoid_: pause, cooldown, idle

**Reality check**:
Checking a ready ticket's claims against main before anyone claims it.
_Avoid_: preflight

**Step**:
One stage a ticket passes through on its way to merged, such as claim, build, review or merge.
_Avoid_: stage, phase, lane

**Step version**:
One numbered implementation of a step, which a project pins, such as review@2.
_Avoid_: variant, strategy, flavour

**Quality control**:
The step where inspectors judge a change before it is pushed.
_Avoid_: review, code review

**Rework**:
A temp fixing what quality control found, once per change.
_Avoid_: fix round

**File**:
The step that writes a shift's paper trail to wherever the project keeps it.
_Avoid_: report, log

**Local step**:
A step version a project supplies itself instead of taking one from the factory.
_Avoid_: override, fork

## Records

**Paper trail**:
A project's record of its shifts: timesheets, memos, sign-offs and step logs.
_Avoid_: factory-log, signoff-runs, run log

**Memo**:
The daily note a machine leaves a person about what it did and what it needs from them.
_Avoid_: digest, report

**Timesheet**:
One row per shift of what went in, what merged, and the time and tokens it took.
_Avoid_: ledger

**Performance review**:
The factory reviewing its own recent shifts and proposing changes to its rules.
_Avoid_: retro

**HR**:
The agent that writes the performance review.
_Avoid_: retro agent

**Suggestion box**:
Where observations from shifts are dropped, to be read only at the performance review.
_Avoid_: learnings, lessons learned, retro notes

**Handbook**:
The rules every temp and foreman follow; the factory has one and each project has its own.
_Avoid_: rulebook, workflow, upgrades
