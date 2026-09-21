/* test/smoke.mjs — headless end-to-end test: stub the DOM, load the bundle,
   drive the REPL through the whole practice exam and expect a passing grade.
   Run: npm test */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = [];
const stripTags = (s) => s.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function makeEl() {
  return {
    innerHTML: '', textContent: '', value: '', type: 'text', hidden: false, dataset: {},
    scrollTop: 0, scrollHeight: 0, clientHeight: 400,
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild(el) { output.push(el.textContent || stripTags(el.innerHTML)); },
    addEventListener(type, fn) { (this._handlers ??= {})[type] = fn; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    focus() {}, blur() {}, setSelectionRange() {}, scrollIntoView() {},
  };
}
const els = {};
const ids = ['term', 'out', 'ps1', 'cmd', 'examPanel', 'examTimer', 'examTitle', 'examNav', 'examBody', 'examOverlay', 'examEnd', 'examOverlayClose', 'examResults', 'vim', 'vimText', 'vimLeft', 'vimRight', 'vimCmd'];
for (const id of ids) els[id] = makeEl();
const docHandlers = {};
globalThis.document = { getElementById: (id) => els[id] || (els[id] = makeEl()), createElement: () => makeEl(), addEventListener: (t, fn) => { (docHandlers[t] ??= []).push(fn); } };
globalThis.window = { getSelection: () => ({ isCollapsed: true }), confirm: () => true };
globalThis.location = { hash: '' };
globalThis.requestAnimationFrame = (fn) => fn();
const lsData = {};
globalThis.localStorage = { getItem: (k) => lsData[k] ?? null, setItem: (k, v) => { lsData[k] = v; }, removeItem: (k) => { delete lsData[k]; } };

(0, eval)(readFileSync(join(root, 'dist', 'bundle.js'), 'utf8'));
const app = globalThis.__mockctl;

const tick = () => new Promise(r => setTimeout(r, 0));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function type(line) {
  output.push('  $ ' + line);
  els.cmd.value = line;
  els.cmd._handlers.keydown({ key: 'Enter', preventDefault() {} });
  await tick(); await tick(); await tick();
}
/* Wait until the pending command finishes (rollout status etc. are slow). */
async function settle() { for (let i = 0; i < 100 && !app.term.pending; i++) await sleep(50); }
function vimKeys(...keys) { for (const k of keys) for (const fn of docHandlers.keydown || []) fn({ key: k, preventDefault() {}, ctrlKey: false, metaKey: false }); }
function vimType(s) { for (const ch of s) vimKeys(ch); }

let failures = 0;
const since = () => output.length;
function expect(label, needle, from = 0) {
  const found = (Array.isArray(from) ? from : output.slice(from)).some(l => l.includes(needle));
  if (!found) { failures++; console.log('FAIL: ' + label + ' — missing ' + JSON.stringify(needle)); console.log(output.slice(-12).join('\n')); }
  else console.log('ok:   ' + label);
}
function expectNot(label, needle, from = 0) {
  const found = output.slice(from).some(l => l.includes(needle));
  if (found) { failures++; console.log('FAIL: ' + label + ' — should not appear: ' + JSON.stringify(needle)); }
  else console.log('ok:   ' + label);
}
/* Seed a file on the base host directly (the editor is exercised separately). */
function seedFile(path, content) {
  const s = app.shell.session;
  s.fs.writeFile(s.resolvePath(path), content, s.user);
}

await tick();
await type('');                                  // default exam
expect('exam banner', 'Unofficial CKA Practice Exam 1');

// ---- orientation ----
let m = since();
await type('kubectl config get-contexts');
expect('logged in', 'candidate@cka-base', m);
expect('contexts listed', 'k8s-ops', m);
m = since();
await type('kubectl get nodes');
expect('nodes table', 'cka-control', m);
expect('node version column', 'v1.31.0', m);
m = since();
await type('k get pods -A');
expect('system pods', 'kube-apiserver-cka-control', m);
expect('coredns pods', 'coredns-', m);
m = since();
await type('k get pods -n monitoring -o wide');
expect('seeded pods', 'log-shipper', m);

// ---- Q1: namespace + deployment ----
await type('k create ns frontend');
await type('k create deploy web --image=nginx:1.27 --replicas=3 --port=80 -n frontend');
m = since();
await type('k get deploy -n frontend');
expect('deployment listed', 'web', m);

// ---- Q2: scale ----
await type('k scale deploy api -n backend --replicas=5');

// ---- Q3: multi-container pod via file ----
seedFile('multi.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: multi\nspec:\n  containers:\n  - name: web\n    image: nginx:1.27\n  - name: sidecar\n    image: busybox:1.36\n    command: ["sleep", "3600"]\n');
m = since();
await type('k apply -f multi.yaml');
expect('apply pod', 'pod/multi created', m);

// ---- Q4: node selector via run --overrides ----
await type("k run ssd-pod --image=nginx:1.27 --overrides='{\"spec\":{\"nodeSelector\":{\"disk\":\"ssd\"}}}'");

// ---- Q5: taint + toleration ----
m = since();
await type('k taint nodes cka-node2 env=prod:NoSchedule');
expect('taint applied', 'node/cka-node2 tainted', m);
seedFile('prod.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: prod-pod\nspec:\n  nodeName: cka-node2\n  tolerations:\n  - key: env\n    operator: Equal\n    value: prod\n    effect: NoSchedule\n  containers:\n  - name: nginx\n    image: nginx:1.27\n');
await type('k apply -f prod.yaml');

// ---- Q6: expose ----
m = since();
await type('k expose deploy api -n backend --name=api-svc --port=8080 --target-port=80');
expect('exposed', 'service/api-svc exposed', m);

// ---- Q7: network policy ----
seedFile('np.yaml', 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: allow-api-to-db\n  namespace: db\nspec:\n  podSelector:\n    matchLabels:\n      app: db\n  policyTypes:\n  - Ingress\n  ingress:\n  - from:\n    - podSelector:\n        matchLabels:\n          role: api\n    ports:\n    - protocol: TCP\n      port: 6379\n');
await type('k apply -f np.yaml');
await sleep(2500);
m = since();
await type('k exec api-client -n db -- wget -qO- db:6379');
expect('allowed pod reaches db', 'Hello from db-', m);
m = since();
await type('k exec intruder -n db -- wget -qO- db:6379');
expect('blocked pod times out', 'download timed out', m);

// ---- Q8: PV / PVC / pod ----
seedFile('pv.yaml', 'apiVersion: v1\nkind: PersistentVolume\nmetadata:\n  name: pv-data\nspec:\n  capacity:\n    storage: 1Gi\n  accessModes:\n  - ReadWriteOnce\n  storageClassName: manual\n  hostPath:\n    path: /mnt/data\n---\napiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: pvc-data\nspec:\n  accessModes:\n  - ReadWriteOnce\n  storageClassName: manual\n  resources:\n    requests:\n      storage: 500Mi\n---\napiVersion: v1\nkind: Pod\nmetadata:\n  name: data-pod\nspec:\n  volumes:\n  - name: data\n    persistentVolumeClaim:\n      claimName: pvc-data\n  containers:\n  - name: nginx\n    image: nginx:1.27\n    volumeMounts:\n    - name: data\n      mountPath: /usr/share/nginx/html\n');
m = since();
await type('k apply -f pv.yaml');
expect('multi-doc apply', 'persistentvolumeclaim/pvc-data created', m);
m = since();
await type('k get pvc');
expect('pvc bound', 'Bound', m);

// ---- Q9: storage class ----
seedFile('sc.yaml', 'apiVersion: storage.k8s.io/v1\nkind: StorageClass\nmetadata:\n  name: fast-local\nprovisioner: rancher.io/local-path\nvolumeBindingMode: WaitForFirstConsumer\nreclaimPolicy: Delete\n');
await type('k apply -f sc.yaml');

// ---- Q10: RBAC ----
await type('k create sa deploy-bot -n apps');
await type('k create role deploy-manager --verb=create,get,list,update --resource=deployments -n apps');
await type('k create rolebinding deploy-bot-binding --role=deploy-manager --serviceaccount=apps:deploy-bot -n apps');
m = since();
await type('k auth can-i create deployments -n apps --as system:serviceaccount:apps:deploy-bot');
expect('can-i yes', 'yes', m);
m = since();
await type('k auth can-i delete deployments -n apps --as system:serviceaccount:apps:deploy-bot');
expect('can-i no', 'no', m);

// ---- Q11: etcd backup over ssh ----
m = since();
await type('ssh cka-control');
expect('ssh banner', 'Welcome to Ubuntu', m);
m = since();
await type('ETCDCTL_API=3 etcdctl snapshot save /opt/etcd-backup.db --endpoints=https://127.0.0.1:2379 --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key');
expect('etcdctl needs root for the key', 'permission denied', m);
await type('sudo -i');
m = since();
await type('ETCDCTL_API=3 etcdctl snapshot save /opt/etcd-backup.db --endpoints=https://127.0.0.1:2379 --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key');
expect('snapshot saved', 'Snapshot saved at /opt/etcd-backup.db', m);
m = since();
await type('kubectl get nodes');
expect('kubectl works on control plane', 'cka-control', m);
await type('exit');
await type('exit');

// ---- Q12: control plane upgrade ----
await type('kubectl config use-context k8s-ops');
m = since();
await type('kubectl drain ops-control --ignore-daemonsets');
expect('drained', 'node/ops-control drained', m);
await type('ssh ops-control');
await type('sudo -i');
m = since();
await type('apt-get install -y kubeadm=1.31.2-1.1');
expect('held package blocks install', 'Held packages were changed', m);
await type('apt-mark unhold kubeadm kubelet kubectl');
await type('apt-get update && apt-get install -y kubeadm=1.31.2-1.1');
m = since();
await type('kubeadm upgrade plan');
expect('plan shows target', 'kubeadm upgrade apply v1.31.2', m);
m = since();
await type('kubeadm upgrade apply v1.31.2 -y');
expect('upgrade success', 'SUCCESS! Your cluster was upgraded to "v1.31.2"', m);
await type('apt-get install -y kubelet=1.31.2-1.1 kubectl=1.31.2-1.1');
await type('apt-mark hold kubeadm kubelet kubectl');
await type('systemctl daemon-reload && systemctl restart kubelet');
await type('exit');
await type('exit');
await type('kubectl uncordon ops-control');
m = since();
await type('kubectl get nodes');
expect('node upgraded', 'ops-control', m);
expect('node shows new version', 'v1.31.2', m);

// ---- Q13: NotReady node ----
m = since();
await type('kubectl get nodes');
expect('node2 NotReady', 'NotReady', m);
await type('ssh ops-node2');
m = since();
await type('systemctl status kubelet');
expect('kubelet inactive', 'inactive (dead)', m);
await type('sudo systemctl enable --now kubelet');
await type('sudo systemctl start kubelet');
await type('exit');
m = since();
await type('kubectl get nodes');
expectNot('node2 Ready now', 'NotReady', m);

// ---- Q14: broken image ----
m = since();
await type('kubectl get pods -n shop');
expect('image pull failure visible', 'ImagePullBackOff', m);
await type('kubectl -n shop set image deploy/checkout nginx=nginx:1.27-alpine');

// ---- Q15: top pods ----
await type('kubectl config use-context k8s');
m = since();
await type('kubectl top pods -n monitoring --sort-by=cpu');
expect('top sorted', 'log-shipper', m);
await type('echo log-shipper > /opt/answers/high-cpu.txt');

// ---- Q16: service selector ----
await type('kubectl config use-context k8s-ops');
await type("kubectl -n shop patch svc orders-svc -p '{\"spec\":{\"selector\":{\"app\":\"orders\"}}}'");
await type('kubectl config use-context k8s');

// ---- Q17: daemonset (on the ops cluster) ----
await type('kubectl config use-context k8s-ops');
seedFile('ds.yaml', 'apiVersion: apps/v1\nkind: DaemonSet\nmetadata:\n  name: log-agent\n  namespace: kube-system\nspec:\n  selector:\n    matchLabels:\n      app: log-agent\n  template:\n    metadata:\n      labels:\n        app: log-agent\n    spec:\n      tolerations:\n      - key: node-role.kubernetes.io/control-plane\n        operator: Exists\n        effect: NoSchedule\n      containers:\n      - name: agent\n        image: busybox:1.36\n        command: ["sleep", "3600"]\n');
await type('k apply -f ds.yaml');
await type('kubectl config use-context k8s');

// ---- Q18: ingress ----
m = since();
await type('k create ingress www-ingress -n www --class=nginx --rule="www.example.com/*=www:80"');
expect('ingress created', 'ingress.networking.k8s.io/www-ingress created', m);

// ---- kubectl edit through the vim editor ----
m = since();
type('kubectl edit deploy web -n frontend');
await sleep(50);
vimKeys(':'); vimType('%s/replicas: 3/replicas: 4/'); vimKeys('Enter');
vimKeys(':'); vimType('wq'); vimKeys('Enter');
await settle();
expect('edit applied', 'deployment.apps/web edited', m);
m = since();
await type('k get deploy web -n frontend -o jsonpath="{.spec.replicas}"');
expect('jsonpath reflects edit', '4', m);
await type('k scale deploy web -n frontend --replicas=3');

// ---- a rejected edit re-opens with the failure at the top; unknown fields are never stored ----
m = since();
type('kubectl edit deploy web -n frontend');
await sleep(50);
let vl = app.editor.v.lines, vi = vl.findIndex(l => /^\s+- image: nginx/.test(l));
vimKeys(':'); vimType(String(vi + 1)); vimKeys('Enter');
vimKeys('o'); vimType('  containerPort: 80'); vimKeys('Escape');       // sibling of image: not a Container field
vimKeys(':'); vimType('wq'); vimKeys('Enter');
await sleep(50);
expect('rejected edit keeps the editor open', 'editor open', app.editor.v ? ['editor open'] : [], 0);
expect('failure header at top of buffer', 'deployments.apps "web" was not valid:', [app.editor.v.lines[0]], 0);
expect('failure names the unknown field', 'strict decoding error: unknown field "spec.template.spec.containers[0].containerPort"', [app.editor.v.lines[1]], 0);
vl = app.editor.v.lines; vi = vl.findIndex(l => /^\s+containerPort: 80/.test(l));
vimKeys(':'); vimType(String(vi + 1)); vimKeys('Enter'); vimKeys('d', 'd');   // remove the bad line again
vimKeys(':'); vimType('wq'); vimKeys('Enter');
await settle();
expect('no-op edit after fixing is a cancel', 'Edit cancelled, no changes made.', m);
m = since();
await type('k get deploy web -n frontend -o jsonpath="{.spec.template.spec.containers[0].containerPort}"');
expectNot('unknown field was not stored', '80', m);
m = since();
type('kubectl edit deploy web -n frontend');
await sleep(50);
vl = app.editor.v.lines; vi = vl.findIndex(l => /^\s+- image: nginx/.test(l));
vimKeys(':'); vimType(String(vi + 1)); vimKeys('Enter'); vimKeys('o'); vimType('  containerPort: 80'); vimKeys('Escape');
vimKeys(':'); vimType('wq'); vimKeys('Enter'); await sleep(50);
vimKeys(':'); vimType('q!'); vimKeys('Enter');
await settle();
expect('quitting after a rejected save', 'Edit cancelled, no valid changes were saved.', m);
m = since();
seedFile('badpod.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: badpod\nspec:\n  containers:\n  - name: c\n    image: nginx\n    containerPort: 80\n');
await type('k apply -f badpod.yaml');
expect('apply rejects unknown container field', 'strict decoding error: unknown field "spec.containers[0].containerPort"', m);

// ---- editor: visual mode, text objects, dot repeat, paste in any mode, multi-line paste at the prompt ----
seedFile('edit.yaml', 'image: nginx:1.25\nreplicas: 1\nfoo\nbar\nbaz\n');
type('vim edit.yaml');
await sleep(50);
{
  const V = () => app.editor.v;
  const bufIs = (label, want) => expect(label, want, [V().lines.join('\n')], 0);
  vimKeys('w', 'w'); vimType('ciw'); vimType('httpd'); vimKeys('Escape');
  bufIs('ciw changes the word under the cursor', 'image: httpd:1.25\nreplicas: 1\nfoo\nbar\nbaz');
  vimKeys('j', 'V', 'j', 'd');
  bufIs('V j d deletes the selected lines', 'image: httpd:1.25\nbar\nbaz');
  expect('visual mode ends after the operator', 'normal', [V().mode], 0);
  vimKeys('.');
  bufIs('. repeats the last change', 'image: httpd:1.25');
  vimKeys('u');
  app.editor.pasteText('kind: Deployment\n');
  bufIs('paste in normal mode inserts verbatim before the cursor line', 'image: httpd:1.25\nkind: Deployment\nbar\nbaz');
  vimKeys(':'); vimType('2,3d'); vimKeys('Enter');
  bufIs(':2,3d deletes a range', 'image: httpd:1.25\nbaz');
  vimKeys(':'); vimType('q!'); vimKeys('Enter');
}
await settle();
m = since();
els.cmd._handlers.paste({ clipboardData: { getData: () => 'echo pasted-one\necho pasted-two\n' }, preventDefault() {} });
await settle(); await settle();
expect('multi-line paste at the prompt runs the first line', 'pasted-one', m);
expect('multi-line paste at the prompt runs the second line', 'pasted-two', m);

// ---- dry-run yaml + describe + logs ----
m = since();
await type('k run tmp --image=nginx $do');
expect('dry-run yaml', 'kind: Pod', m);
m = since();
await type('k describe pod multi');
expect('describe pod', 'Containers:', m);
m = since();
await type('k logs multi -c web');
expect('nginx logs', 'start worker processes', m);

// ---- solutions ----
m = since();
await type('exam solution 11');
expect('solution text', 'etcdctl snapshot save /opt/etcd-backup.db', m);
expect('solution reference link', 'kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd', m);

// the panel's Show solution button opens the modal with formatted code blocks
{
  const q = app.exam.question(12);
  app.ui.showSolution(q);
  const html = els.solutionBody.innerHTML;
  if (html.includes('<pre>') && html.includes('kubeadm upgrade apply v1.31.2') && html.includes('href="https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/"') && els.solutionOverlay.hidden === false) console.log('ok:   solution modal renders code blocks and links');
  else { failures++; console.log('FAIL: solution modal rendering'); console.log(html.slice(0, 400)); }
  app.ui.closeSolution();
  if (els.solutionOverlay.hidden === true) console.log('ok:   solution modal closes'); else { failures++; console.log('FAIL: solution modal close'); }
}

// ---- grade ----
await sleep(3000);
m = since();
await type('exam check');
expect('Q1 pass', 'Question 1: PASS', m);
expect('Q2 pass', 'Question 2: PASS', m);
expect('Q3 pass', 'Question 3: PASS', m);
expect('Q4 pass', 'Question 4: PASS', m);
expect('Q5 pass', 'Question 5: PASS', m);
expect('Q6 pass', 'Question 6: PASS', m);
expect('Q7 pass', 'Question 7: PASS', m);
expect('Q8 pass', 'Question 8: PASS', m);
expect('Q9 pass', 'Question 9: PASS', m);
expect('Q10 pass', 'Question 10: PASS', m);
expect('Q11 pass', 'Question 11: PASS', m);
expect('Q12 pass', 'Question 12: PASS', m);
expect('Q13 pass', 'Question 13: PASS', m);
expect('Q14 pass', 'Question 14: PASS', m);
expect('Q15 pass', 'Question 15: PASS', m);
expect('Q16 pass', 'Question 16: PASS', m);
expect('Q17 pass', 'Question 17: PASS', m);
expect('Q18 pass', 'Question 18: PASS', m);
m = since();
await type('exam end');
expect('final grade', 'PASS — 100%', m);
if (els.examResults.innerHTML.includes('solutions viewed for 2 questions') && els.examResults.innerHTML.includes('(solution viewed)')) console.log('ok:   solution viewing recorded on results screen');
else { failures++; console.log('FAIL: solution viewing recorded on results screen'); }

// ======================= exam 2 =======================
m = since();
await type('exam switch "Unofficial CKA Practice Exam 2"');
await type('y');
await sleep(100);
expect('exam 2 loaded', 'Unofficial CKA Practice Exam 2  (CKA, 17 questions', m);
const world2 = app.world;
const hostFs = (name, path, fn) => { const h = world2.hosts.get(name); const parts = path.split('/').filter(Boolean); h.fs.writeFile(parts, fn(h.fs.readFile(parts, null)), null); };

// Q1 configmap/secret/env
await type('kubectl -n dev create configmap app-config --from-literal=APP_MODE=production');
await type('kubectl -n dev create secret generic app-secret --from-literal=DB_PASS=s3cret');
seedFile('app.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: app\n  namespace: dev\nspec:\n  containers:\n  - name: app\n    image: busybox:1.36\n    command: ["sleep", "3600"]\n    env:\n    - name: APP_MODE\n      valueFrom:\n        configMapKeyRef:\n          name: app-config\n          key: APP_MODE\n    - name: DB_PASS\n      valueFrom:\n        secretKeyRef:\n          name: app-secret\n          key: DB_PASS\n');
await type('kubectl apply -f app.yaml');
// Q2 job, Q3 cronjob
seedFile('pi.yaml', 'apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: pi\n  namespace: dev\nspec:\n  completions: 2\n  parallelism: 2\n  backoffLimit: 4\n  template:\n    spec:\n      restartPolicy: Never\n      containers:\n      - name: pi\n        image: busybox:1.36\n        command: ["sh", "-c", "echo 3.14159"]\n');
await type('kubectl apply -f pi.yaml');
seedFile('backup.yaml', 'apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: backup\n  namespace: dev\nspec:\n  schedule: "*/5 * * * *"\n  concurrencyPolicy: Forbid\n  successfulJobsHistoryLimit: 2\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          restartPolicy: OnFailure\n          containers:\n          - name: backup\n            image: busybox:1.36\n            command: ["sh", "-c", "echo backup"]\n');
await type('kubectl apply -f backup.yaml');
// Q4 statefulset
seedFile('db.yaml', 'apiVersion: v1\nkind: Service\nmetadata:\n  name: db\n  namespace: media\nspec:\n  clusterIP: None\n  selector:\n    app: db\n  ports:\n  - port: 6379\n    targetPort: 6379\n---\napiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: db\n  namespace: media\nspec:\n  serviceName: db\n  replicas: 2\n  selector:\n    matchLabels:\n      app: db\n  template:\n    metadata:\n      labels:\n        app: db\n    spec:\n      containers:\n      - name: redis\n        image: redis:7.2\n        ports:\n        - containerPort: 6379\n');
await type('kubectl apply -f db.yaml');
// Q5 hpa, Q6 rolling update
await type('kubectl -n payments autoscale deployment gateway --min=2 --max=6 --cpu-percent=70');
await type('kubectl -n media set image deployment/catalog main=nginx:1.27');
m = since();
await type('kubectl -n media rollout history deployment catalog');
expect('two revisions', '2       <none>', m);
await type('echo 2 > /opt/answers/catalog-revisions.txt');
// Q7 affinity
seedFile('east.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: east-pod\nspec:\n  affinity:\n    nodeAffinity:\n      requiredDuringSchedulingIgnoredDuringExecution:\n        nodeSelectorTerms:\n        - matchExpressions:\n          - key: zone\n            operator: In\n            values:\n            - east\n  containers:\n  - name: nginx\n    image: nginx:1.27\n');
await type('kubectl apply -f east.yaml');
// Q8 egress policy
seedFile('egress.yaml', 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: restrict-egress\n  namespace: dev\nspec:\n  podSelector:\n    matchLabels:\n      role: restricted\n  policyTypes:\n  - Egress\n  egress:\n  - to:\n    - podSelector:\n        matchLabels:\n          app: api\n    ports:\n    - protocol: TCP\n      port: 80\n  - to:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: kube-system\n    ports:\n    - protocol: UDP\n      port: 53\n    - protocol: TCP\n      port: 53\n');
await type('kubectl apply -f egress.yaml');
// Q9 dynamic pvc
seedFile('dyn.yaml', 'apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: data-dyn\n  namespace: payments\nspec:\n  storageClassName: local-dyn\n  accessModes:\n  - ReadWriteOnce\n  resources:\n    requests:\n      storage: 2Gi\n---\napiVersion: v1\nkind: Pod\nmetadata:\n  name: writer\n  namespace: payments\nspec:\n  volumes:\n  - name: data\n    persistentVolumeClaim:\n      claimName: data-dyn\n  containers:\n  - name: main\n    image: busybox:1.36\n    command: ["sleep", "3600"]\n    volumeMounts:\n    - name: data\n      mountPath: /data\n');
await type('kubectl apply -f dyn.yaml');
// Q10 rbac, Q11 gateway api
await type('kubectl create clusterrole node-viewer --verb=get,list,watch --resource=nodes');
await type('kubectl create clusterrolebinding node-viewer-dave --clusterrole=node-viewer --user=dave');
seedFile('gw.yaml', 'apiVersion: gateway.networking.k8s.io/v1\nkind: Gateway\nmetadata:\n  name: main-gw\n  namespace: media\nspec:\n  gatewayClassName: nginx-gc\n  listeners:\n  - name: http\n    protocol: HTTP\n    port: 80\n---\napiVersion: gateway.networking.k8s.io/v1\nkind: HTTPRoute\nmetadata:\n  name: media-route\n  namespace: media\nspec:\n  parentRefs:\n  - name: main-gw\n  hostnames:\n  - media.example.com\n  rules:\n  - backendRefs:\n    - name: media\n      port: 80\n');
await type('kubectl apply -f gw.yaml');
// Q12 jsonpath, Q13 secret decode, Q14 drain
await type(`kubectl get node cka2-node1 -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}' > /opt/answers/node1-ip.txt`);
await type(`kubectl -n payments get secret license -o jsonpath='{.data.key}' | base64 -d > /opt/answers/license.txt`);
m = since();
await type('cat /opt/answers/license.txt');
expect('secret decoded', 'LIC-7731-EAST', m);
await type('kubectl drain cka2-node3 --ignore-daemonsets --delete-emptydir-data');
// Q15 apiserver manifest
await type('kubectl config use-context k8s-ops');
m = since();
await type('kubectl get nodes');
expect('api refused', 'was refused', m);
hostFs('ops2-control', '/etc/kubernetes/manifests/kube-apiserver.yaml', t => t.replace('--etcd-server=', '--etcd-servers='));
m = since();
await type('kubectl get nodes');
expect('api back', 'ops2-control', m);
// Q16 kubelet config
await type('ssh ops2-node1');
await type('sudo systemctl start kubelet');
m = since();
await type('sudo journalctl -u kubelet -n 5');
expect('kubelet log shows config error', 'KubeletConfig', m);
hostFs('ops2-node1', '/var/lib/kubelet/config.yaml', t => t.replace('kind: KubeletConfig\n', 'kind: KubeletConfiguration\n'));
await type('sudo systemctl enable --now kubelet');
await type('sudo systemctl restart kubelet');
await type('exit');
// Q17 scheduler manifest
m = since();
await type('kubectl -n kube-system get pods');
expect('scheduler crashlooping', 'CrashLoopBackOff', m);
hostFs('ops2-control', '/etc/kubernetes/manifests/kube-scheduler.yaml', t => t.replace(':v1.31.0-broken', ':v1.31.0'));
await type('kubectl config use-context k8s');
await sleep(8000);
m = since();
await type('exam check');
for (let i = 1; i <= 17; i++) expect('exam2 Q' + i + ' pass', 'Question ' + i + ': PASS', m);
m = since();
await type('exam end');
expect('exam 2 final grade', 'PASS — 100%', m);

// ======================= exam 3 (CKS) =======================
m = since();
await type('exam switch "Unofficial CKS Practice Exam 1"');
await type('y');
await sleep(100);
expect('exam 3 loaded', 'Unofficial CKS Practice Exam 1  (CKS, 17 questions', m);
const world3 = app.world;
const hostFs3 = (name, path, fn) => { const h = world3.hosts.get(name); const parts = path.split('/').filter(Boolean); const cur = h.fs.exists(parts, null) ? h.fs.readFile(parts, null) : ''; if (parts.length > 1) h.fs.mkdir(parts.slice(0, -1), null, { parents: true }); h.fs.writeFile(parts, fn(cur), null); };
const addFlags = (component, flags) => hostFs3('cks-control', '/etc/kubernetes/manifests/' + component + '.yaml', t => t.replace('    - ' + component + '\n', '    - ' + component + '\n' + flags.map(f => '    - ' + f + '\n').join('')));

// Q1 default deny + allow
seedFile('np.yaml', `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: prod
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-web-to-db
  namespace: prod
spec:
  podSelector:
    matchLabels:
      app: db
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: web
    ports:
    - protocol: TCP
      port: 6379
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-web-egress
  namespace: prod
spec:
  podSelector:
    matchLabels:
      app: web
  policyTypes:
  - Egress
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: db
    ports:
    - protocol: TCP
      port: 6379
`);
await type('kubectl apply -f np.yaml');
// Q2 tls
await type('kubectl -n prod create secret tls web-tls --cert=/opt/tls/tls.crt --key=/opt/tls/tls.key');
await type('kubectl -n prod create ingress web-ingress --rule="web.prod.local/*=web:80,tls=web-tls"');
// Q3 kube-bench
await type('ssh cks-control');
m = since();
await type('sudo kube-bench');
expect('kube-bench reports profiling FAIL', '[FAIL] 1.2.16', m);
await type('exit');
addFlags('kube-apiserver', ['--profiling=false']); addFlags('kube-controller-manager', ['--profiling=false']); addFlags('kube-scheduler', ['--profiling=false']);
m = since();
await type('ssh cks-control sudo kube-bench --check 1.2.16,1.3.2,1.4.1');
expect('kube-bench passes after fix', '3 checks PASS', m);
// Q4 rbac
await type('kubectl delete clusterrolebinding app-sa-admin');
await type('kubectl -n web create role pod-reader --verb=get,list --resource=pods');
await type('kubectl -n web create rolebinding app-sa-pods --role=pod-reader --serviceaccount=web:app-sa');
// Q5 automount
await type(`kubectl -n web patch serviceaccount worker-sa -p '{"automountServiceAccountToken": false}'`);
await type(`kubectl -n web patch deployment worker -p '{"spec":{"template":{"spec":{"automountServiceAccountToken": false}}}}'`);
// Q6 apiserver hardening
hostFs3('cks-control', '/etc/kubernetes/manifests/kube-apiserver.yaml', t => t.replace('--authorization-mode=AlwaysAllow', '--authorization-mode=Node,RBAC'));
addFlags('kube-apiserver', ['--anonymous-auth=false']);
m = since();
await type('kubectl get nodes');
expect('api healthy after edits', 'cks-control', m);
// Q7 kubelet hardening
hostFs3('cks-node1', '/var/lib/kubelet/config.yaml', t => t.replace('enabled: true\n  webhook', 'enabled: false\n  webhook').replace('mode: AlwaysAllow', 'mode: Webhook'));
await type('ssh cks-node1');
await type('sudo systemctl restart kubelet');
// Q8 apparmor
m = since();
await type('sudo apparmor_parser -q /etc/apparmor.d/k8s-deny-write');
await type('sudo aa-status');
expect('profile loaded', 'k8s-deny-write', m);
await type('exit');
seedFile('locked.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: locked\nspec:\n  nodeName: cks-node1\n  containers:\n  - name: main\n    image: busybox:1.36\n    command: ["sleep", "3600"]\n    securityContext:\n      appArmorProfile:\n        type: Localhost\n        localhostProfile: k8s-deny-write\n');
await type('kubectl apply -f locked.yaml');
// Q9 seccomp
seedFile('audited.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: audited\nspec:\n  securityContext:\n    seccompProfile:\n      type: Localhost\n      localhostProfile: profiles/audit.json\n  containers:\n  - name: main\n    image: busybox:1.36\n    command: ["sleep", "3600"]\n');
await type('kubectl apply -f audited.yaml');
// Q10 PSA
await type('kubectl label namespace restricted-ns pod-security.kubernetes.io/enforce=restricted');
m = since();
await type('kubectl -n restricted-ns run bad --image=nginx:1.27');
expect('PSA rejects violating pod', 'violates PodSecurity "restricted:latest"', m);
seedFile('secure.yaml', `apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-app
  namespace: restricted-ns
  labels:
    app: secure-app
spec:
  replicas: 2
  selector:
    matchLabels:
      app: secure-app
  template:
    metadata:
      labels:
        app: secure-app
    spec:
      containers:
      - name: main
        image: nginx:1.27
        ports:
        - containerPort: 80
        securityContext:
          allowPrivilegeEscalation: false
          runAsNonRoot: true
          capabilities:
            drop: ["ALL"]
          seccompProfile:
            type: RuntimeDefault
`);
m = since();
await type('kubectl apply -f secure.yaml');
expect('deployment configured', 'deployment.apps/secure-app configured', m);
// Q11 secret volume, Q12 runtimeclass
seedFile('vault.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: vault-client\n  namespace: web\nspec:\n  volumes:\n  - name: creds\n    secret:\n      secretName: db-creds\n  containers:\n  - name: main\n    image: busybox:1.36\n    command: ["sleep", "3600"]\n    volumeMounts:\n    - name: creds\n      mountPath: /etc/creds\n      readOnly: true\n');
await type('kubectl apply -f vault.yaml');
seedFile('gvisor.yaml', 'apiVersion: node.k8s.io/v1\nkind: RuntimeClass\nmetadata:\n  name: gvisor\nhandler: runsc\n---\napiVersion: v1\nkind: Pod\nmetadata:\n  name: sandboxed\nspec:\n  runtimeClassName: gvisor\n  containers:\n  - name: nginx\n    image: nginx:1.27\n');
await type('kubectl apply -f gvisor.yaml');
// Q13 trivy
m = since();
await type('trivy image --severity CRITICAL docker.io/legacy/app:2.3');
expect('trivy shows criticals', 'CRITICAL: 3', m);
await type('kubectl -n apps delete deployment beta delta');
// Q14 kubesec
m = since();
await type('kubesec scan hardened-pod.yaml');
expect('kubesec flags privileged', '"id": "Privileged"', m);
seedFile('hardened-pod.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: hardened\nspec:\n  containers:\n  - name: app\n    image: nginx:1.27\n    securityContext:\n      runAsNonRoot: true\n      readOnlyRootFilesystem: true\n      allowPrivilegeEscalation: false\n      capabilities:\n        drop: ["ALL"]\n');
m = since();
await type('kubesec scan hardened-pod.yaml');
expect('kubesec passes after fix', 'Passed with a score', m);
await type('kubectl apply -f hardened-pod.yaml');
// Q15 audit
hostFs3('cks-control', '/etc/kubernetes/audit-policy.yaml', () => 'apiVersion: audit.k8s.io/v1\nkind: Policy\nrules:\n- level: Metadata\n  resources:\n  - group: ""\n    resources: ["secrets"]\n- level: RequestResponse\n');
addFlags('kube-apiserver', ['--audit-policy-file=/etc/kubernetes/audit-policy.yaml', '--audit-log-path=/var/log/kubernetes/audit/audit.log', '--audit-log-maxage=30', '--audit-log-maxbackup=10']);
// Q16 falco
await type('ssh cks-node2');
m = since();
await type('sudo journalctl -u falco');
expect('falco event visible', 'Terminal shell in container', m);
await type('exit');
await type('kubectl -n apps scale deployment chatter --replicas=0');
// Q17 immutability
seedFile('ledger.yaml', `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ledger
  namespace: web
  labels:
    app: ledger
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ledger
  template:
    metadata:
      labels:
        app: ledger
    spec:
      volumes:
      - name: tmp
        emptyDir: {}
      containers:
      - name: main
        image: nginx:1.27
        ports:
        - containerPort: 80
        securityContext:
          readOnlyRootFilesystem: true
        volumeMounts:
        - name: tmp
          mountPath: /tmp
`);
await type('kubectl apply -f ledger.yaml');
await sleep(6000);
m = since();
await type('exam check');
for (let i = 1; i <= 17; i++) expect('exam3 Q' + i + ' pass', 'Question ' + i + ': PASS', m);
m = since();
await type('exam end');
expect('exam 3 final grade', 'PASS — 100%', m);

// ======================= exam 4 (CKS 2) =======================
m = since();
await type('exam switch "Unofficial CKS Practice Exam 2"');
await type('y');
await sleep(100);
expect('exam 4 loaded', 'Unofficial CKS Practice Exam 2  (CKS, 17 questions', m);
const world4 = app.world;
const hostFs4 = (name, path, fn) => { const h = world4.hosts.get(name); const parts = path.split('/').filter(Boolean); const cur = h.fs.exists(parts, null) ? h.fs.readFile(parts, null) : ''; if (parts.length > 1) h.fs.mkdir(parts.slice(0, -1), null, { parents: true }); h.fs.writeFile(parts, fn(cur), null); };
const addFlags4 = (component, flags) => hostFs4('cks2-control', '/etc/kubernetes/manifests/' + component + '.yaml', t => t.replace('    - ' + component + '\n', '    - ' + component + '\n' + flags.map(f => '    - ' + f + '\n').join('')));
// Q1, Q2 policies
seedFile('np4.yaml', 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: api-allow-frontend\n  namespace: backend\nspec:\n  podSelector:\n    matchLabels:\n      app: api\n  policyTypes:\n  - Ingress\n  ingress:\n  - from:\n    - namespaceSelector:\n        matchLabels:\n          tier: frontend\n    ports:\n    - protocol: TCP\n      port: 80\n---\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: deny-metadata\n  namespace: frontend\nspec:\n  podSelector: {}\n  policyTypes:\n  - Egress\n  egress:\n  - to:\n    - ipBlock:\n        cidr: 0.0.0.0/0\n        except:\n        - 169.254.169.254/32\n');
await type('kubectl apply -f np4.yaml');
m = since();
await type('kubectl -n storage exec deploy/db -- wget -qO- api.backend');
expect('storage blocked from api', 'download timed out', m);
// Q3 checksums
await type('cd /opt/bin');
m = since();
await type('sha256sum -c SHA256SUMS');
expect('checksum verification flags kubelet', 'kubelet: FAILED', m);
expect('good binary passes', 'kubectl: OK', m);
await type('cd');
await type('echo kubelet > /opt/answers/tampered.txt');
// Q4 worker upgrade
await type('kubectl drain cks2-node2 --ignore-daemonsets --delete-emptydir-data');
await type('ssh cks2-node2');
await type('sudo -i');
await type('apt-mark unhold kubeadm kubelet kubectl && apt-get install -y kubeadm=1.31.2-1.1');
m = since();
await type('kubeadm upgrade node');
expect('worker upgrade node', 'successfully updated', m);
await type('apt-get install -y kubelet=1.31.2-1.1 kubectl=1.31.2-1.1 && apt-mark hold kubeadm kubelet kubectl');
await type('systemctl daemon-reload && systemctl restart kubelet');
await type('exit'); await type('exit');
await type('kubectl uncordon cks2-node2');
// Q5 rbac user
await type('kubectl delete clusterrolebinding bob-admin');
await type('kubectl -n frontend create rolebinding bob-view --clusterrole=view --user=dev-bob');
// Q6 host services + Q7 kubelet CIS
await type('ssh cks2-node1');
await type('sudo systemctl disable --now apache2');
await type('sudo systemctl disable --now telnetd');
m = since();
await type('sudo kube-bench');
expect('kube-bench node checks fail', '[FAIL] 4.2.4', m);
hostFs4('cks2-node1', '/var/lib/kubelet/config.yaml', t => t.replace('readOnlyPort: 10255', 'readOnlyPort: 0\nprotectKernelDefaults: true'));
await type('sudo systemctl restart kubelet');
m = since();
await type('sudo kube-bench --check 4.2.4,4.2.6');
expect('kube-bench node checks pass', '2 checks PASS', m);
// Q14 falco (still on node1)
m = since();
await type('sudo journalctl -u falco');
expect('falco miner alert', 'Stratum', m);
await type('exit');
await type('kubectl -n backend delete deployment metrics-agent');
// Q8 seccomp + nonroot on ui, Q12 digest
await type(`kubectl -n frontend patch deployment ui -p '{"spec":{"template":{"spec":{"securityContext":{"seccompProfile":{"type":"RuntimeDefault"},"runAsNonRoot":true,"runAsUser":1000}}}}}'`);
await type('kubectl -n frontend set image deployment/ui main=nginx@sha256:5ed8fcc66f4ed123c1b2560ed708dc54c5a84f8b28a9e5b7a5e8e4d3b6e7f4a1');
// Q9 PSA baseline
await type('kubectl label namespace storage pod-security.kubernetes.io/enforce=baseline pod-security.kubernetes.io/warn=restricted');
await type(`kubectl -n storage patch deployment legacy-agent --type=json -p '[{"op":"remove","path":"/spec/template/spec/hostPID"}]'`);
// Q10 encryption at rest
hostFs4('cks2-control', '/etc/kubernetes/enc/enc.yaml', () => 'apiVersion: apiserver.config.k8s.io/v1\nkind: EncryptionConfiguration\nresources:\n- resources:\n  - secrets\n  providers:\n  - aescbc:\n      keys:\n      - name: key1\n        secret: c2VjcmV0LWtleS1mb3ItdGhlLWxhYi1lbnZpcm9ubWVudA==\n  - identity: {}\n');
addFlags4('kube-apiserver', ['--encryption-provider-config=/etc/kubernetes/enc/enc.yaml']);
m = since();
await type('kubectl get nodes');
expect('api healthy with encryption flag', 'cks2-control', m);
// Q11 registry, Q12 trivy count
await type('kubectl -n shop set image deployment/store main=registry.internal.corp/shop/store:2.1');
m = since();
await type('trivy image --severity HIGH httpd:2.4');
expect('trivy high count', 'HIGH: 4', m);
await type('echo 4 > /opt/answers/api-high.txt');
// Q13 audit forensics
await type('ssh cks2-control');
m = since();
await type('sudo grep payroll /var/log/kubernetes/audit/audit.log');
expect('audit log shows deleter', 'mallory@corp.local', m);
await type('exit');
await type('echo mallory@corp.local > /opt/answers/deleter.txt');
// Q15 cache fix
seedFile('cache.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: cache\n  namespace: backend\n  labels:\n    app: cache\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: cache\n  template:\n    metadata:\n      labels:\n        app: cache\n    spec:\n      containers:\n      - name: main\n        image: redis:7.2\n        ports:\n        - containerPort: 6379\n        securityContext:\n          readOnlyRootFilesystem: true\n');
await type('kubectl apply -f cache.yaml');
// Q16 dedicated SA
await type('kubectl -n backend create serviceaccount api-sa');
await type('kubectl -n backend create role cm-reader --verb=get,list --resource=configmaps');
await type('kubectl -n backend create rolebinding api-sa-cm --role=cm-reader --serviceaccount=backend:api-sa');
await type('kubectl -n backend set serviceaccount deployment api api-sa');
await sleep(6000);
m = since();
await type('exam check');
for (let i = 1; i <= 17; i++) expect('exam4 Q' + i + ' pass', 'Question ' + i + ': PASS', m);
m = since();
await type('exam end');
expect('exam 4 final grade', 'PASS — 100%', m);

// ======================= exam 5 (CKS 3) =======================
m = since();
await type('exam switch "Unofficial CKS Practice Exam 3"');
await type('y');
await sleep(100);
expect('exam 5 loaded', 'Unofficial CKS Practice Exam 3  (CKS, 17 questions', m);
const world5 = app.world;
const hostFs5 = (name, path, fn) => { const h = world5.hosts.get(name); const parts = path.split('/').filter(Boolean); const cur = h.fs.exists(parts, null) ? h.fs.readFile(parts, null) : ''; if (parts.length > 1) h.fs.mkdir(parts.slice(0, -1), null, { parents: true }); h.fs.writeFile(parts, fn(cur), null); };
const addFlags5 = (component, flags) => hostFs5('cks3-control', '/etc/kubernetes/manifests/' + component + '.yaml', t => t.replace('    - ' + component + '\n', '    - ' + component + '\n' + flags.map(f => '    - ' + f + '\n').join('')));
// Q1 dashboard
await type(`kubectl -n kubernetes-dashboard patch svc kubernetes-dashboard -p '{"spec":{"type":"ClusterIP"}}'`);
await type(`kubectl -n kubernetes-dashboard patch deployment kubernetes-dashboard --type=json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/args","value":["--auto-generate-certificates","--namespace=kubernetes-dashboard"]}]'`);
// Q2 egress policy
seedFile('proxy-egress.yaml', 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: proxy-egress\n  namespace: edge\nspec:\n  podSelector:\n    matchLabels:\n      app: proxy\n  policyTypes:\n  - Egress\n  egress:\n  - to:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: kube-system\n    ports:\n    - protocol: UDP\n      port: 53\n    - protocol: TCP\n      port: 53\n  - to:\n    - ipBlock:\n        cidr: 10.10.0.0/16\n');
await type('kubectl apply -f proxy-egress.yaml');
m = since();
await type('kubectl -n edge exec proxy -- wget -qO- api');
expect('proxy egress blocked', 'download timed out', m);
// Q3 + Q4 + Q12 + Q15 control plane edits
addFlags5('kube-apiserver', ['--audit-log-maxsize=100', '--tls-min-version=VersionTLS12', '--admission-control-config-file=/etc/kubernetes/admission/admission-config.yaml', '--audit-policy-file=/etc/kubernetes/audit/policy.yaml', '--audit-log-path=/var/log/kubernetes/audit/audit.log', '--audit-log-maxage=7']);
hostFs5('cks3-control', '/etc/kubernetes/manifests/kube-apiserver.yaml', t => t.replace('--enable-admission-plugins=AlwaysAdmit', '--enable-admission-plugins=NodeRestriction,ImagePolicyWebhook'));
addFlags5('kube-controller-manager', ['--feature-gates=RotateKubeletServerCertificate=true']);
hostFs5('cks3-control', '/etc/kubernetes/admission/admission-config.yaml', t => t.replace('defaultAllow: true', 'defaultAllow: false'));
hostFs5('cks3-control', '/etc/kubernetes/audit/policy.yaml', () => 'apiVersion: audit.k8s.io/v1\nkind: Policy\nrules:\n- level: Request\n  namespaces: ["prod"]\n  resources:\n  - group: ""\n    resources: ["pods"]\n- level: None\n');
m = since();
await type('ssh cks3-control sudo kube-bench');
expect('kube-bench all pass', '4 checks PASS', m);
m = since();
await type('kubectl get nodes');
expect('api healthy after control plane edits', 'cks3-control', m);
// Q5 service accounts, Q6 group rbac
await type(`kubectl -n ci patch serviceaccount default -p '{"automountServiceAccountToken": false}'`);
await type('kubectl -n ci delete rolebinding legacy-deploy-rb');
await type('kubectl -n ci delete serviceaccount legacy-deploy');
await type('kubectl create clusterrole secret-reader --verb=get,list --resource=secrets');
await type('kubectl create clusterrolebinding auditors-secrets --clusterrole=secret-reader --group=security-auditors');
m = since();
await type('kubectl auth can-i list secrets --as=someone --as-group=security-auditors');
expect('group can list secrets', 'yes', m);
// Q7 apparmor on both nodes + deployment
await type('ssh cks3-node1 sudo apparmor_parser -q /etc/apparmor.d/k8s-restricted');
await type('ssh cks3-node2 sudo apparmor_parser -q /etc/apparmor.d/k8s-restricted');
await type(`kubectl -n edge patch deployment reports -p '{"spec":{"template":{"spec":{"securityContext":{"appArmorProfile":{"type":"Localhost","localhostProfile":"k8s-restricted"}}}}}}'`);
// Q8 sysctl
await type('ssh cks3-node1');
await type('sudo -i');
hostFs5('cks3-node1', '/etc/sysctl.d/99-hardening.conf', () => 'net.ipv4.conf.all.accept_redirects = 0\nkernel.dmesg_restrict = 1\n');
m = since();
await type('sysctl --system');
expect('sysctl applied', 'kernel.dmesg_restrict = 1', m);
m = since();
await type('sysctl net.ipv4.conf.all.accept_redirects');
expect('sysctl value read back', 'net.ipv4.conf.all.accept_redirects = 0', m);
// Q16 falco file output (still root on node1)
hostFs5('cks3-node1', '/etc/falco/falco.yaml', t => t.replace('file_output:\n  enabled: false\n  keep_alive: false\n  filename: ./events.txt', 'file_output:\n  enabled: true\n  keep_alive: false\n  filename: /var/log/falco/events.txt'));
await type('systemctl restart falco');
await type('exit'); await type('exit');
// Q9 secrets
await type(`kubectl -n vault get secret db-conn -o jsonpath='{.data.user}' | base64 -d > /opt/answers/db-user.txt`);
await type(`kubectl -n vault get secret db-conn -o jsonpath='{.data.pass}' | base64 -d > /opt/answers/db-pass.txt`);
await type(`kubectl -n vault2 create secret generic db-conn --from-literal=user=dbadmin --from-literal='pass=Tr0ub4dor&3'`);
// Q10 gvisor, Q11 PSA cronjob
await type(`kubectl -n edge patch deployment untrusted -p '{"spec":{"template":{"spec":{"runtimeClassName":"gvisor"}}}}'`);
await type('kubectl label namespace ci pod-security.kubernetes.io/enforce=restricted');
await type(`kubectl -n ci patch cronjob nightly --type=json -p '[{"op":"replace","path":"/spec/jobTemplate/spec/template/spec/containers/0/securityContext","value":{"allowPrivilegeEscalation":false,"runAsNonRoot":true,"capabilities":{"drop":["ALL"]},"seccompProfile":{"type":"RuntimeDefault"}}}]'`);
// Q13 kubesec triage
m = since();
await type('kubesec scan manifests/b.yaml');
expect('kubesec flags b.yaml', '"id": "Privileged"', m);
m = since();
await type('kubesec scan manifests/d.yaml');
expect('kubesec flags d.yaml', '"id": "HostNetwork"', m);
await type('kubectl apply -f manifests/a.yaml');
await type('kubectl apply -f manifests/c.yaml');
// Q14 pull policy
await type(`kubectl -n web patch deployment shop -p '{"spec":{"template":{"spec":{"containers":[{"name":"main","imagePullPolicy":"Always"}]}}}}'`);
await type(`kubectl -n web patch deployment blog -p '{"spec":{"template":{"spec":{"containers":[{"name":"main","imagePullPolicy":"Always"}]}}}}'`);
// Q17 hostPath pod
m = since();
await type(`kubectl -n ops get pods -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.volumes[*].hostPath.path}{"\\n"}{end}'`);
expect('hostPath pod visible', 'node-tool /', m);
await type('kubectl -n ops delete pod node-tool');
await sleep(6000);
m = since();
await type('exam check');
for (let i = 1; i <= 17; i++) expect('exam5 Q' + i + ' pass', 'Question ' + i + ': PASS', m);
m = since();
await type('exam end');
expect('exam 5 final grade', 'PASS — 100%', m);


// ================= exam 6: CKAD (helm, kustomize, probes, netpol, crd...) =================
m = since();
await type('exam switch "Unofficial CKAD Practice Exam 1"');
await type('y');
expect('exam 6 loaded', 'Unofficial CKAD Practice Exam 1  (CKAD, 18 questions', m);
const world6 = app.world;
const hostFs6 = (name, path, fn) => { const h = world6.hosts.get(name); const parts = path.split('/').filter(Boolean); const cur = h.fs.exists(parts, null) ? h.fs.readFile(parts, null) : ''; if (parts.length > 1) h.fs.mkdir(parts.slice(0, -1), null, { parents: true }); h.fs.writeFile(parts, fn(cur), null); };
// seeded troubleshooting state
m = since();
await type('kubectl -n shop rollout history deploy orders');
expect('orders has two revisions', '2       bump orders to nginx:1.99', m);
m = since();
await type('kubectl -n debug logs inventory');
expect('inventory logs show the error', 'ERROR: DB_HOST is not set', m);
m = since();
await type('kubectl apply -f ~/legacy/api-deploy.yaml');
expect('legacy manifest is rejected', 'no matches for kind "Deployment" in version "extensions/v1beta1"', m);
// Q1 sidecar
seedFile('logger.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: logger\n  namespace: pipeline\nspec:\n  volumes:\n  - name: logs\n    emptyDir: {}\n  containers:\n  - name: app\n    image: busybox:1.36\n    command: ["sh", "-c", "while true; do date >> /var/log/app/app.log; sleep 5; done"]\n    volumeMounts:\n    - name: logs\n      mountPath: /var/log/app\n  - name: log-shipper\n    image: busybox:1.36\n    command: ["sh", "-c", "tail -F /var/log/app/app.log"]\n    volumeMounts:\n    - name: logs\n      mountPath: /var/log/app\n');
await type('kubectl apply -f logger.yaml');
// Q2 cronjob + manual job
seedFile('cleanup.yaml', 'apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: cleanup\n  namespace: batch\nspec:\n  schedule: "*/10 * * * *"\n  concurrencyPolicy: Forbid\n  successfulJobsHistoryLimit: 2\n  failedJobsHistoryLimit: 1\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          restartPolicy: OnFailure\n          containers:\n          - name: cleanup\n            image: busybox:1.36\n            command: ["sh", "-c", "echo cleaning; sleep 5"]\n');
await type('kubectl apply -f cleanup.yaml');
m = since();
await type('kubectl -n batch create job cleanup-manual --from=cronjob/cleanup');
expect('job from cronjob', 'job.batch/cleanup-manual created', m);
// Q3 pvc + init container
seedFile('webdata.yaml', 'apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: data-pvc\n  namespace: storage\nspec:\n  accessModes: ["ReadWriteOnce"]\n  storageClassName: standard\n  resources:\n    requests:\n      storage: 1Gi\n---\napiVersion: v1\nkind: Pod\nmetadata:\n  name: web-data\n  namespace: storage\nspec:\n  volumes:\n  - name: data\n    persistentVolumeClaim:\n      claimName: data-pvc\n  initContainers:\n  - name: init-html\n    image: busybox:1.36\n    command: ["sh", "-c", "echo Hello from init > /work/index.html"]\n    volumeMounts:\n    - name: data\n      mountPath: /work\n  containers:\n  - name: web\n    image: nginx:1.27\n    volumeMounts:\n    - name: data\n      mountPath: /usr/share/nginx/html\n');
await type('kubectl apply -f webdata.yaml');
// Q4 parallel job
seedFile('resize.yaml', 'apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: image-resize\n  namespace: batch\nspec:\n  completions: 4\n  parallelism: 2\n  backoffLimit: 3\n  template:\n    spec:\n      restartPolicy: Never\n      containers:\n      - name: resize\n        image: busybox:1.36\n        command: ["sh", "-c", "echo resizing; sleep 3"]\n');
await type('kubectl apply -f resize.yaml');
// Q5 rolling update + rollback
await type(`kubectl -n shop patch deployment api -p '{"spec":{"strategy":{"type":"RollingUpdate","rollingUpdate":{"maxSurge":1,"maxUnavailable":0}}}}'`);
await type('kubectl -n shop set image deployment/api api=nginx:1.27');
await type('kubectl -n shop annotate deployment api kubernetes.io/change-cause="upgrade api to nginx:1.27" --overwrite');
m = since();
await type('kubectl -n shop rollout undo deployment orders');
expect('orders rolled back', 'deployment.apps/orders rolled back', m);
// Q6 canary
seedFile('canary.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web-canary\n  namespace: shop\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: web\n      track: canary\n  template:\n    metadata:\n      labels:\n        app: web\n        track: canary\n    spec:\n      containers:\n      - name: web\n        image: nginx:1.27\n');
await type('kubectl apply -f canary.yaml');
// Q7 helm
m = since();
await type('helm repo add stable https://charts.mockctl.dev/stable');
await type('helm install frontend stable/podinfo -n helm-apps --create-namespace --version 6.4.0 --set replicaCount=2');
expect('helm install', 'STATUS: deployed', m);
m = since();
await type('helm upgrade frontend stable/podinfo -n helm-apps --version 6.5.1 --set replicaCount=2');
expect('helm upgrade', 'Release "frontend" has been upgraded', m);
m = since();
await type('helm list -n helm-apps');
expect('helm list shows 6.5.1', 'podinfo-6.5.1', m);
// Q8 kustomize
hostFs6('ckad-base', '/home/candidate/kustomize/overlays/prod/kustomization.yaml', () => 'resources:\n- ../../base\nnamespace: prod\nnamePrefix: prod-\ncommonLabels:\n  env: prod\nimages:\n- name: nginx\n  newTag: "1.27"\nreplicas:\n- name: catalog\n  count: 3\n');
m = since();
await type('kubectl apply -k ~/kustomize/overlays/prod');
expect('kustomize apply', 'deployment.apps/prod-catalog created', m);
// Q9 probes
await type(`kubectl -n shop patch deployment payments -p '{"spec":{"template":{"spec":{"containers":[{"name":"payments","readinessProbe":{"httpGet":{"path":"/","port":80},"initialDelaySeconds":5,"periodSeconds":10},"livenessProbe":{"tcpSocket":{"port":80},"initialDelaySeconds":15,"periodSeconds":20}}]}}}}'`);
// Q10 debug
await type('kubectl -n debug logs inventory | grep ERROR > /opt/answers/inventory-error.txt');
await type('kubectl -n debug delete pod inventory');
seedFile('inventory.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: inventory\n  namespace: debug\n  labels:\n    app: inventory\nspec:\n  containers:\n  - name: inventory\n    image: busybox:1.36\n    command: ["sh", "-c", "echo starting; sleep 3600"]\n    env:\n    - name: DB_HOST\n      valueFrom:\n        configMapKeyRef:\n          name: inventory-config\n          key: DB_HOST\n');
await type('kubectl apply -f inventory.yaml');
// Q11 legacy api
hostFs6('ckad-base', '/home/candidate/legacy/api-deploy.yaml', t => t.replace('extensions/v1beta1', 'apps/v1').replace('spec:\n  replicas: 2\n', 'spec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: legacy-api\n'));
m = since();
await type('kubectl apply -f ~/legacy/api-deploy.yaml');
expect('legacy manifest applies after the fix', 'deployment.apps/legacy-api created', m);
await type('echo apps/v1 > /opt/answers/legacy-api-version.txt');
// Q12 crd
m = since();
await type('kubectl get crd backups.data.mockctl.io -o jsonpath="{.spec.names.shortNames[0]}"');
expect('crd short name', 'bk', m);
await type('echo bk > /opt/answers/backup-shortname.txt');
seedFile('backup.yaml', 'apiVersion: data.mockctl.io/v1\nkind: Backup\nmetadata:\n  name: nightly\n  namespace: data\nspec:\n  source: pvc/data-pvc\n  schedule: "0 2 * * *"\n  retentionDays: 7\n');
m = since();
await type('kubectl apply -f backup.yaml');
expect('custom resource created', 'backup.data.mockctl.io/nightly created', m);
// Q13 configmap + secret
await type('kubectl -n config create configmap app-props --from-file=/home/candidate/config/app.properties');
await type(`kubectl -n config create secret generic app-creds --from-literal=username=admin --from-literal='password=S3cure!'`);
seedFile('app.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\n  namespace: config\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: app\n  template:\n    metadata:\n      labels:\n        app: app\n    spec:\n      volumes:\n      - name: props\n        configMap:\n          name: app-props\n      containers:\n      - name: nginx\n        image: nginx:1.27\n        volumeMounts:\n        - name: props\n          mountPath: /etc/app\n          readOnly: true\n        env:\n        - name: APP_USER\n          valueFrom:\n            secretKeyRef:\n              name: app-creds\n              key: username\n        - name: APP_PASS\n          valueFrom:\n            secretKeyRef:\n              name: app-creds\n              key: password\n');
await type('kubectl apply -f app.yaml');
// Q14 requests/limits
seedFile('worker.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: worker\n  namespace: limited\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: worker\n  template:\n    metadata:\n      labels:\n        app: worker\n    spec:\n      containers:\n      - name: worker\n        image: busybox:1.36\n        command: ["sleep", "3600"]\n        resources:\n          requests:\n            cpu: 200m\n            memory: 128Mi\n          limits:\n            cpu: 500m\n            memory: 256Mi\n');
await type('kubectl apply -f worker.yaml');
// Q15 sa + rbac + securityContext
await type('kubectl -n secure create serviceaccount app-sa');
await type('kubectl -n secure create role configmap-reader --verb=get,list --resource=configmaps');
await type('kubectl -n secure create rolebinding app-sa-configmaps --role=configmap-reader --serviceaccount=secure:app-sa');
seedFile('secure-app.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: secure-app\n  namespace: secure\nspec:\n  serviceAccountName: app-sa\n  securityContext:\n    runAsUser: 1000\n    runAsGroup: 3000\n    fsGroup: 2000\n  containers:\n  - name: app\n    image: busybox:1.36\n    command: ["sleep", "3600"]\n    securityContext:\n      allowPrivilegeEscalation: false\n      capabilities:\n        drop: ["ALL"]\n');
await type('kubectl apply -f secure-app.yaml');
// Q16 service fix + nodeport
await type(`kubectl -n shop patch svc cart -p '{"spec":{"type":"NodePort","selector":{"app":"cart"},"ports":[{"port":80,"targetPort":8080,"nodePort":30080}]}}'`);
// Q17 network policy
seedFile('netpol.yaml', 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: db-allow-api\n  namespace: shop\nspec:\n  podSelector:\n    matchLabels:\n      app: db\n  policyTypes:\n  - Ingress\n  ingress:\n  - from:\n    - podSelector:\n        matchLabels:\n          app: api\n    ports:\n    - protocol: TCP\n      port: 5432\n');
await type('kubectl apply -f netpol.yaml');
// Q18 ingress
m = since();
await type('kubectl -n shop create ingress shop-ingress --class=nginx --rule="shop.local/cart*=cart:80" --rule="shop.local/*=web:80"');
expect('ingress created', 'ingress.networking.k8s.io/shop-ingress created', m);
// jobs need a couple of run cycles (4 completions, 2 at a time)
await sleep(16000);
m = since();
await type('exam check');
for (let i = 1; i <= 18; i++) expect('exam6 Q' + i + ' pass', 'Question ' + i + ': PASS', m);
m = since();
await type('exam end');
expect('exam 6 final grade', 'PASS — 100%', m);

console.log(failures ? '\n' + failures + ' FAILURES' : '\nall checks passed');
process.exit(failures ? 1 : 0);
