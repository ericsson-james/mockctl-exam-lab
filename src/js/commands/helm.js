/* commands/helm.js — a small Helm 3 for the lab. Repositories and charts come
   from the exam spec (spec.helm), releases live per cluster, and rendered
   manifests go through the same API-server path as kubectl apply, so rollouts,
   pods and events behave normally afterwards.

   spec.helm = {
     added: { stable: "https://charts.example.com/stable" },     // repos already on the base host
     repos: {
       "https://charts.example.com/stable": {
         charts: {
           podinfo: {
             versions: ["6.4.0", "6.5.1"],                          // ascending; latest is the default
             appVersion: "6.5.1", appVersions: { "6.4.0": "6.4.0" },
             description: "...", values: { replicaCount: 1, ... },
             notes: "text with {{ .Release.Name }}",
             manifests: [ { ...object with {{ .Release.Name }} / {{ .Values.x }} placeholders, "_if": ".Values.ingress.enabled" } ]
           }
         }
       }
     }
   }
   A string that is exactly one placeholder keeps the value's type, so
   "replicas": "{{ .Values.replicaCount }}" becomes a number. Pipelines support
   `default`, `quote`, `upper`, `lower`, `int`. Objects with `_if` are dropped
   when the expression is falsy. */

const HELM_VERSION = 'v3.16.2';
const HELM_VALUE_FLAGS = new Set(['namespace', 'version', 'set', 'set-string', 'values', 'kube-context', 'timeout', 'output', 'description', 'max', 'filter', 'kubeconfig', 'repo']);
const HELM_BOOL_FLAGS = new Set(['install', 'create-namespace', 'all-namespaces', 'versions', 'wait', 'atomic', 'dry-run', 'debug', 'all', 'devel', 'help', 'short', 'reuse-values', 'reset-values', 'force', 'keep-history', 'no-hooks', 'cleanup-on-fail', 'uninstalled', 'deployed', 'failed', 'pending', 'superseded', 'date', 'reverse', 'skip-crds', 'generate-name', 'wait-for-jobs']);
const HELM_SHORT = { n: 'namespace', f: 'values', A: 'all-namespaces', o: 'output', i: 'install', a: 'all', l: 'filter', h: 'help', g: 'generate-name', d: 'date', r: 'reverse', m: 'max' };
const HELM_MULTI = new Set(['set', 'set-string', 'values']);

const helmFail = (msg) => new RawError('Error: ' + msg);

function helmParse(args) {
  const flags = {}, positional = [];
  const set = (k, v) => { if (HELM_MULTI.has(k)) (flags[k] = flags[k] || []).push(v); else flags[k] = v; };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      let name = a.slice(2), val;
      const eq = name.indexOf('=');
      if (eq !== -1) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      if (HELM_BOOL_FLAGS.has(name)) { set(name, val === undefined ? true : val !== 'false'); continue; }
      if (!HELM_VALUE_FLAGS.has(name)) throw helmFail('unknown flag: --' + name);
      if (val === undefined) { if (i + 1 >= args.length) throw helmFail('flag needs an argument: --' + name); val = args[++i]; }
      set(name, val);
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      const ch = a[1], name = HELM_SHORT[ch];
      if (!name) throw helmFail("unknown shorthand flag: '" + ch + "' in " + a);
      if (HELM_BOOL_FLAGS.has(name)) { set(name, true); continue; }
      let val = a.slice(2);
      if (val.startsWith('=')) val = val.slice(1);
      if (!val) { if (i + 1 >= args.length) throw helmFail("flag needs an argument: '" + ch + "' in " + a); val = args[++i]; }
      set(name, val);
      continue;
    }
    positional.push(a);
  }
  return { flags, positional };
}

