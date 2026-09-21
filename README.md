# mockctl exam lab

**Live at [mockctl.com](https://mockctl.com/).** Source, issues and pull requests:
[github.com/ericsson-james/mockctl-exam-lab](https://github.com/ericsson-james/mockctl-exam-lab).

A free, browser-only practice environment modeled on the format of the CKA,
CKAD and CKS exams: a terminal on a base host, `kubectl` against simulated multi-node
clusters, `ssh` into control-plane and worker nodes for `etcdctl` / `kubeadm` /
`systemctl` work, a question panel with weights and contexts, a two-hour
clock, instant per-question checks with intended solutions and documentation
links, and a final PASS/FAIL breakdown.

Everything is simulated in JavaScript. The page makes **no network calls**,
has no server, no account, and no runtime dependencies.

> **Not affiliated with The Linux Foundation or the CNCF.** This is an
> independent, unofficial learning project. "Kubernetes", "CKA", "CKAD", "CKS",
> "Certified Kubernetes Administrator", "Certified Kubernetes Application
> Developer" and "Certified Kubernetes Security Specialist" are trademarks of
> The Linux Foundation
> and are used here only to describe what the project helps you practice for.
> Nothing in this repository is endorsed by, or reproduces, the official exam.
>
> **About exam content.** The maintainer has **not** taken the CKA, the CKAD,
> the CKS or any other Linux Foundation exam. Every practice question here was written from
> the publicly published curriculum and the Kubernetes documentation, never
> from a real exam. If the maintainer sits any of these exams in the future,
> **this project will stop being updated** at that point, so that it can never
> contain anything covered by the candidate confidentiality agreement.
> Contributors are held to the same rule — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Run it

```
npm test          # build + syntax check + end-to-end smoke test (drives the whole exam)
npm run build     # just build dist/
open dist/index.html
npm run deploy:beta   # build + publish to beta.mockctl.com (try changes here first)
npm run deploy        # build + publish to mockctl.com (run `npx wrangler login` once first)
```

No runtime dependencies; the one dev dependency is `wrangler`, used only to
deploy. `build.mjs` embeds `exams/*.json` and concatenates `src/js`
into one self-contained page: `dist/index.html`. The included GitHub Actions
workflow can publish that page to GitHub Pages (manual trigger; enable Pages
with source "GitHub Actions" once in the repository settings).
`wrangler.jsonc` publishes the same `dist/` to Cloudflare Workers as static
assets. Changes go to `beta.mockctl.com` first (`deploy:beta`, a separate
Worker, marked "beta" in the header and excluded from search) and to
`mockctl.com` only with `deploy`.

Six practice exams ship in `exams/`: two CKA exams (18 and 17 questions,
covering the full public curriculum between them), one CKAD exam (18
questions, weighted like the five domains of the public curriculum) and three
CKS exams (17 questions each, across all six CKS domains). At boot the terminal shows a numbered
menu: pick with the arrow keys and Enter, or type the number. A URL fragment
such as `#2` (or an exam's name) skips the menu. `exam list` and `exam switch
<number>` change exams later; `exam import <code>` adds an exam someone
exported with `exam export` to the list (kept in this browser's localStorage).
The `uuid` in each exam file is only an internal identity for imports.

## What is simulated

**Clusters** — each cluster stores API objects as plain JSON, like a real API
server, with kubectl-faithful defaults, uid / resourceVersion /
creationTimestamp, events, ownerReferences with cascading deletes, and CRD
registration. A control-plane simulator runs the scheduler (nodeName,
nodeSelector, node affinity, taints and tolerations, cordon, NotReady nodes,
unbound PVCs) and the controllers for Deployment → ReplicaSet → Pod (with
rollout history and undo), DaemonSet, StatefulSet, Job, and PVC binding with
dynamic provisioning. Pod status derives from age and simulation state, so
pods go ContainerCreating → Running over a couple of seconds, bad images go
ErrImagePull → ImagePullBackOff, crashing containers show CrashLoopBackOff
with rising restart counts, and job pods complete.

**kubectl** — `get` (tables, `-o wide/yaml/json/name/jsonpath/custom-columns`,
`-l`, `-A`, `--sort-by`, `--field-selector`), `describe`, `create` (deployment,
service, configmap, secret, sa, role, rolebinding, clusterrole(binding), job,
cronjob, ingress, quota, pdb, …), `run` (`--dry-run=client -o yaml`,
`--overrides`, `-it --rm -- cmd`), `apply`/`delete`/`replace` `-f` (multi-
document files and directories), `expose`, `scale`, `autoscale`, `set
image|env|resources|serviceaccount`, `rollout status|history|undo|restart`,
`label`, `annotate`, `taint`, `cordon`/`uncordon`/`drain` (with the real safety
errors), `logs`, `exec` (a small in-container shell whose `wget`/`curl`/
`nslookup` honor Services, endpoints and NetworkPolicies), `top`, `config`,
`edit` (opens vim, validates, applies), `explain`, `api-resources`, `auth
can-i` (real RBAC evaluation), `patch` (merge and JSON patch), `wait`. Errors
print the way kubectl prints them.

**Nodes** — every node is a host with a filesystem seeded like a kubeadm
machine: static-pod manifests under `/etc/kubernetes/manifests` (break one
and the control plane reacts), PKI, kubeconfigs, kubelet config, systemd
units. `systemctl`/`journalctl` control a kubelet whose state drives node
readiness; `etcdctl snapshot save|restore|status` needs the right certificates
and root; `kubeadm upgrade plan|apply|node` plus `apt-mark`/`apt-get` model the
package-held upgrade sequence; `crictl`, `ip`, `sudo -i` and friends round it
out.

**Security tooling (CKS)** — Pod Security Admission is enforced for
namespaces labelled `pod-security.kubernetes.io/enforce=baseline|restricted`
(violating pods are rejected with the real error; controllers record
`FailedCreate` events), RuntimeClass, AppArmor profiles loaded with
`apparmor_parser` and listed by `aa-status`, seccomp profiles, `trivy image`
(findings come from the exam spec), `kubesec scan` (scores a manifest),
`kube-bench` (CIS checks evaluated live against the node's files), Falco
output via `journalctl -u falco`, `sysctl` with persistent per-node kernel
parameters, and `sha256sum`. NetworkPolicy `ipBlock` peers match pod IPs
against the CIDR (with `except`).

**Editor** — `vim` (also `vi`, `nano`) with normal, insert, visual (`v`),
visual-line (`V`), command and search modes; counts; motions `h j k l w b e 0 ^ $
gg G f t F T ; , % { } H M L`; operators `d y c > <` with any motion, text objects
(`ciw`, `di"`, `da{`…) and `dd`/`yy`/`cc`; `x X r s S C D J ~ o O i I a A p P u`,
`Ctrl-R` and `.` to repeat; `:w :q :wq :x :N :$ :[range]d|y|s|sort :g/re/d
:%s/a/b/g :set nu :noh`; autoindent and two-space Tab. **Paste** with
Cmd/Ctrl+V or Shift+Insert works in every editor mode and inserts the text
verbatim, so YAML copied from the docs keeps its indentation; a multi-line
paste at the shell prompt runs line by line, like a real terminal.

**Helm and Kustomize (CKAD)** — `helm repo add|list|update`, `search repo`,
`show values`, `install`, `upgrade` (`--set`, `-f`, `--version`,
`--create-namespace`), `list`, `status`, `history`, `rollback`, `uninstall`,
`get values|manifest`, `template`. Charts come from a catalog in the exam spec
and render through the same API-server path as `kubectl apply`, so releases
produce real Deployments, Services and rollouts, carry Helm's ownership labels,
and leave `sh.helm.release.v1.*` Secrets behind. `kubectl apply -k` /
`delete -k` / `kubectl kustomize` build overlays with `resources`, `namespace`,
`namePrefix`/`nameSuffix`, `commonLabels`/`labels`, `commonAnnotations`,
`images`, `replicas`, `patches` (strategic merge and JSON 6902),
`configMapGenerator`/`secretGenerator` with name hashes and reference
rewriting. Manifests with a removed API version fail with kubectl's real
"no matches for kind" error, and `kubectl create job --from=cronjob/NAME`
works.

**Exam** — the side panel shows each question with weight, domain and its
`kubectl config use-context` line, a flag for review, **Check answer** for
instant feedback, **Show solution** for the intended commands/YAML with links
to the relevant kubernetes.io pages, and a countdown. **End exam** grades
everything and shows a breakdown. Viewing a solution is noted on the results
screen so self-grading stays honest.

## Writing exams

An exam is one JSON file in `exams/` (see `exams/cka-practice-1.json`):

```
uuid, name, exam, durationMinutes, passPercent, candidate, clientVersion, defaultContext
base:      the workstation host (files, homeFiles, services)
contexts:  kubeconfig contexts -> cluster (+ default namespace)
clusters:  { name: { version, nodes[], resources[], hosts{}, upgradeVersions[], badImages[] } }
questions: [ { title, domain, weight, context, ssh, text, solution, references[], checks[] } ]
```

Seeded resources are ordinary Kubernetes objects (JSON). Two extra keys are
stripped before creation: `_sim` (per-object simulation state such as `cpu`,
`memory`, `logs`, `crash`, `runSeconds`) and `_ageSeconds`. Per-node `hosts`
overrides set up troubleshooting scenarios: stop a service, break a file,
change packages. A seeded Deployment may carry `_revisions` (earlier pod
templates, oldest first) so it starts with real rollout history for
`rollout history` / `rollout undo` tasks.

`text` and `solution` use a lightweight markdown (paragraphs, `code`, `- `
lists, four-space-indented command blocks). `references` is a list of
`{title, url}` links.

Checks are declarative (`src/js/exam/checks.js`): `resource` (existence plus
`assert` path expectations — literal, `matches`, `contains`, `anyMatch`,
`length`, `gte`…), `podsReady`, `deploymentAvailable`, `podOnNode`,
`nodeReady`, `nodeSchedulable`, `nodeTaint`, `nodeLabel`, `nodeVersion`,
`clusterVersion`, `serviceEndpoints`, `pvcBound`, `canI`, `connectivity`
(NetworkPolicy-aware), `hostFile`, `hostService`, `hostPackage`,
`staticPodHealthy`, `apiHealthy`, `dsCoversNodes`, `nodeEmpty`,
`hostApparmorLoaded`, `hostSysctl`, `podLogsContain`, `helmRelease`. Each check may carry a
`hint` shown when it fails. Write checks against **state**, not against the
exact command a learner typed.

## Extending

The exam type is metadata; what makes an exam is its world and its checks.
Exam specs may also carry `trivy` (image -> finding counts) and `kubeBench`
(CIS checks: id, text, host, file, contains/notContains, remediation) tables
that the corresponding tools read, and `helm` (chart repositories keyed by
URL, each chart with `versions`, `values`, `notes` and JSON `manifests` using
`{{ .Release.Name }}` / `{{ .Values.x }}` placeholders; see
`exams/ckad-practice-1.json` and the header of `src/js/commands/helm.js`). Seeded file contents may embed
`{{sha256:text}}`, replaced when the world is built by the lab's SHA-256 of
that text (for checksum-verification tasks), and `{{pem:LABEL:seed}}`, which
expands to a synthetic PEM block so nothing key-shaped sits in the JSON.
Add check types with `Checks.register('name', fn)`, node tools as command
modules in `src/js/commands/`, cluster behaviors in `src/js/k8s/sim.js` and
`cluster.js`, and a new JSON file in `exams/` with its own UUID.

## Layout

```
src/js/
  util.js, yaml.js              helpers; dependency-free YAML parser/serializer
  core/                         hosts, users, filesystem, permissions
  k8s/kinds.js                  API resource registry (kind/plural/short names, CRDs)
  k8s/cluster.js                resource store, defaults, validation, events, health
  k8s/sim.js                    scheduler, controllers, pod status simulation
  k8s/printers.js               tables, describe, yaml/json/jsonpath, top, api-resources
  k8s/rbac.js                   RBAC evaluation, NetworkPolicy evaluation, cluster DNS
  k8s/kubectl.js                the kubectl command
  k8s/world.js                  exam spec -> clusters, node hosts, manifests, kubeconfigs
  exam/checks.js|exam.js|ui.js  grading DSL, exam state/timer, side panel
  shell.js, terminal.js, vim.js the shell, screen/keyboard, the editor
  commands/                     ls/cat/…, ssh/curl, systemctl/etcdctl/kubeadm/apt, helm, exam
  app.js                        boot
exams/                          exam definitions (JSON)
static/                         copied into dist/ as-is: share image, favicon, 404 page, _headers
test/smoke.mjs                  headless end-to-end test
.github/workflows/              CI (npm test) and GitHub Pages deployment
```

## Not simulated (yet)

`kubectl port-forward`/`cp`/`attach`/`debug`, building container images
(`docker`/`podman`), Helm charts from the internet or local chart directories
(only the catalog in the exam spec), interactive shells inside containers (run
single commands with `exec -- cmd`), Gateway API controllers (objects can be
created and listed), `kubeadm init/join`.

## Attribution and license

Code is MIT licensed (see [LICENSE](LICENSE)). The short field descriptions
behind `kubectl explain` paraphrase the Kubernetes API reference
documentation at kubernetes.io, which is licensed CC BY 4.0 by The Kubernetes
Authors. Kubernetes itself is not included; the simulator only imitates the
observable behavior of `kubectl` and a kubeadm cluster for learning purposes.
Facts about the exam format (duration, number of tasks, passing score) come
from The Linux Foundation's public program pages.
