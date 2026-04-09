---
name: development-plan
description: Use when the user asks to create, write, or generate a development plan, project plan, implementation plan, build plan, or roadmap for a project — for any language, framework, or platform. Produces a phased, executable plan in markdown with concrete commands, expected results, and verification steps.
---

# Development Plan Skill

Write a phased development plan for a software project. The plan should be detailed enough to follow step by step, and work for any language or platform.

## When to use

Use this when the user asks to:

- write a development plan, project plan, build plan, or roadmap
- plan how to build something
- give steps to build something

Do not use this for:

- quick how-to questions
- single small tasks (just do them)
- design docs with no execution steps

## Before writing

Ask the user if you don't already know:

1. What is being built? (one sentence)
2. What is the hard part? (the main technical risk)
3. What language, framework, or platform?
4. Is there existing code, or starting fresh?
5. Where should the plan file go? (default: repo root, named `<project>-development-plan.md`)

If the user already gave this info, or you can read it from the repo, do not ask again.

## Plan structure

Every plan has these sections:

```markdown
# <Project> Development Plan

## What this project is
## Repository layout
## Phase 1 — Bootstrap
## Phase 2 — First run
## Phase 3..N — Feature phases
## Phase N+1 — Polish
## Phase N+2 — Testing
## Phase N+3 — Ship
## Daily workflow
## Risks & mitigations
```

### What this project is

3–6 sentences. Cover:

- What does it do?
- Who uses it?
- What is the hard part? (one sentence)

### Repository layout

A `text` code block showing the current file layout. If scaffolding is part of the plan, add a second block showing the layout after scaffolding. Say where commands should be run from.

### Phases

Order phases by dependency. Each phase must build on the one before it. Tackle the hard part early.

Each phase looks like this:

```markdown
## Phase N — <title>

**Goal:** <one sentence — what works at the end of this phase that did not work before>

### N.1 <substep title>

<short description>

```bash
<exact command>
```

**Result:** <what the command produces>

**Verify:**

```bash
<command that proves it worked>
```

### N.2 ...

### Verify (end of phase)

<3–5 checks that prove the phase goal is met>

### If verification fails

| Symptom | Check |
|---------|-------|
| <failure> | <what to look at> |
```

### Rules for substeps

1. Number them (`N.1`, `N.2`, ...) so the user can say "do 3.4 for me".
2. Every action has an exact command in a `bash` block. If the action is editing a file, name the file and what to change.
3. Every action has a **Result:** line saying what changed.
4. Every action has a **Verify:** step — a command, or a list of things to look at. Never say "it should work".
5. Use [path/to/file](path/to/file) markdown links for file references.
6. Do not include time estimates.

### Required phases

Every plan has these, in order:

1. **Bootstrap** — set up an empty buildable project. Mark as DONE if it already exists, and add a re-verify recipe.
2. **First run** — make sure the empty project actually runs. This is the base for every later verify step.
3. **Feature phases** — one phase per chunk of work. Order by dependency. Hit the hard part early.
4. **Polish** — UX, theming, settings, edge cases.
5. **Testing** — unit and integration tests. Say what each test covers.
6. **Ship** — production build, packaging, smoke test on the packaged result. Replace with **Deploy** or **Hand-off** for projects that don't ship a binary.

### Daily workflow

A small table the user can refer to once they're past Phase 2:

| Action | How |
|--------|-----|
| Edit code | ... |
| Rebuild | ... |
| Run tests | ... |
| Lint | ... |

### Risks & mitigations

A 3–6 row table. Each risk should be specific to this project, not generic. Each should name a concrete fix.

| Risk | Mitigation |
|------|------------|
| <risk> | <fix> |

## Style rules

- Use plain, direct language. Short sentences.
- Imperative voice: "Run `npm install`", not "you should run npm install".
- Concrete over abstract: name the exact command, file, or field.
- Use tables for: prerequisites, daily workflow, failure triage, risks. Use numbered lists for ordered steps. Use bullets for unordered options.
- Type every code fence (` ```bash `, ` ```json `, ` ```text `). Never untyped.
- No emojis unless asked.
- Use markdown links for file references.

## How to write the plan

1. Read the repo. Check manifest files (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, etc.) so the plan matches reality.
2. Name the hard part. Every phase order decision flows from this.
3. Draft the phase list first — just titles and one-line goals. Check the order: each phase should be verifiable using only earlier phases.
4. Fill in substeps. For each one ask: what command? what does it produce? how do I prove it? If you can't answer all three, break it down more.
5. Write the plan to a file with the Write tool. Default path: `<project-name>-development-plan.md` at the repo root.
6. After writing, send a short summary in chat: file path, phase titles, and which phase to start with. Keep it under 10 lines.