/* --set a.b=1,c=x  (values are typed unless asString) */
function helmApplySet(target, expr, asString) {
  const parts = []; let cur = '', depth = 0, q = null;
  for (const ch of expr) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  const coerce = (raw) => {
    raw = raw.trim();
    if (/^".*"$/.test(raw) || /^'.*'$/.test(raw)) return raw.slice(1, -1);
    if (asString) return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    return raw;
  };
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) throw helmFail('failed parsing --set data: key "' + p + '" has no value');
    const key = p.slice(0, eq).trim();
    let raw = p.slice(eq + 1).trim();
    const val = /^\{.*\}$/.test(raw) ? raw.slice(1, -1).split(',').map(coerce).filter(v => v !== '') : coerce(raw);
    setPath(target, key, val);
  }
}

function helmRender(chart, chartName, ctxv) {
  const vars = { Release: { Name: ctxv.release, Namespace: ctxv.namespace, Service: 'Helm', IsInstall: ctxv.isInstall !== false, IsUpgrade: ctxv.isInstall === false }, Chart: { Name: chartName, Version: ctxv.version, AppVersion: ctxv.appVersion }, Values: ctxv.values };
  const literal = (s) => /^["'].*["']$/.test(s) ? s.slice(1, -1) : /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s === 'true' ? true : s === 'false' ? false : getPath(vars, s.replace(/^\./, ''));
  const evalExpr = (e) => {
    const segs = e.split('|').map(s => s.trim());
    let v = literal(segs[0]);
    for (const f of segs.slice(1)) {
      const d = f.match(/^default\s+(.+)$/);
      if (d) { if (v === undefined || v === null || v === '' || v === false || v === 0) v = literal(d[1]); }
      else if (f === 'quote' || f === 'toString') v = String(v);
      else if (f === 'upper') v = String(v).toUpperCase();
      else if (f === 'lower') v = String(v).toLowerCase();
      else if (f === 'int') v = parseInt(v, 10);
      else if (f === 'toYaml' || f === 'toJson') v = v;
    }
    return v;
  };
  const renderString = (s) => {
    const whole = s.match(/^\{\{-?\s*([^}]+?)\s*-?\}\}$/);
    if (whole) return evalExpr(whole[1]);
    return s.replace(/\{\{-?\s*([^}]+?)\s*-?\}\}/g, (m, e) => { const v = evalExpr(e); return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); });
  };
  const walk = (node) => {
    if (typeof node === 'string') return renderString(node);
    if (Array.isArray(node)) return node.map(walk);
    if (isPlainObject(node)) { const o = {}; for (const [k, v] of Object.entries(node)) { if (k === '_if') continue; o[renderString(k)] = walk(v); } return o; }
    return node;
  };
  const out = [];
  for (const m of chart.manifests || []) {
    if (m._if !== undefined) { const c = evalExpr(String(m._if)); if (!c || (Array.isArray(c) && !c.length)) continue; }
    const obj = walk(m);
    obj.metadata = obj.metadata || {};
    obj.metadata.labels = Object.assign({ 'app.kubernetes.io/managed-by': 'Helm', 'app.kubernetes.io/instance': ctxv.release, 'helm.sh/chart': chartName + '-' + ctxv.version }, obj.metadata.labels || {});
    obj.metadata.annotations = Object.assign({ 'meta.helm.sh/release-name': ctxv.release, 'meta.helm.sh/release-namespace': ctxv.namespace }, obj.metadata.annotations || {});
    out.push(obj);
  }
  const notes = chart.notes ? renderString(String(chart.notes)) : '';
  return { objects: out, notes };
}

