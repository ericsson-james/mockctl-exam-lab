# Contributing

Thanks for helping make a free practice resource better. Two rules come first;
everything else is convention.

## Rule 1 — no real exam content, ever

Practice questions in this repository must be written from **public**
material only: the published exam curriculum, the Kubernetes documentation,
and openly published tutorials. Do not contribute anything you remember from
sitting a real Linux Foundation exam — not questions, not wording, not the
number or order of tasks, not "how the real one phrases it".

Candidates sign a confidentiality agreement that forbids exactly that, and a
violation can void their certification. The maintainer has not taken any of
these exams and will stop updating this project once they do (see the README).
Pull requests that appear to contain real exam content will be closed without
merging.

## Rule 2 — this project is not affiliated with The Linux Foundation or CNCF

Use the certification and Kubernetes names only descriptively ("a practice
environment for the CKA exam"). Do not add logos, badges or wording that could
suggest endorsement, and do not put the marks into product or feature names.

## Adding or improving a question

Questions live in `exams/*.json`. Each has `title`, `domain`, `weight`,
`context`, `text`, `solution`, `references` and `checks`. Read the "Writing
exams" section of the README for the check DSL. A good question:

- can be verified by state (`resource`, `podsReady`, `hostFile`, ...), not by
  which exact command was typed;
- has a `solution` that works verbatim in this environment;
- links `references` to kubernetes.io pages that teach the concept;
- carries a `hint` on every check so a failing learner knows what to look at.

## Adding simulated behavior

- Commands: register in `src/js/commands/*.js` (or a new file added to
  `JS_FILES` in `build.mjs`).
- Cluster behavior: `src/js/k8s/sim.js` (controllers, scheduler, statuses),
  `src/js/k8s/cluster.js` (defaults, validation).
- Check types: `Checks.register('name', fn)` in `src/js/exam/checks.js`.

The app makes no network calls and has no runtime dependencies; keep it that
way. Everything ships as one self-contained HTML file.

## Testing

`npm test` builds the bundle, syntax-checks it, and drives a headless
candidate through the entire practice exam. Add a step to `test/smoke.mjs`
for anything you add. Run it before opening a PR.
