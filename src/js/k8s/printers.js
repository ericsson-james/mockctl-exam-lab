/* k8s/printers.js — everything kubectl prints: tables per kind, describe,
   -o yaml/json/name/wide/jsonpath/custom-columns, top, api-resources. */

const Printers = {
  table(headers, rows, { noHeaders = false } = {}) {
    const all = noHeaders ? rows : [headers, ...rows];
    if (!all.length) return '';
    const widths = [];
    for (const r of all) r.forEach((c, i) => { widths[i] = Math.max(widths[i] || 0, String(c).length); });
    return all.map(r => r.map((c, i) => i === r.length - 1 ? String(c) : String(c).padEnd(widths[i])).join('   ').replace(/\s+$/, '')).join('\n');
  },

  age(obj) { return ageString(obj.metadata.creationTimestamp); },
  labelsString(labels) { return labels && Object.keys(labels).length ? Object.entries(labels).sort().map(([k, v]) => k + '=' + v).join(',') : '<none>'; },
  selectorString(sel) {
    if (!sel) return '<none>';
    const parts = Object.entries(sel.matchLabels || (sel.matchExpressions ? {} : sel)).map(([k, v]) => k + '=' + v);
    for (const e of sel.matchExpressions || []) {
      if (e.operator === 'In') parts.push(e.key + ' in (' + e.values.join(',') + ')');
      else if (e.operator === 'NotIn') parts.push(e.key + ' notin (' + e.values.join(',') + ')');
      else if (e.operator === 'Exists') parts.push(e.key);
      else parts.push('!' + e.key);
    }
    return parts.length ? parts.join(',') : '<none>';
  },
  accessModes(modes) { return (modes || []).map(m => ({ ReadWriteOnce: 'RWO', ReadOnlyMany: 'ROX', ReadWriteMany: 'RWX', ReadWriteOncePod: 'RWOP' }[m] || m)).join(','); },
  nodeRoles(node) {
    const roles = Object.keys(node.metadata.labels || {}).filter(k => k.startsWith('node-role.kubernetes.io/')).map(k => k.split('/')[1]);
    return roles.length ? roles.sort().join(',') : '<none>';
  },
  nodeStatus(cluster, node) {
    const ready = Sim.nodeReady(cluster, node);
    return (ready ? 'Ready' : 'NotReady') + (node.spec.unschedulable ? ',SchedulingDisabled' : '');
  },
  servicePorts(svc) {
    return (svc.spec.ports || []).map(p => p.port + (p.nodePort ? ':' + p.nodePort : '') + '/' + (p.protocol || 'TCP')).join(',') || '<none>';
  },
  podInfo(cluster, pod) { const st = cluster.simState(pod); return st.info || Sim.podPhaseInfo(cluster, pod, Date.now()); },

  /* ---------- get tables ---------- */
  rows(cluster, entry, objs, opts) {
    const wide = !!opts.wide;
    let headers, rows;
    const nameOf = (o) => opts.prefixKind ? cluster.kinds.fullName(entry, o.metadata.name) : o.metadata.name;
    switch (entry.kind) {
      case 'Pod': {
        headers = ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'];
        if (wide) headers.push('IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES');
        rows = objs.map(p => {
          const info = Printers.podInfo(cluster, p);
          const restarts = info.restarts ? info.restarts + ' (' + ageString(Date.now() - 20000) + ' ago)' : '0';
          const r = [nameOf(p), info.ready + '/' + info.total, info.statusText, restarts, Printers.age(p)];
          if (wide) r.push(p.status && p.status.podIP || '<none>', p.spec.nodeName || '<none>', '<none>', '<none>');
          return r;
        });
        break;
      }
      case 'Node': {
        headers = ['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'];
        if (wide) headers.push('INTERNAL-IP', 'EXTERNAL-IP', 'OS-IMAGE', 'KERNEL-VERSION', 'CONTAINER-RUNTIME');
        rows = objs.map(n => {
          const r = [n.metadata.name, Printers.nodeStatus(cluster, n), Printers.nodeRoles(n), Printers.age(n), n.status.nodeInfo.kubeletVersion];
          if (wide) r.push((n.status.addresses || []).find(a => a.type === 'InternalIP')?.address || '<none>', '<none>', n.status.nodeInfo.osImage, n.status.nodeInfo.kernelVersion, n.status.nodeInfo.containerRuntimeVersion);
          return r;
        });
        break;
      }
      case 'Deployment': {
        headers = ['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'];
        if (wide) headers.push('CONTAINERS', 'IMAGES', 'SELECTOR');
        rows = objs.map(d => {
          const s = d.status || {};
          const r = [nameOf(d), (s.readyReplicas || 0) + '/' + d.spec.replicas, s.updatedReplicas || 0, s.availableReplicas || 0, Printers.age(d)];
          if (wide) r.push(d.spec.template.spec.containers.map(c => c.name).join(','), d.spec.template.spec.containers.map(c => c.image).join(','), Printers.selectorString(d.spec.selector));
          return r;
        });
        break;
      }
      case 'ReplicaSet': {
        headers = ['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'];
        if (wide) headers.push('CONTAINERS', 'IMAGES', 'SELECTOR');
        rows = objs.map(rs => {
          const s = rs.status || {};
          const r = [nameOf(rs), rs.spec.replicas, s.replicas || 0, s.readyReplicas || 0, Printers.age(rs)];
          if (wide) r.push(rs.spec.template.spec.containers.map(c => c.name).join(','), rs.spec.template.spec.containers.map(c => c.image).join(','), Printers.selectorString(rs.spec.selector));
          return r;
        });
        break;
      }
      case 'DaemonSet': {
        headers = ['NAME', 'DESIRED', 'CURRENT', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'NODE SELECTOR', 'AGE'];
        if (wide) headers.push('CONTAINERS', 'IMAGES', 'SELECTOR');
        rows = objs.map(ds => {
          const s = ds.status || {};
          const r = [nameOf(ds), s.desiredNumberScheduled || 0, s.currentNumberScheduled || 0, s.numberReady || 0, s.updatedNumberScheduled || 0, s.numberAvailable || 0, Printers.labelsString(ds.spec.template.spec.nodeSelector), Printers.age(ds)];
          if (wide) r.push(ds.spec.template.spec.containers.map(c => c.name).join(','), ds.spec.template.spec.containers.map(c => c.image).join(','), Printers.selectorString(ds.spec.selector));
          return r;
        });
        break;
      }
      case 'StatefulSet':
        headers = ['NAME', 'READY', 'AGE'];
        if (wide) headers.push('CONTAINERS', 'IMAGES');
        rows = objs.map(s => { const r = [nameOf(s), ((s.status || {}).readyReplicas || 0) + '/' + s.spec.replicas, Printers.age(s)]; if (wide) r.push(s.spec.template.spec.containers.map(c => c.name).join(','), s.spec.template.spec.containers.map(c => c.image).join(',')); return r; });
        break;
      case 'Service':
        headers = ['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE'];
        if (wide) headers.push('SELECTOR');
        rows = objs.map(s => {
          const ext = s.spec.type === 'LoadBalancer' ? '<pending>' : s.spec.type === 'ExternalName' ? s.spec.externalName : '<none>';
          const r = [nameOf(s), s.spec.type, s.spec.clusterIP || '<none>', ext, Printers.servicePorts(s), Printers.age(s)];
          if (wide) r.push(Printers.labelsString(s.spec.selector));
          return r;
        });
        break;
      case 'Namespace':
        headers = ['NAME', 'STATUS', 'AGE'];
        rows = objs.map(n => [nameOf(n), (n.status || {}).phase || 'Active', Printers.age(n)]);
        break;
      case 'ConfigMap':
        headers = ['NAME', 'DATA', 'AGE'];
        rows = objs.map(c => [nameOf(c), Object.keys(c.data || {}).length + Object.keys(c.binaryData || {}).length, Printers.age(c)]);
        break;
      case 'Secret':
        headers = ['NAME', 'TYPE', 'DATA', 'AGE'];
        rows = objs.map(s => [nameOf(s), s.type || 'Opaque', Object.keys(s.data || {}).length, Printers.age(s)]);
        break;
      case 'ServiceAccount':
        headers = ['NAME', 'SECRETS', 'AGE'];
        rows = objs.map(s => [nameOf(s), (s.secrets || []).length, Printers.age(s)]);
        break;
      case 'PersistentVolume':
        headers = ['NAME', 'CAPACITY', 'ACCESS MODES', 'RECLAIM POLICY', 'STATUS', 'CLAIM', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'REASON', 'AGE'];
        rows = objs.map(pv => [nameOf(pv), (pv.spec.capacity || {}).storage || '', Printers.accessModes(pv.spec.accessModes), pv.spec.persistentVolumeReclaimPolicy, pv.status.phase, pv.spec.claimRef ? pv.spec.claimRef.namespace + '/' + pv.spec.claimRef.name : '', pv.spec.storageClassName || '', '<unset>', '', Printers.age(pv)]);
        break;
      case 'PersistentVolumeClaim':
        headers = ['NAME', 'STATUS', 'VOLUME', 'CAPACITY', 'ACCESS MODES', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'AGE'];
        rows = objs.map(pvc => [nameOf(pvc), pvc.status.phase, pvc.spec.volumeName || '', (pvc.status.capacity || {}).storage || '', Printers.accessModes(pvc.status.accessModes || (pvc.status.phase === 'Bound' ? pvc.spec.accessModes : [])), pvc.spec.storageClassName || '', '<unset>', Printers.age(pvc)]);
        break;
      case 'StorageClass':
        headers = ['NAME', 'PROVISIONER', 'RECLAIMPOLICY', 'VOLUMEBINDINGMODE', 'ALLOWVOLUMEEXPANSION', 'AGE'];
        rows = objs.map(sc => [nameOf(sc) + ((sc.metadata.annotations || {})['storageclass.kubernetes.io/is-default-class'] === 'true' ? ' (default)' : ''), sc.provisioner, sc.reclaimPolicy, sc.volumeBindingMode, sc.allowVolumeExpansion ? 'true' : 'false', Printers.age(sc)]);
        break;
      case 'NetworkPolicy':
        headers = ['NAME', 'POD-SELECTOR', 'AGE'];
        rows = objs.map(n => [nameOf(n), Printers.selectorString(n.spec.podSelector) === '<none>' ? '<none>' : Printers.selectorString(n.spec.podSelector), Printers.age(n)]);
        break;
      case 'Ingress':
        headers = ['NAME', 'CLASS', 'HOSTS', 'ADDRESS', 'PORTS', 'AGE'];
        rows = objs.map(i => [nameOf(i), i.spec.ingressClassName || '<none>', (i.spec.rules || []).map(r => r.host || '*').join(',') || '*', '', i.spec.tls ? '80, 443' : '80', Printers.age(i)]);
        break;
      case 'Role': case 'ClusterRole': case 'CustomResourceDefinition': case 'LimitRange':
        headers = ['NAME', 'CREATED AT'];
        rows = objs.map(r => [nameOf(r), r.metadata.creationTimestamp]);
        break;
      case 'RoleBinding': case 'ClusterRoleBinding':
        headers = ['NAME', 'ROLE', 'AGE'];
        if (wide) headers.push('USERS', 'GROUPS', 'SERVICEACCOUNTS');
        rows = objs.map(b => {
          const r = [nameOf(b), b.roleRef.kind + '/' + b.roleRef.name, Printers.age(b)];
          if (wide) { const sub = (k) => (b.subjects || []).filter(s => s.kind === k).map(s => s.kind === 'ServiceAccount' ? (s.namespace || '') + '/' + s.name : s.name).join(', '); r.push(sub('User'), sub('Group'), sub('ServiceAccount')); }
          return r;
        });
        break;
      case 'Job':
        headers = ['NAME', 'STATUS', 'COMPLETIONS', 'DURATION', 'AGE'];
        rows = objs.map(j => {
          const s = j.status || {};
          const done = s.conditions && s.conditions.some(c => c.type === 'Complete' && c.status === 'True');
          const dur = s.startTime ? durationString((s.completionTime ? Date.parse(s.completionTime) : Date.now()) - Date.parse(s.startTime)) : '';
          return [nameOf(j), done ? 'Complete' : 'Running', (s.succeeded || 0) + '/' + j.spec.completions, dur, Printers.age(j)];
        });
        break;
      case 'CronJob':
        headers = ['NAME', 'SCHEDULE', 'TIMEZONE', 'SUSPEND', 'ACTIVE', 'LAST SCHEDULE', 'AGE'];
        rows = objs.map(c => [nameOf(c), c.spec.schedule, c.spec.timeZone || '<none>', c.spec.suspend ? 'True' : 'False', 0, '<none>', Printers.age(c)]);
        break;
      case 'HorizontalPodAutoscaler':
        headers = ['NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS', 'AGE'];
        rows = objs.map(h => {
          const targets = (h.spec.metrics || []).map(m => m.resource ? 'cpu: <unknown>/' + (m.resource.target.averageUtilization !== undefined ? m.resource.target.averageUtilization + '%' : m.resource.target.averageValue) : '<unknown>').join(', ') || '<none>';
          return [nameOf(h), h.spec.scaleTargetRef.kind + '/' + h.spec.scaleTargetRef.name, targets, h.spec.minReplicas, h.spec.maxReplicas, (h.status || {}).currentReplicas || 0, Printers.age(h)];
        });
        break;
      case 'Endpoints':
        headers = ['NAME', 'ENDPOINTS', 'AGE'];
        rows = objs.map(e => [nameOf(e), Printers.endpointsString(e), Printers.age(e)]);
        break;
      case 'Event':
        headers = ['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'];
        rows = objs.map(e => [ageString(e.lastTimestamp), e.type, e.reason, e.involvedObject.kind.toLowerCase() + '/' + e.involvedObject.name, e.message]);
        break;
      case 'PriorityClass':
        headers = ['NAME', 'VALUE', 'GLOBAL-DEFAULT', 'AGE'];
        rows = objs.map(p => [nameOf(p), p.value, p.globalDefault ? 'true' : 'false', Printers.age(p)]);
        break;
      case 'PodDisruptionBudget':
        headers = ['NAME', 'MIN AVAILABLE', 'MAX UNAVAILABLE', 'ALLOWED DISRUPTIONS', 'AGE'];
        rows = objs.map(p => [nameOf(p), p.spec.minAvailable !== undefined ? p.spec.minAvailable : 'N/A', p.spec.maxUnavailable !== undefined ? p.spec.maxUnavailable : 'N/A', 0, Printers.age(p)]);
        break;
      case 'ResourceQuota':
        headers = ['NAME', 'AGE', 'REQUEST', 'LIMIT'];
        rows = objs.map(q => [nameOf(q), Printers.age(q), Object.entries((q.spec || {}).hard || {}).filter(([k]) => !k.startsWith('limits')).map(([k, v]) => k + ': 0/' + v).join(', '), Object.entries((q.spec || {}).hard || {}).filter(([k]) => k.startsWith('limits')).map(([k, v]) => k + ': 0/' + v).join(', ')]);
        break;
      case 'Gateway':
        headers = ['NAME', 'CLASS', 'ADDRESS', 'PROGRAMMED', 'AGE'];
        rows = objs.map(g => [nameOf(g), g.spec.gatewayClassName, '', 'True', Printers.age(g)]);
        break;
      case 'GatewayClass':
        headers = ['NAME', 'CONTROLLER', 'ACCEPTED', 'AGE'];
        rows = objs.map(g => [nameOf(g), g.spec.controllerName, 'True', Printers.age(g)]);
        break;
      case 'HTTPRoute':
        headers = ['NAME', 'HOSTNAMES', 'AGE'];
        rows = objs.map(r => [nameOf(r), JSON.stringify(r.spec.hostnames || []), Printers.age(r)]);
        break;
      default:
        headers = ['NAME', 'AGE'];
        rows = objs.map(o => [nameOf(o), Printers.age(o)]);
    }
    if (opts.allNamespaces && entry.namespaced && entry.kind !== 'Event') {
      headers.unshift('NAMESPACE');
      rows.forEach((r, i) => r.unshift(objs[i].metadata.namespace));
    }
    if (opts.allNamespaces && entry.kind === 'Event') {
      headers.unshift('NAMESPACE');
      rows.forEach((r, i) => r.unshift(objs[i].involvedObject.namespace || ''));
    }
    if (opts.showLabels) {
      headers.push('LABELS');
      rows.forEach((r, i) => r.push(Printers.labelsString(objs[i].metadata.labels)));
    }
    return { headers, rows };
  },

  getTable(cluster, entry, objs, opts) {
    const { headers, rows } = Printers.rows(cluster, entry, objs, opts || {});
    return Printers.table(headers, rows, { noHeaders: opts && opts.noHeaders });
  },

  endpointsString(ep) {
    const items = [];
    for (const s of ep.subsets || []) for (const a of s.addresses || []) for (const p of s.ports || []) items.push(a.ip + ':' + p.port);
    if (!items.length) return '<none>';
    return items.length > 3 ? items.slice(0, 3).join(',') + ' + ' + (items.length - 3) + ' more...' : items.join(',');
  },

  /* Endpoints objects are computed from Services. */
  endpointsFor(cluster, svc) {
    const podEntry = cluster.kinds.resolve('pod');
    const pods = svc.spec.selector && Object.keys(svc.spec.selector).length
      ? cluster.list(podEntry, svc.metadata.namespace).filter(p => labelsMatch({ matchLabels: svc.spec.selector }, p.metadata.labels) && Sim.isPodReady(cluster, p) && p.status && p.status.podIP)
      : [];
    const ep = { apiVersion: 'v1', kind: 'Endpoints', metadata: { name: svc.metadata.name, namespace: svc.metadata.namespace, creationTimestamp: svc.metadata.creationTimestamp, uid: svc.metadata.uid, labels: svc.metadata.labels }, subsets: [] };
    if (pods.length && (svc.spec.ports || []).length) {
      ep.subsets.push({
        addresses: pods.map(p => ({ ip: p.status.podIP, nodeName: p.spec.nodeName, targetRef: { kind: 'Pod', name: p.metadata.name, namespace: p.metadata.namespace, uid: p.metadata.uid } })),
        ports: svc.spec.ports.map(p => ({ name: p.name, port: Printers.resolveTargetPort(p.targetPort, pods[0]), protocol: p.protocol || 'TCP' })).map(p => { if (p.name === undefined) delete p.name; return p; }),
      });
    }
    return ep;
  },
  resolveTargetPort(tp, pod) {
    if (typeof tp === 'number') return tp;
    for (const c of (pod && pod.spec.containers) || []) for (const p of c.ports || []) if (p.name === tp) return p.containerPort;
    return parseInt(tp, 10) || 80;
  },
  eventObject(ev) {
    return { apiVersion: 'v1', kind: 'Event', metadata: { name: ev.involvedObject.name + '.' + shortHash(ev.reason + ev.message, 16), namespace: ev.involvedObject.namespace, creationTimestamp: ev.firstTimestamp }, type: ev.type, reason: ev.reason, message: ev.message, count: ev.count, firstTimestamp: ev.firstTimestamp, lastTimestamp: ev.lastTimestamp, involvedObject: ev.involvedObject, source: { component: ev.source } };
  },

  /* ---------- output formats ---------- */
  cleanForOutput(obj) {
    const c = deepClone(obj);
    delete c.metadata.ownerReferencesInternal;
    return c;
  },
  toYaml(objOrList) { return YAML.stringify(objOrList).replace(/\n$/, ''); },
  toJson(objOrList) { return JSON.stringify(objOrList, null, 4); },
  listOf(objs) { return { apiVersion: 'v1', items: objs, kind: 'List', metadata: { resourceVersion: '' } }; },

  /* ---------- jsonpath (kubectl subset) ---------- */
  jsonpath(expr, data) {
    let e = expr.trim();
    if (!e.includes('{')) e = '{' + e + '}';
    const tokens = [];
    let i = 0;
    while (i < e.length) {
      if (e[i] === '{') {
        const j = e.indexOf('}', i);
        if (j === -1) throw new KubectlError('unterminated jsonpath expression');
        tokens.push({ expr: e.slice(i + 1, j).trim() });
        i = j + 1;
      } else {
        const j = e.indexOf('{', i);
        tokens.push({ text: e.slice(i, j === -1 ? e.length : j) });
        i = j === -1 ? e.length : j;
      }
    }
    const out = [];
    const evalTokens = (toks, ctxData) => {
      let k = 0;
      while (k < toks.length) {
        const t = toks[k];
        if (t.text !== undefined) { out.push(t.text); k++; continue; }
        const ex = t.expr;
        if (ex.startsWith('range ')) {
          let depth = 1, end = k + 1;
          for (; end < toks.length; end++) {
            if (toks[end].expr !== undefined && toks[end].expr.startsWith('range ')) depth++;
            if (toks[end].expr === 'end') { depth--; if (depth === 0) break; }
          }
          const body = toks.slice(k + 1, end);
          for (const item of Printers.jpEval(ex.slice(6).trim(), ctxData)) evalTokens(body, item);
          k = end + 1;
          continue;
        }
        if (ex === 'end') { k++; continue; }
        if (/^"(.*)"$/.test(ex)) { out.push(JSON.parse(ex.replace(/\\n/g, '\\n'))); k++; continue; }
        const vals = Printers.jpEval(ex, ctxData);
        out.push(vals.map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)).join(' '));
        k++;
      }
    };
    evalTokens(tokens, data);
    return out.join('');
  },
  jpEval(path, data) {
    let p = path.trim().replace(/^@/, '').replace(/^\$/, '');
    let current = [data];
    const segs = [];
    let m;
    let rest = p;
    while (rest.length) {
      if ((m = rest.match(/^\.\.([A-Za-z0-9_\-/]+)/))) { segs.push({ deep: m[1] }); rest = rest.slice(m[0].length); continue; }
      if ((m = rest.match(/^\.?([A-Za-z0-9_\-/]+)/))) { segs.push({ key: m[1] }); rest = rest.slice(m[0].length); continue; }
      if ((m = rest.match(/^\['([^']+)'\]/))) { segs.push({ key: m[1] }); rest = rest.slice(m[0].length); continue; }
      if ((m = rest.match(/^\[\?\(@\.([A-Za-z0-9_.\-/]+)\s*(==|!=)\s*['"]?([^'")]*?)['"]?\)\]/))) { segs.push({ filter: { path: m[1], op: m[2], value: m[3] } }); rest = rest.slice(m[0].length); continue; }
      if ((m = rest.match(/^\[\*\]/))) { segs.push({ wild: true }); rest = rest.slice(m[0].length); continue; }
      if ((m = rest.match(/^\[(\d+)\]/))) { segs.push({ index: parseInt(m[1], 10) }); rest = rest.slice(m[0].length); continue; }
      if ((m = rest.match(/^\.\*/))) { segs.push({ wild: true }); rest = rest.slice(m[0].length); continue; }
      if (rest[0] === '.') { rest = rest.slice(1); continue; }
      throw new KubectlError('unrecognized character in jsonpath: ' + rest);
    }
    for (const s of segs) {
      const next = [];
      for (const v of current) {
        if (v === null || v === undefined) continue;
        if (s.key !== undefined) { if (Array.isArray(v)) v.forEach(x => x && x[s.key] !== undefined && next.push(x[s.key])); else if (v[s.key] !== undefined) next.push(v[s.key]); }
        else if (s.wild) { if (Array.isArray(v)) next.push(...v); else if (typeof v === 'object') next.push(...Object.values(v)); }
        else if (s.index !== undefined) { if (Array.isArray(v) && v[s.index] !== undefined) next.push(v[s.index]); }
        else if (s.filter) { if (Array.isArray(v)) for (const x of v) { const got = getPath(x, s.filter.path); const eq = String(got) === s.filter.value; if (s.filter.op === '==' ? eq : !eq) next.push(x); } }
        else if (s.deep) { const walk = (o) => { if (!o || typeof o !== 'object') return; if (!Array.isArray(o) && o[s.deep] !== undefined) next.push(o[s.deep]); for (const c of Object.values(o)) walk(c); }; walk(v); }
      }
      current = next;
    }
    return current;
  },

  customColumns(spec, objs) {
    const cols = spec.split(',').map(c => { const i = c.indexOf(':'); return { header: c.slice(0, i), path: c.slice(i + 1) }; });
    const rows = objs.map(o => cols.map(c => { const vals = Printers.jpEval(c.path, o); return vals.length ? vals.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(',') : '<none>'; }));
    return { headers: cols.map(c => c.header), rows };
  },

  /* ---------- top ---------- */
  podMetrics(cluster, pod) {
    const st = cluster.simState(pod);
    const h = parseInt(shortHash(pod.metadata.name, 8), 16);
    const info = Printers.podInfo(cluster, pod);
    const running = info.phase === 'Running' && info.ready > 0;
    return { cpu: st.cpu !== undefined ? st.cpu : (running ? 1 + (h % 40) : 0), mem: st.memory !== undefined ? st.memory : (running ? 8 + (h % 120) : 0) };
  },
  topPods(cluster, pods, { allNamespaces, sortBy, containers } = {}) {
    let rows = pods.map(p => { const m = Printers.podMetrics(cluster, p); return { p, m }; });
    if (sortBy === 'cpu') rows.sort((a, b) => b.m.cpu - a.m.cpu);
    else if (sortBy === 'memory') rows.sort((a, b) => b.m.mem - a.m.mem);
    const headers = ['NAME', 'CPU(cores)', 'MEMORY(bytes)'];
    const out = rows.map(r => [r.p.metadata.name, r.m.cpu + 'm', r.m.mem + 'Mi']);
    if (allNamespaces) { headers.unshift('NAMESPACE'); out.forEach((r, i) => r.unshift(rows[i].p.metadata.namespace)); }
    return Printers.table(headers, out);
  },
  topNodes(cluster, nodes, { sortBy } = {}) {
    const podEntry = cluster.kinds.resolve('pod');
    const rows = nodes.map(n => {
      const pods = cluster.list(podEntry, null).filter(p => p.spec.nodeName === n.metadata.name);
      let cpu = 120, mem = 620;
      for (const p of pods) { const m = Printers.podMetrics(cluster, p); cpu += m.cpu; mem += m.mem; }
      const capCpu = parseQuantity(n.status.capacity.cpu) * 1000, capMem = parseQuantity(n.status.capacity.memory) / (1024 * 1024);
      return { n, cpu, mem, cpuPct: Math.round(cpu / capCpu * 100), memPct: Math.round(mem / capMem * 100) };
    });
    if (sortBy === 'cpu') rows.sort((a, b) => b.cpu - a.cpu);
    if (sortBy === 'memory') rows.sort((a, b) => b.mem - a.mem);
    return Printers.table(['NAME', 'CPU(cores)', 'CPU%', 'MEMORY(bytes)', 'MEMORY%'], rows.map(r => [r.n.metadata.name, r.cpu + 'm', r.cpuPct + '%', r.mem + 'Mi', r.memPct + '%']));
  },

  apiResources(cluster, { namespaced } = {}) {
    let kinds = cluster.kinds.list();
    if (namespaced === true) kinds = kinds.filter(k => k.namespaced);
    if (namespaced === false) kinds = kinds.filter(k => !k.namespaced);
    return Printers.table(['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND'], kinds.map(k => [k.plural, k.short.join(','), k.apiVersion, k.namespaced ? 'true' : 'false', k.kind]));
  },

  /* ---------- describe ---------- */
  kv(label, value, w) { return (label + ':').padEnd(w || 18) + (value === undefined || value === null || value === '' ? '<none>' : value); },
  fmtDate(iso) { return new Date(iso).toUTCString().replace('GMT', '+0000'); },
  eventsBlock(cluster, obj) {
    const evs = cluster.eventsFor(obj);
    if (!evs.length) return 'Events:          <none>';
    const rows = evs.slice(-15).map(e => ['  ' + e.type, e.reason, ageString(e.lastTimestamp) + (e.count > 1 ? ' (x' + e.count + ' over ' + ageString(e.firstTimestamp) + ')' : ''), e.source, e.message]);
    return 'Events:\n' + Printers.table(['  Type', 'Reason', 'Age', 'From', 'Message'], [['  ----', '------', '----', '----', '-------'], ...rows]);
  },

  describe(cluster, entry, obj) {
    const L = [];
    const md = obj.metadata;
    const push = (label, value, w) => L.push(Printers.kv(label, value, w));
    const kvList = (label, map, w) => {
      const ents = Object.entries(map || {}).sort();
      if (!ents.length) return push(label, '<none>', w);
      ents.forEach(([k, v], i) => L.push((i === 0 ? (label + ':').padEnd(w || 18) : ' '.repeat(w || 18)) + k + '=' + v));
    };
    switch (entry.kind) {
      case 'Pod': {
        const info = Printers.podInfo(cluster, obj);
        const st = obj.status || {};
        push('Name', md.name); push('Namespace', md.namespace); push('Priority', obj.spec.priority || 0);
        push('Service Account', obj.spec.serviceAccountName);
        push('Node', obj.spec.nodeName ? obj.spec.nodeName + '/' + (st.hostIP || '') : '<none>');
        if (st.startTime) push('Start Time', Printers.fmtDate(st.startTime));
        kvList('Labels', md.labels); kvList('Annotations', md.annotations);
        push('Status', st.phase || 'Pending');
        if (obj.spec.nodeName && info.statusText === 'Pending' && !st.podIP) { /* nothing */ }
        push('IP', st.podIP || '');
        if (st.podIP) { L.push('IPs:'); L.push('  IP:  ' + st.podIP); }
        const ownerRefs = md.ownerReferences || [];
        if (ownerRefs.length) push('Controlled By', ownerRefs[0].kind + '/' + ownerRefs[0].name);
        const descContainers = (list, title) => {
          if (!list || !list.length) return;
          L.push(title + ':');
          for (const c of list) {
            const cs = (st.containerStatuses || []).find(s => s.name === c.name) || {};
            L.push('  ' + c.name + ':');
            L.push('    Container ID:   ' + (cs.state && (cs.state.running || cs.state.terminated) ? 'containerd://' + shortHash(md.uid + c.name, 64) : ''));
            L.push('    Image:          ' + c.image);
            L.push('    Image ID:       ' + (cs.state && cs.state.running ? 'docker.io/library/' + c.image.split('/').pop().split(':')[0] + '@sha256:' + shortHash(c.image, 64) : ''));
            if (c.ports && c.ports.length) { L.push('    Port' + (c.ports.length > 1 ? 's' : '') + ':          ' + c.ports.map(p => p.containerPort + '/' + (p.protocol || 'TCP')).join(', ')); L.push('    Host Port' + (c.ports.length > 1 ? 's' : '') + ':     ' + c.ports.map(p => (p.hostPort || 0) + '/' + (p.protocol || 'TCP')).join(', ')); }
            else { L.push('    Port:           <none>'); L.push('    Host Port:      <none>'); }
            if (c.command) L.push('    Command:\n' + c.command.map(x => '      ' + x).join('\n'));
            if (c.args) L.push('    Args:\n' + c.args.map(x => '      ' + x).join('\n'));
            const state = cs.state || { waiting: { reason: 'ContainerCreating' } };
            if (state.running) { L.push('    State:          Running'); L.push('      Started:      ' + Printers.fmtDate(state.running.startedAt)); }
            else if (state.waiting) { L.push('    State:          Waiting'); L.push('      Reason:       ' + state.waiting.reason); if (state.waiting.message) L.push('      Message:      ' + state.waiting.message); }
            else if (state.terminated) { L.push('    State:          Terminated'); L.push('      Reason:       ' + state.terminated.reason); L.push('      Exit Code:    ' + state.terminated.exitCode); }
            if (cs.lastState && cs.lastState.terminated) { L.push('    Last State:     Terminated'); L.push('      Reason:       ' + cs.lastState.terminated.reason); L.push('      Exit Code:    ' + cs.lastState.terminated.exitCode); }
            L.push('    Ready:          ' + (cs.ready ? 'True' : 'False'));
            L.push('    Restart Count:  ' + (cs.restartCount || 0));
            const res = c.resources || {};
            if (res.limits) { L.push('    Limits:'); for (const [k, v] of Object.entries(res.limits)) L.push('      ' + k + ':  ' + v); }
            if (res.requests) { L.push('    Requests:'); for (const [k, v] of Object.entries(res.requests)) L.push('      ' + k + ':  ' + v); }
            if (c.livenessProbe) L.push('    Liveness:       ' + Printers.probeString(c.livenessProbe));
            if (c.readinessProbe) L.push('    Readiness:      ' + Printers.probeString(c.readinessProbe));
            const envs = (c.env || []).map(e => '      ' + e.name + ':  ' + (e.value !== undefined ? e.value : e.valueFrom ? '<set to the key \'' + (e.valueFrom.configMapKeyRef || e.valueFrom.secretKeyRef || {}).key + '\' of ' + (e.valueFrom.configMapKeyRef ? 'config map' : 'secret') + ' \'' + (e.valueFrom.configMapKeyRef || e.valueFrom.secretKeyRef || {}).name + '\'>' : ''));
            if (c.envFrom) for (const ef of c.envFrom) envs.push('      ' + (ef.configMapRef ? ef.configMapRef.name + '  ConfigMap' : ef.secretRef.name + '  Secret') + '  Optional: false');
            L.push('    Environment:' + (envs.length ? '\n' + envs.join('\n') : '    <none>'));
            const mounts = (c.volumeMounts || []).map(m => '      ' + m.mountPath + ' from ' + m.name + ' (' + (m.readOnly ? 'ro' : 'rw') + ')');
            mounts.push('      /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access-' + shortHash(md.uid, 5) + ' (ro)');
            L.push('    Mounts:\n' + mounts.join('\n'));
          }
        };
        descContainers(obj.spec.initContainers, 'Init Containers');
        descContainers(obj.spec.containers, 'Containers');
        L.push('Conditions:'); L.push('  Type                        Status');
        for (const c of st.conditions || []) L.push('  ' + c.type.padEnd(28) + c.status);
        L.push('Volumes:');
        for (const v of obj.spec.volumes || []) {
          L.push('  ' + v.name + ':');
          if (v.configMap) { L.push('    Type:      ConfigMap (a volume populated by a ConfigMap)'); L.push('    Name:      ' + v.configMap.name); L.push('    Optional:  false'); }
          else if (v.secret) { L.push('    Type:        Secret (a volume populated by a Secret)'); L.push('    SecretName:  ' + v.secret.secretName); L.push('    Optional:    false'); }
          else if (v.persistentVolumeClaim) { L.push('    Type:       PersistentVolumeClaim (a reference to a PersistentVolumeClaim in the same namespace)'); L.push('    ClaimName:  ' + v.persistentVolumeClaim.claimName); L.push('    ReadOnly:   false'); }
          else if (v.hostPath) { L.push('    Type:          HostPath (bare host directory volume)'); L.push('    Path:          ' + v.hostPath.path); L.push('    HostPathType:  ' + (v.hostPath.type || '')); }
          else if (v.emptyDir) { L.push('    Type:       EmptyDir (a temporary directory that shares a pod\'s lifetime)'); L.push('    Medium:     ' + (v.emptyDir.medium || '')); L.push('    SizeLimit:  ' + (v.emptyDir.sizeLimit || '<unset>')); }
          else L.push('    Type:  ' + Object.keys(v).filter(k => k !== 'name')[0]);
        }
        L.push('  kube-api-access-' + shortHash(md.uid, 5) + ':');
        L.push('    Type:                    Projected (a volume that contains injected data from multiple sources)');
        L.push('    TokenExpirationSeconds:  3607');
        L.push('    ConfigMapName:           kube-root-ca.crt');
        L.push('    ConfigMapOptional:       <nil>');
        L.push('    DownwardAPI:             true');
        push('QoS Class', st.qosClass || 'BestEffort', 29);
        push('Node-Selectors', Printers.labelsString(obj.spec.nodeSelector), 29);
        const tols = (obj.spec.tolerations || []).map(t => t.key + (t.value ? '=' + t.value : '') + (t.effect ? ':' + t.effect : '') + (t.operator === 'Exists' ? ' op=Exists' : '') + (t.tolerationSeconds !== undefined ? ' for ' + t.tolerationSeconds + 's' : ''));
        tols.push('node.kubernetes.io/not-ready:NoExecute op=Exists for 300s', 'node.kubernetes.io/unreachable:NoExecute op=Exists for 300s');
        tols.forEach((t, i) => L.push((i === 0 ? 'Tolerations:'.padEnd(29) : ' '.repeat(29)) + t));
        L.push(Printers.eventsBlock(cluster, obj));
        break;
      }
      case 'Node': {
        push('Name', md.name); push('Roles', Printers.nodeRoles(obj));
        kvList('Labels', md.labels, 20); kvList('Annotations', md.annotations, 20);
        push('CreationTimestamp', Printers.fmtDate(md.creationTimestamp), 20);
        const taints = (obj.spec.taints || []).map(t => t.key + (t.value ? '=' + t.value : '') + ':' + t.effect);
        if (taints.length) taints.forEach((t, i) => L.push((i === 0 ? 'Taints:'.padEnd(20) : ' '.repeat(20)) + t)); else push('Taints', '<none>', 20);
        push('Unschedulable', obj.spec.unschedulable ? 'true' : 'false', 20);
        L.push('Conditions:');
        L.push('  Type             Status  Reason                       Message');
        L.push('  ----             ------  ------                       -------');
        for (const c of obj.status.conditions || []) L.push('  ' + c.type.padEnd(17) + c.status.padEnd(8) + c.reason.padEnd(29) + c.message);
        L.push('Addresses:');
        for (const a of obj.status.addresses || []) L.push('  ' + (a.type + ':').padEnd(13) + a.address);
        L.push('Capacity:'); for (const [k, v] of Object.entries(obj.status.capacity || {})) L.push('  ' + (k + ':').padEnd(20) + v);
        L.push('Allocatable:'); for (const [k, v] of Object.entries(obj.status.allocatable || obj.status.capacity || {})) L.push('  ' + (k + ':').padEnd(20) + v);
        L.push('System Info:');
        for (const [k, v] of Object.entries(obj.status.nodeInfo || {})) L.push('  ' + (k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()) + ':').padEnd(28) + v);
        const podEntry = cluster.kinds.resolve('pod');
        const pods = cluster.list(podEntry, null).filter(p => p.spec.nodeName === md.name);
        L.push('Non-terminated Pods:          (' + pods.length + ' in total)');
        L.push(Printers.table(['  Namespace', 'Name', 'CPU Requests', 'CPU Limits', 'Memory Requests', 'Memory Limits', 'Age'], [['  ---------', '----', '------------', '----------', '---------------', '-------------', '---'], ...pods.map(p => { const r = (p.spec.containers[0].resources || {}); const q = (x) => x ? x + ' (0%)' : '0 (0%)'; return ['  ' + p.metadata.namespace, p.metadata.name, q(r.requests && r.requests.cpu), q(r.limits && r.limits.cpu), q(r.requests && r.requests.memory), q(r.limits && r.limits.memory), Printers.age(p)]; })]));
        L.push(Printers.eventsBlock(cluster, obj));
        break;
      }
      case 'Deployment': {
        const s = obj.status || {};
        push('Name', md.name); push('Namespace', md.namespace); push('CreationTimestamp', Printers.fmtDate(md.creationTimestamp), 24);
        kvList('Labels', md.labels, 24); kvList('Annotations', md.annotations, 24);
        push('Selector', Printers.selectorString(obj.spec.selector), 24);
        push('Replicas', obj.spec.replicas + ' desired | ' + (s.updatedReplicas || 0) + ' updated | ' + (s.replicas || 0) + ' total | ' + (s.availableReplicas || 0) + ' available | ' + (s.unavailableReplicas || 0) + ' unavailable', 24);
        push('StrategyType', obj.spec.strategy.type, 24);
        push('MinReadySeconds', obj.spec.minReadySeconds || 0, 24);
        if (obj.spec.strategy.rollingUpdate) push('RollingUpdateStrategy', obj.spec.strategy.rollingUpdate.maxUnavailable + ' max unavailable, ' + obj.spec.strategy.rollingUpdate.maxSurge + ' max surge', 24);
        L.push('Pod Template:');
        L.push('  Labels:  ' + Printers.labelsString(obj.spec.template.metadata.labels));
        L.push('  Containers:');
        for (const c of obj.spec.template.spec.containers) {
          L.push('   ' + c.name + ':'); L.push('    Image:         ' + c.image);
          L.push('    Port:          ' + ((c.ports || []).map(p => p.containerPort + '/' + (p.protocol || 'TCP')).join(', ') || '<none>'));
          L.push('    Host Port:     ' + ((c.ports || []).map(p => '0/' + (p.protocol || 'TCP')).join(', ') || '<none>'));
          if (c.command) L.push('    Command:\n' + c.command.map(x => '      ' + x).join('\n'));
          L.push('    Environment:   ' + ((c.env || []).map(e => e.name + ': ' + e.value).join(', ') || '<none>'));
          L.push('    Mounts:        ' + ((c.volumeMounts || []).map(m => m.mountPath + ' from ' + m.name).join(', ') || '<none>'));
        }
        L.push('  Volumes:         ' + ((obj.spec.template.spec.volumes || []).map(v => v.name).join(', ') || '<none>'));
        L.push('  Node-Selectors:  ' + Printers.labelsString(obj.spec.template.spec.nodeSelector));
        L.push('  Tolerations:     ' + ((obj.spec.template.spec.tolerations || []).map(t => t.key + (t.value ? '=' + t.value : '') + ':' + (t.effect || '')).join(', ') || '<none>'));
        L.push('Conditions:'); L.push('  Type           Status  Reason'); L.push('  ----           ------  ------');
        for (const c of s.conditions || []) L.push('  ' + c.type.padEnd(15) + c.status.padEnd(8) + c.reason);
        const rsEntry = cluster.kinds.resolve('rs');
        const owned = cluster.list(rsEntry, md.namespace).filter(rs => ownedBy(rs, obj));
        const hash = shortHash(JSON.stringify(obj.spec.template), 9);
        const cur = owned.find(rs => (rs.metadata.labels || {})['pod-template-hash'] === hash);
        push('OldReplicaSets', owned.filter(rs => rs !== cur).map(rs => rs.metadata.name + ' (' + (rs.status ? rs.status.replicas : 0) + '/' + rs.spec.replicas + ' replicas created)').join(', ') || '<none>', 18);
        push('NewReplicaSet', cur ? cur.metadata.name + ' (' + (cur.status ? cur.status.replicas : 0) + '/' + cur.spec.replicas + ' replicas created)' : '<none>', 18);
        L.push(Printers.eventsBlock(cluster, obj));
        break;
      }
      case 'Service': {
        push('Name', md.name); push('Namespace', md.namespace); kvList('Labels', md.labels); kvList('Annotations', md.annotations);
        push('Selector', Printers.labelsString(obj.spec.selector)); push('Type', obj.spec.type);
        push('IP Family Policy', obj.spec.ipFamilyPolicy); push('IP Families', (obj.spec.ipFamilies || []).join(','));
        push('IP', obj.spec.clusterIP); push('IPs', (obj.spec.clusterIPs || []).join(','));
        const ep = Printers.endpointsFor(cluster, obj);
        for (const p of obj.spec.ports || []) {
          push('Port', (p.name || '<unset>') + '  ' + p.port + '/' + p.protocol);
          push('TargetPort', p.targetPort + '/' + p.protocol);
          if (p.nodePort) push('NodePort', (p.name || '<unset>') + '  ' + p.nodePort + '/' + p.protocol);
          push('Endpoints', (ep.subsets[0] ? ep.subsets[0].addresses.map(a => a.ip + ':' + Printers.resolveTargetPort(p.targetPort, null)).join(',') : '<none>'));
        }
        push('Session Affinity', obj.spec.sessionAffinity);
        if (obj.spec.externalTrafficPolicy) push('External Traffic Policy', obj.spec.externalTrafficPolicy);
        push('Internal Traffic Policy', obj.spec.internalTrafficPolicy);
        push('Events', '<none>');
        break;
      }
      case 'PersistentVolumeClaim': {
        push('Name', md.name); push('Namespace', md.namespace); push('StorageClass', obj.spec.storageClassName || ''); push('Status', obj.status.phase);
        push('Volume', obj.spec.volumeName || ''); kvList('Labels', md.labels); kvList('Annotations', md.annotations);
        push('Finalizers', '[kubernetes.io/pvc-protection]'); push('Capacity', (obj.status.capacity || {}).storage || '');
        push('Access Modes', Printers.accessModes(obj.status.accessModes)); push('VolumeMode', obj.spec.volumeMode);
        const podEntry = cluster.kinds.resolve('pod');
        push('Used By', cluster.list(podEntry, md.namespace).filter(p => (p.spec.volumes || []).some(v => v.persistentVolumeClaim && v.persistentVolumeClaim.claimName === md.name)).map(p => p.metadata.name).join(', ') || '<none>');
        L.push(Printers.eventsBlock(cluster, obj));
        break;
      }
      case 'PersistentVolume': {
        push('Name', md.name); kvList('Labels', md.labels); kvList('Annotations', md.annotations);
        push('Finalizers', '[kubernetes.io/pv-protection]'); push('StorageClass', obj.spec.storageClassName || ''); push('Status', obj.status.phase);
        push('Claim', obj.spec.claimRef ? obj.spec.claimRef.namespace + '/' + obj.spec.claimRef.name : ''); push('Reclaim Policy', obj.spec.persistentVolumeReclaimPolicy);
        push('Access Modes', Printers.accessModes(obj.spec.accessModes)); push('VolumeMode', obj.spec.volumeMode); push('Capacity', obj.spec.capacity.storage);
        push('Node Affinity', '<none>'); push('Message', '');
        L.push('Source:');
        const src = Object.keys(obj.spec).find(k => ['hostPath', 'nfs', 'local', 'csi', 'awsElasticBlockStore', 'gcePersistentDisk'].includes(k));
        if (src) { L.push('    Type:          ' + src); for (const [k, v] of Object.entries(obj.spec[src])) L.push('    ' + (k + ':').padEnd(15) + v); }
        push('Events', '<none>');
        break;
      }
      case 'Namespace': {
        push('Name', md.name); kvList('Labels', md.labels); kvList('Annotations', md.annotations); push('Status', obj.status.phase);
        L.push(''); L.push('No resource quota.'); L.push(''); L.push('No LimitRange resource.');
        break;
      }
      case 'ConfigMap': case 'Secret': {
        push('Name', md.name); push('Namespace', md.namespace); kvList('Labels', md.labels); kvList('Annotations', md.annotations);
        if (entry.kind === 'Secret') push('Type', obj.type);
        L.push(''); L.push('Data'); L.push('====');
        for (const [k, v] of Object.entries(obj.data || {})) { L.push(k + ':'); L.push('----'); L.push(entry.kind === 'Secret' ? String(atob(v).length) + ' bytes' : String(v).replace(/\n$/, '')); L.push(''); }
        L.push(''); L.push('BinaryData'); L.push('===='); L.push(''); L.push('Events:  <none>');
        break;
      }
      default: {
        push('Name', md.name);
        if (md.namespace) push('Namespace', md.namespace);
        kvList('Labels', md.labels); kvList('Annotations', md.annotations);
        const rest = deepClone(obj); delete rest.metadata; delete rest.apiVersion; delete rest.kind;
        const y = YAML.stringify(rest).replace(/\n$/, '');
        if (y !== '{}') L.push(y.replace(/^(\S)/gm, '$1'));
        L.push(Printers.eventsBlock(cluster, obj));
      }
    }
    return L.join('\n');
  },
  probeString(p) {
    const kind = p.httpGet ? 'http-get http://:' + p.httpGet.port + p.httpGet.path : p.tcpSocket ? 'tcp-socket :' + p.tcpSocket.port : p.exec ? 'exec ' + JSON.stringify(p.exec.command) : '';
    return kind + ' delay=' + (p.initialDelaySeconds || 0) + 's timeout=' + (p.timeoutSeconds || 1) + 's period=' + (p.periodSeconds || 10) + 's #success=' + (p.successThreshold || 1) + ' #failure=' + (p.failureThreshold || 3);
  },
};