function semverCmp(a, b) {
  const pa = String(a).split(/[.-]/).map(x => (/^\d+$/.test(x) ? parseInt(x, 10) : x));
  const pb = String(b).split(/[.-]/).map(x => (/^\d+$/.test(x) ? parseInt(x, 10) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] === undefined ? 0 : pa[i], y = pb[i] === undefined ? 0 : pb[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

function helmWorld(world) {
  if (!world.helm) world.helm = { repos: new Map(Object.entries((world.spec.helm && world.spec.helm.added) || {})) };
  return world.helm;
}
function helmStore(cluster) { return (cluster.helm = cluster.helm || { releases: new Map() }); }
const helmKey = (ns, name) => ns + '/' + name;
const helmNow = () => new Date().toISOString().replace('T', ' ').replace('Z', '') + '000 +0000 UTC';
const helmDeployedAt = () => { const d = new Date(); return d.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1 $3 $2 $5 $4'); };

/* repo/chart -> { repoName, url, chartName, chart } */
function helmResolveChart(world, ref, failPrefix) {
  const helm = helmWorld(world);
  const catalog = (world.spec.helm && world.spec.helm.repos) || {};
  const m = String(ref).match(/^([^/]+)\/([^/]+)$/);
  if (!m) {
    if (/^(\.|\/|~)/.test(ref)) throw helmFail(failPrefix + 'path "' + ref + '" not found');
    throw helmFail(failPrefix + 'failed to download "' + ref + '"' + (ref.includes('/') ? '' : ' (hint: use REPO/CHART, see \'helm search repo\')'));
  }
  const url = helm.repos.get(m[1]);
  if (!url || !catalog[url]) throw helmFail(failPrefix + 'failed to download "' + ref + '"' + (!url ? ' (repo "' + m[1] + '" not found; add it with \'helm repo add\')' : ''));
  const chart = (catalog[url].charts || {})[m[2]];
  if (!chart) throw helmFail(failPrefix + 'chart "' + m[2] + '" not found in ' + m[1] + ' index. (try \'helm repo update\'): no chart name found');
  return { repoName: m[1], url, chartName: m[2], chart };
}
function helmPickVersion(res, wanted, failPrefix) {
  const versions = (res.chart.versions || ['1.0.0']).slice().sort(semverCmp);
  if (!wanted) return versions[versions.length - 1];
  if (!versions.includes(wanted)) throw helmFail(failPrefix + 'chart "' + res.chartName + '" matching ' + wanted + ' not found in ' + res.repoName + ' index. (try \'helm repo update\'): no chart version found for ' + res.chartName + '-' + wanted);
  return wanted;
}
const helmAppVersion = (chart, version) => (chart.appVersions && chart.appVersions[version]) || chart.appVersion || version;

function helmReadValues(ctx, flags) {
  const s = ctx.session;
  let values = {};
  for (const f of flags.values || []) {
    let text;
    try { text = s.fs.readFile(s.resolvePath(f), s.user); } catch (e) { throw helmFail('open ' + f + ': no such file or directory'); }
    let doc;
    try { doc = YAML.parse(text) || {}; } catch (e) { throw helmFail('failed to parse ' + f + ': ' + e.message); }
    values = deepMerge(values, doc);
  }
  for (const e of flags.set || []) helmApplySet(values, e, false);
  for (const e of flags['set-string'] || []) helmApplySet(values, e, true);
  return values;
}

function helmReleaseSecret(cluster, rel, revision, status) {
  const name = 'sh.helm.release.v1.' + rel.name + '.v' + revision;
  cluster.apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: rel.namespace, labels: { name: rel.name, owner: 'helm', status, version: String(revision), modifiedAt: String(Math.floor(Date.now() / 1000)) } }, type: 'helm.sh/release.v1', data: { release: btoa('H4sIAAAAAAAC/' + shortHash(rel.name + ':' + revision, 48)) } }, { defaultNamespace: rel.namespace });
}
function helmDeleteSecrets(cluster, rel) {
  const entry = cluster.kinds.resolve('secret');
  for (const s of cluster.list(entry, rel.namespace)) if (s.metadata.name.startsWith('sh.helm.release.v1.' + rel.name + '.v')) { try { cluster.delete(entry, rel.namespace, s.metadata.name, { cascade: false }); } catch (e) { /* gone */ } }
}

/* Apply rendered objects for a release; remove objects the previous revision had that are gone now. */
function helmApplyObjects(cluster, rel, objects, failPrefix, isInstall) {
  for (const obj of objects) {
    const entry = cluster.entryFor(obj);
    if (entry.namespaced) obj.metadata.namespace = obj.metadata.namespace || rel.namespace;
    const existing = cluster.get(entry, obj.metadata.namespace, obj.metadata.name);
    if (existing) {
      const md = existing.metadata, lbl = md.labels || {}, ann = md.annotations || {};
      const owned = lbl['app.kubernetes.io/managed-by'] === 'Helm' && ann['meta.helm.sh/release-name'] === rel.name && ann['meta.helm.sh/release-namespace'] === rel.namespace;
      if (!owned) {
        const why = lbl['app.kubernetes.io/managed-by'] !== 'Helm' ? 'label validation error: missing key "app.kubernetes.io/managed-by": must be set to "Helm"' : 'annotation validation error: key "meta.helm.sh/release-name" must equal "' + rel.name + '": current value is "' + ann['meta.helm.sh/release-name'] + '"';
        throw helmFail(failPrefix + 'Unable to continue with ' + (isInstall ? 'install' : 'update') + ': ' + existing.kind + ' "' + md.name + '" in namespace "' + (md.namespace || '') + '" exists and cannot be imported into the current release: invalid ownership metadata; ' + why);
      }
    }
  }
  const refs = [];
  for (const obj of objects) {
    const { obj: stored } = cluster.apply(obj, { defaultNamespace: rel.namespace });
    refs.push({ kind: stored.kind, apiVersion: stored.apiVersion, namespace: stored.metadata.namespace, name: stored.metadata.name });
  }
  for (const old of rel.objects || []) {
    if (refs.some(r => r.kind === old.kind && r.namespace === old.namespace && r.name === old.name)) continue;
    const entry = cluster.kinds.byKind(old.kind, old.apiVersion);
    try { if (entry) cluster.delete(entry, old.namespace, old.name, { cascade: true }); } catch (e) { /* already gone */ }
  }
  return refs;
}

function helmStatusBlock(rel, notes) {
  const lines = ['NAME: ' + rel.name, 'LAST DEPLOYED: ' + rel.deployedAt, 'NAMESPACE: ' + rel.namespace, 'STATUS: ' + rel.status, 'REVISION: ' + rel.revision, 'TEST SUITE: None'];
  if (notes) lines.push('NOTES:', notes.replace(/\n$/, ''));
  return lines.join('\n');
}

function helmDeploy(cluster, world, { name, namespace, res, version, values, description, isInstall, existing }) {
  const failPrefix = isInstall ? 'INSTALLATION FAILED: ' : 'UPGRADE FAILED: ';
  const appVersion = helmAppVersion(res.chart, version);
  const merged = deepMerge(deepClone(res.chart.values || {}), values);
  const rendered = helmRender(res.chart, res.chartName, { release: name, namespace, version, appVersion, values: merged, isInstall });
  const rel = existing || { name, namespace, objects: [], history: [], revision: 0 };
  rel.chart = res.chartName; rel.repo = res.repoName; rel.chartVersion = version; rel.appVersion = appVersion;
  rel.values = values; rel.merged = merged; rel.notes = rendered.notes;
  const prevRevision = rel.revision;
  rel.objects = helmApplyObjects(cluster, rel, rendered.objects, failPrefix, isInstall);
  rel.revision = prevRevision + 1;
  rel.status = 'deployed';
  rel.updated = helmNow(); rel.deployedAt = helmDeployedAt();
  for (const h of rel.history) if (h.status === 'deployed') h.status = 'superseded';
  rel.history.push({ revision: rel.revision, updated: rel.updated, status: 'deployed', chart: res.chartName + '-' + version, appVersion, description: description || (isInstall ? 'Install complete' : 'Upgrade complete'), chartVersion: version, values: deepClone(values) });
  for (const h of rel.history) if (h.revision !== rel.revision && h.status === 'superseded') { /* keep */ }
  helmReleaseSecret(cluster, rel, rel.revision, 'deployed');
  helmStore(cluster).releases.set(helmKey(namespace, name), rel);
  Sim.reconcile(cluster);
  return rel;
}

registry.register({
  name: 'helm', usage: 'helm <command> [args] [flags]', desc: 'the Kubernetes package manager',
  async run(ctx, args, io) {
    if (ctx.session.host.role !== 'base') throw new RawError('bash: helm: command not found');
    const world = ctx.app.world;
    const { flags, positional } = helmParse(args);
    const sub = positional[0];
    const target = () => ctx.app.kubectl.target(ctx, { namespace: flags.namespace, context: flags['kube-context'], kubeconfig: flags.kubeconfig });
    const helm = helmWorld(world);
    const catalog = (world.spec.helm && world.spec.helm.repos) || {};

    if (!sub || flags.help || sub === 'help') {
      io.out('The Kubernetes package manager\n\nCommon actions for Helm:\n\n- helm search:    search for charts\n- helm pull:      download a chart to your local directory to view\n- helm install:   upload the chart to Kubernetes\n- helm list:      list releases of charts\n\nAvailable Commands:\n  get         download extended information of a named release\n  history     fetch release history\n  install     install a chart\n  list        list releases\n  repo        add, list, remove, update, and index chart repositories\n  rollback    roll back a release to a previous revision\n  search      search for a keyword in charts\n  show        show information of a chart\n  status      display the status of the named release\n  template    locally render templates\n  uninstall   uninstall a release\n  upgrade     upgrade a release\n  version     print the client version information\n\nFlags:\n  -n, --namespace string   namespace scope for this request\n      --kube-context string   name of the kubeconfig context to use');
      return;
    }
    if (sub === 'version') { io.out((flags.short ? HELM_VERSION : 'version.BuildInfo{Version:"' + HELM_VERSION + '", GitCommit:"13654a52f7ae5ebb4a6b1c0b9d1b8e5e3b4ceb4b", GitTreeState:"clean", GoVersion:"go1.22.7"}')); return; }
    if (sub === 'env') { io.out('HELM_BIN="helm"\nHELM_CACHE_HOME="/home/' + ctx.session.user.name + '/.cache/helm"\nHELM_CONFIG_HOME="/home/' + ctx.session.user.name + '/.config/helm"\nHELM_NAMESPACE="' + (flags.namespace || target().ns) + '"\nHELM_REPOSITORY_CONFIG="/home/' + ctx.session.user.name + '/.config/helm/repositories.yaml"'); return; }

    if (sub === 'repo') {
      const op = positional[1];
      if (op === 'add') {
        const [name, url] = positional.slice(2);
        if (!name || !url) throw helmFail('"helm repo add" requires 2 arguments\n\nUsage:  helm repo add [NAME] [URL] [flags]');
        if (!catalog[url]) throw helmFail('looks like "' + url + '" is not a valid chart repository or cannot be reached: failed to fetch ' + url.replace(/\/$/, '') + '/index.yaml : 404 Not Found');
        if (helm.repos.has(name) && helm.repos.get(name) !== url) throw helmFail('repository name (' + name + ') already exists, please specify a different name');
        helm.repos.set(name, url);
        io.out('"' + name + '" has been added to your repositories');
        return;
      }
      if (op === 'list' || op === 'ls') {
        if (!helm.repos.size) throw helmFail('no repositories to show');
        io.out(Printers.table(['NAME', 'URL'], [...helm.repos.entries()].map(([n, u]) => [n, u])));
        return;
      }
      if (op === 'remove' || op === 'rm') {
        for (const n of positional.slice(2)) { if (!helm.repos.delete(n)) throw helmFail('no repo named "' + n + '" found'); io.out('"' + n + '" has been removed from your repositories'); }
        return;
      }
      if (op === 'update' || op === 'up') {
        if (!helm.repos.size) throw helmFail('no repositories found. You must add one before updating');
        io.out('Hang tight while we grab the latest from your chart repositories...');
        for (const n of helm.repos.keys()) io.out('...Successfully got an update from the "' + n + '" chart repository');
        io.out('Update Complete. ⎈Happy Helming!⎈');
        return;
      }
      throw helmFail('unknown command "helm repo ' + (op || '') + '"\n\nUsage:  helm repo [command] (add, list, remove, update)');
    }

    if (sub === 'search') {
      if (positional[1] !== 'repo') throw helmFail('unknown command "helm search ' + (positional[1] || '') + '" (only "helm search repo" is available here)');
      const kw = (positional[2] || '').toLowerCase();
      const rows = [];
      for (const [rname, url] of helm.repos) {
        for (const [cname, chart] of Object.entries((catalog[url] || {}).charts || {})) {
          const full = rname + '/' + cname;
          if (kw && !full.toLowerCase().includes(kw) && !String(chart.description || '').toLowerCase().includes(kw)) continue;
          const versions = (chart.versions || ['1.0.0']).slice().sort(semverCmp).reverse();
          for (const v of (flags.versions ? versions : versions.slice(0, 1))) rows.push([full, v, helmAppVersion(chart, v), chart.description || '']);
        }
      }
      if (!rows.length) { io.out('No results found'); return; }
      io.out(Printers.table(['NAME', 'CHART VERSION', 'APP VERSION', 'DESCRIPTION'], rows));
      return;
    }

    if (sub === 'show' || sub === 'inspect') {
      const what = positional[1], ref = positional[2];
      if (!ref) throw helmFail('"helm show ' + (what || '') + '" requires 1 argument');
      const res = helmResolveChart(world, ref, '');
      const version = helmPickVersion(res, flags.version, '');
      if (what === 'values') { io.out(YAML.stringify(res.chart.values || {}).replace(/\n$/, '')); return; }
      if (what === 'chart' || what === 'all') { io.out(YAML.stringify({ apiVersion: 'v2', appVersion: helmAppVersion(res.chart, version), description: res.chart.description || '', name: res.chartName, type: 'application', version }).replace(/\n$/, '')); if (what === 'all') io.out('---\n' + YAML.stringify(res.chart.values || {}).replace(/\n$/, '')); return; }
      if (what === 'readme') { io.out(res.chart.readme || '# ' + res.chartName + '\n\n' + (res.chart.description || '')); return; }
      throw helmFail('unknown command "helm show ' + (what || '') + '" (values, chart, readme, all)');
    }

    const t = target();
    const store = helmStore(t.cluster);
    const ns = flags.namespace || t.ns;

    if (sub === 'install' || sub === 'upgrade') {
      const isInstall = sub === 'install';
      const failPrefix = isInstall ? 'INSTALLATION FAILED: ' : 'UPGRADE FAILED: ';
      let name = positional[1], ref = positional[2];
      if (isInstall && flags['generate-name'] && !ref) { ref = name; name = undefined; }
      if (!ref) throw helmFail('"helm ' + sub + '" requires 2 arguments\n\nUsage:  helm ' + sub + ' [' + (isInstall ? 'NAME' : 'RELEASE') + '] [CHART] [flags]');
      const res = helmResolveChart(world, ref, failPrefix);
      const version = helmPickVersion(res, flags.version, failPrefix);
      if (!name) name = res.chartName + '-' + Date.now().toString(36).slice(-6);
      if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 53) throw helmFail(failPrefix + 'release name "' + name + '": invalid release name, must match regex ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ and the length must not be longer than 53');
      const values = helmReadValues(ctx, flags);
      const existing = store.releases.get(helmKey(ns, name));
      if (isInstall && existing) throw helmFail(failPrefix + 'cannot re-use a name that is still in use');
      if (!isInstall && !existing && !flags.install) throw helmFail(failPrefix + '"' + name + '" has no deployed releases');
      if (!t.cluster.namespaceExists(ns)) {
        if (!flags['create-namespace']) throw helmFail(failPrefix + 'create: failed to create: namespaces "' + ns + '" not found');
        t.cluster.create({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels: { 'kubernetes.io/metadata.name': ns } }, spec: {} });
      }
      if (flags['dry-run']) {
        const merged = deepMerge(deepClone(res.chart.values || {}), values);
        const r = helmRender(res.chart, res.chartName, { release: name, namespace: ns, version, appVersion: helmAppVersion(res.chart, version), values: merged, isInstall });
        io.out('NAME: ' + name + '\nLAST DEPLOYED: ' + helmDeployedAt() + '\nNAMESPACE: ' + ns + '\nSTATUS: pending-' + (isInstall ? 'install' : 'upgrade') + '\nREVISION: ' + ((existing ? existing.revision : 0) + 1) + '\nTEST SUITE: None\nHOOKS:\nMANIFEST:');
        for (const o of r.objects) io.out('---\n# Source: ' + res.chartName + '/templates/' + o.kind.toLowerCase() + '.yaml\n' + YAML.stringify(o).replace(/\n$/, ''));
        return;
      }
      const effectiveValues = !isInstall && existing && flags['reuse-values'] ? deepMerge(deepClone(existing.values || {}), values) : values;
      const rel = helmDeploy(t.cluster, world, { name, namespace: ns, res, version, values: effectiveValues, description: flags.description, isInstall: isInstall || !existing, existing: isInstall ? null : existing });
      if (!isInstall && existing) io.out('Release "' + name + '" has been upgraded. Happy Helming!');
      io.out(helmStatusBlock(rel, rel.notes));
      return;
    }

    if (sub === 'uninstall' || sub === 'delete' || sub === 'del' || sub === 'un') {
      const names = positional.slice(1);
      if (!names.length) throw helmFail('"helm uninstall" requires at least 1 argument\n\nUsage:  helm uninstall RELEASE_NAME [...] [flags]');
      for (const name of names) {
        const rel = store.releases.get(helmKey(ns, name));
        if (!rel) throw helmFail('uninstall: Release not loaded: ' + name + ': release: not found');
        for (const ref of rel.objects) { const entry = t.cluster.kinds.byKind(ref.kind, ref.apiVersion); try { if (entry) t.cluster.delete(entry, ref.namespace, ref.name, { cascade: true }); } catch (e) { /* gone */ } }
        if (!flags['keep-history']) { helmDeleteSecrets(t.cluster, rel); store.releases.delete(helmKey(ns, name)); }
        else { rel.status = 'uninstalled'; rel.objects = []; }
        Sim.reconcile(t.cluster);
        io.out('release "' + name + '" uninstalled');
      }
      return;
    }

    if (sub === 'rollback') {
      const name = positional[1];
      if (!name) throw helmFail('"helm rollback" requires at least 1 argument\n\nUsage:  helm rollback <RELEASE> [REVISION] [flags]');
      const rel = store.releases.get(helmKey(ns, name));
      if (!rel) throw helmFail('release: not found');
      const wanted = positional[2] !== undefined ? parseInt(positional[2], 10) : rel.revision - 1;
      const h = rel.history.find(x => x.revision === wanted);
      if (!h || wanted < 1) throw helmFail('release has no ' + wanted + ' version');
      const res = helmResolveChart(world, rel.repo + '/' + rel.chart, '');
      helmDeploy(t.cluster, world, { name, namespace: ns, res, version: h.chartVersion, values: deepClone(h.values || {}), description: 'Rollback to ' + wanted, isInstall: false, existing: rel });
      io.out('Rollback was a success! Happy Helming!');
      return;
    }

    if (sub === 'list' || sub === 'ls') {
      const rels = [...store.releases.values()].filter(r => flags['all-namespaces'] || r.namespace === ns).filter(r => !flags.filter || new RegExp(flags.filter).test(r.name)).sort((a, b) => a.name.localeCompare(b.name));
      if (flags.short || flags.output === 'name') { io.out(rels.map(r => r.name).join('\n')); return; }
      if (!rels.length && !flags['all-namespaces']) { io.out(Printers.table(['NAME', 'NAMESPACE', 'REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION'], [])); return; }
      io.out(Printers.table(['NAME', 'NAMESPACE', 'REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION'], rels.map(r => [r.name, r.namespace, String(r.revision), r.updated, r.status, r.chart + '-' + r.chartVersion, r.appVersion])));
      return;
    }

    if (sub === 'status') {
      const rel = store.releases.get(helmKey(ns, positional[1]));
      if (!positional[1]) throw helmFail('"helm status" requires 1 argument');
      if (!rel) throw helmFail('release: not found');
      io.out(helmStatusBlock(rel, rel.notes));
      return;
    }
    if (sub === 'history' || sub === 'hist') {
      const rel = store.releases.get(helmKey(ns, positional[1]));
      if (!positional[1]) throw helmFail('"helm history" requires 1 argument');
      if (!rel) throw helmFail('release: not found');
      io.out(Printers.table(['REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION', 'DESCRIPTION'], rel.history.map(h => [String(h.revision), h.updated, h.status, h.chart, h.appVersion, h.description])));
      return;
    }
    if (sub === 'get') {
      const what = positional[1], rel = store.releases.get(helmKey(ns, positional[2]));
      if (!positional[2]) throw helmFail('"helm get ' + (what || '') + '" requires 1 argument');
      if (!rel) throw helmFail('release: not found');
      if (what === 'values') { const v = flags.all ? rel.merged : rel.values; io.out(flags.all ? 'COMPUTED VALUES:' : 'USER-SUPPLIED VALUES:'); io.out(Object.keys(v || {}).length ? YAML.stringify(v).replace(/\n$/, '') : 'null'); return; }
      if (what === 'manifest' || what === 'all') {
        const res = helmResolveChart(world, rel.repo + '/' + rel.chart, '');
        const r = helmRender(res.chart, res.chartName, { release: rel.name, namespace: rel.namespace, version: rel.chartVersion, appVersion: rel.appVersion, values: rel.merged, isInstall: false });
        for (const o of r.objects) io.out('---\n# Source: ' + res.chartName + '/templates/' + o.kind.toLowerCase() + '.yaml\n' + YAML.stringify(o).replace(/\n$/, ''));
        return;
      }
      if (what === 'notes') { io.out(rel.notes || ''); return; }
      throw helmFail('unknown command "helm get ' + (what || '') + '" (values, manifest, notes, all)');
    }
    if (sub === 'template') {
      let name = positional[1], ref = positional[2];
      if (!ref) { ref = name; name = 'release-name'; }
      if (!ref) throw helmFail('"helm template" requires at least 1 argument');
      const res = helmResolveChart(world, ref, '');
      const version = helmPickVersion(res, flags.version, '');
      const merged = deepMerge(deepClone(res.chart.values || {}), helmReadValues(ctx, flags));
      const r = helmRender(res.chart, res.chartName, { release: name, namespace: ns, version, appVersion: helmAppVersion(res.chart, version), values: merged, isInstall: true });
      for (const o of r.objects) io.out('---\n# Source: ' + res.chartName + '/templates/' + o.kind.toLowerCase() + '.yaml\n' + YAML.stringify(o).replace(/\n$/, ''));
      return;
    }
    if (sub === 'pull' || sub === 'create' || sub === 'package' || sub === 'lint' || sub === 'dependency' || sub === 'push' || sub === 'test' || sub === 'plugin' || sub === 'registry') throw helmFail('"helm ' + sub + '" is not available in this lab (charts come from the configured repositories)');
    throw helmFail('unknown command "helm ' + sub + '" for "helm"\n\nRun \'helm --help\' for usage.');
  },
});
