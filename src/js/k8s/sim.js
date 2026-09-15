/* k8s/sim.js — the simulator: pod status derived from age and simulation
   state, the scheduler, and the controllers. reconcile() runs after every
   mutating command; refresh() recomputes observable status before reads. */

const KNOWN_IMAGES = /^(docker\.io\/)?(library\/)?(nginx|busybox|alpine|ubuntu|debian|redis|httpd|memcached|postgres|mysql|mongo|python|node|golang|traefik|haproxy|envoy|fluentd|fluent-bit|prometheus|grafana|tomcat|jenkins|wordpress|caddy|registry|hello-world|perl|ruby|php|java|openjdk|amazonlinux|centos|fedora|rockylinux|bitnami\/[a-z-]+|kubernetesui\/[a-z-]+|k8s\.gcr\.io\/[a-z0-9./-]+|registry\.k8s\.io\/[a-z0-9./-]+|gcr\.io\/[a-z0-9./-]+|quay\.io\/[a-z0-9./-]+|ghcr\.io\/[a-z0-9./-]+|docker\.io\/[a-z0-9./-]+|nicolaka\/netshoot|curlimages\/curl|wbitt\/network-multitool|jonlabelle\/network-tools|inanimate\/echo-server|hashicorp\/http-echo|kicbase\/echo-server|gcr\.io\/google-samples\/[a-z0-9-]+|registry\.k8s\.io\/e2e-test-images\/[a-z0-9-]+|jmalloc\/echo-server|stefanprodan\/podinfo|traefik\/whoami|paulbouwer\/hello-kubernetes|rancher\/[a-z-]+|calico\/[a-z-]+|flannel\/[a-z-]+|weaveworks\/[a-z-]+|metallb\/[a-z-]+|kube-[a-z-]+|coredns\/coredns|library\/[a-z-]+|[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?\/[a-z0-9._/-]+)(:[\w.-]+)?(@sha256:[a-f0-9]+)?$/;

function imagePullable(image, cluster) {
  const s = String(image || '');
  if (cluster.badImages && cluster.badImages.some(b => s === b)) return false;
  if (/broken|nonexistent|doesnotexist|typo|-bad\b|:v?\d+(\.\d+)+-(alpne|alphine|alpin|aplin|slim-bad)\b|:[\d.]+-?(latset|lastest)$/.test(s)) return false;
  return KNOWN_IMAGES.test(s);
}

function labelsMatch(selector, labels) {
  labels = labels || {};
  if (!selector) return true;
  const ml = selector.matchLabels || (selector.matchExpressions ? {} : selector);
  for (const [k, v] of Object.entries(ml)) if (labels[k] !== v) return false;
  for (const e of selector.matchExpressions || []) {
    const has = k => Object.prototype.hasOwnProperty.call(labels, k);
    if (e.operator === 'In' && !(has(e.key) && e.values.includes(labels[e.key]))) return false;
    if (e.operator === 'NotIn' && has(e.key) && e.values.includes(labels[e.key])) return false;
    if (e.operator === 'Exists' && !has(e.key)) return false;
    if (e.operator === 'DoesNotExist' && has(e.key)) return false;
  }
  return true;
}

/* kubectl -l syntax: a=b, a!=b, a, !a, a in (x,y), a notin (x,y) */
function parseLabelSelector(str) {
  const sel = { matchLabels: {}, matchExpressions: [] };
  if (!str) return sel;
  for (const raw of str.split(/,(?![^(]*\))/)) {
    const s = raw.trim();
    if (!s) continue;
    let m;
    if ((m = s.match(/^(\S+)\s+notin\s+\((.*)\)$/i))) sel.matchExpressions.push({ key: m[1], operator: 'NotIn', values: m[2].split(',').map(x => x.trim()) });
    else if ((m = s.match(/^(\S+)\s+in\s+\((.*)\)$/i))) sel.matchExpressions.push({ key: m[1], operator: 'In', values: m[2].split(',').map(x => x.trim()) });
    else if ((m = s.match(/^([^!=]+)!=(.*)$/))) sel.matchExpressions.push({ key: m[1], operator: 'NotIn', values: [m[2]] });
    else if ((m = s.match(/^([^!=]+)==?(.*)$/))) sel.matchLabels[m[1]] = m[2];
    else if (s.startsWith('!')) sel.matchExpressions.push({ key: s.slice(1), operator: 'DoesNotExist' });
    else sel.matchExpressions.push({ key: s, operator: 'Exists' });
  }
  return sel;
}

function ownerRef(obj, controller) {
  return { apiVersion: obj.apiVersion, kind: obj.kind, name: obj.metadata.name, uid: obj.metadata.uid, controller: !!controller, blockOwnerDeletion: true };
}
function ownedBy(obj, owner) { return (obj.metadata.ownerReferences || []).some(r => r.uid === owner.metadata.uid); }

const Sim = {
  /* ----- node status ----- */
  nodeReady(cluster, node) {
    const host = cluster.nodeHost(node.metadata.name);
    if (!host) return true;
    const k = host.service('kubelet');
    return host.up && (!k || k.active);
  },

  refreshNode(cluster, node) {
    const ready = Sim.nodeReady(cluster, node);
    const host = cluster.nodeHost(node.metadata.name);
    const now = new Date().toISOString();
    node.status = node.status || {};
    node.status.conditions = [
      { type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory', message: 'kubelet has sufficient memory available', lastHeartbeatTime: now, lastTransitionTime: node.metadata.creationTimestamp },
      { type: 'DiskPressure', status: 'False', reason: 'KubeletHasNoDiskPressure', message: 'kubelet has no disk pressure', lastHeartbeatTime: now, lastTransitionTime: node.metadata.creationTimestamp },
      { type: 'PIDPressure', status: 'False', reason: 'KubeletHasSufficientPID', message: 'kubelet has sufficient PID available', lastHeartbeatTime: now, lastTransitionTime: node.metadata.creationTimestamp },
      ready
        ? { type: 'Ready', status: 'True', reason: 'KubeletReady', message: 'kubelet is posting ready status', lastHeartbeatTime: now, lastTransitionTime: node.metadata.creationTimestamp }
        : { type: 'Ready', status: 'Unknown', reason: 'NodeStatusUnknown', message: 'Kubelet stopped posting node status.', lastHeartbeatTime: now, lastTransitionTime: now },
    ];
    if (host) {
      node.status.nodeInfo = node.status.nodeInfo || {};
      const v = host.runningKubeletVersion || cluster.version;
      node.status.nodeInfo.kubeletVersion = 'v' + v;
      node.status.nodeInfo.kubeProxyVersion = 'v' + v;
    }
    // NoExecute-style taint the node controller would add
    const taints = (node.spec.taints || []).filter(t => !t.key.startsWith('node.kubernetes.io/'));
    if (!ready) taints.push({ key: 'node.kubernetes.io/unreachable', effect: 'NoSchedule' }, { key: 'node.kubernetes.io/unreachable', effect: 'NoExecute' });
    if (node.spec.unschedulable) taints.push({ key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' });
    node.spec.taints = taints.length ? taints : undefined;
    if (node.spec.taints === undefined) delete node.spec.taints;
  },

  /* ----- scheduling ----- */
  tolerates(pod, taint) {
    for (const t of pod.spec.tolerations || []) {
      const keyOk = !t.key || t.key === taint.key;
      const effOk = !t.effect || t.effect === taint.effect;
      const valOk = t.operator === 'Exists' || !t.key || t.value === taint.value || (t.value === undefined && taint.value === undefined);
      if (keyOk && effOk && valOk) return true;
    }
    return false;
  },

  nodeAffinityOk(pod, node) {
    const req = pod.spec.affinity && pod.spec.affinity.nodeAffinity && pod.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution;
    if (!req) return true;
    const labels = node.metadata.labels || {};
    return (req.nodeSelectorTerms || []).some(term => {
      const exprs = term.matchExpressions || [];
      return exprs.every(e => {
        const has = e.key in labels;
        if (e.operator === 'In') return has && e.values.includes(labels[e.key]);
        if (e.operator === 'NotIn') return !has || !e.values.includes(labels[e.key]);
        if (e.operator === 'Exists') return has;
        if (e.operator === 'DoesNotExist') return !has;
        if (e.operator === 'Gt') return has && parseFloat(labels[e.key]) > parseFloat(e.values[0]);
        if (e.operator === 'Lt') return has && parseFloat(labels[e.key]) < parseFloat(e.values[0]);
        return true;
      });
    });
  },

  schedule(cluster, pod) {
    const nodes = cluster.nodes();
    const reasons = {};
    const add = (r) => { reasons[r] = (reasons[r] || 0) + 1; };
    const candidates = [];
    for (const node of nodes) {
      const labels = node.metadata.labels || {};
      if (pod.spec.nodeName && pod.spec.nodeName !== node.metadata.name) continue;
      if (!Sim.nodeReady(cluster, node)) { add('node(s) had untolerated taint {node.kubernetes.io/unreachable: }'); continue; }
      if (node.spec.unschedulable && !Sim.tolerates(pod, { key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' })) { add('node(s) were unschedulable'); continue; }
      const ns = pod.spec.nodeSelector || {};
      if (!Object.entries(ns).every(([k, v]) => labels[k] === v) || !Sim.nodeAffinityOk(pod, node)) { add("node(s) didn't match Pod's node affinity/selector"); continue; }
      const taint = (node.spec.taints || []).find(t => (t.effect === 'NoSchedule' || t.effect === 'NoExecute') && !t.key.startsWith('node.kubernetes.io/') && !Sim.tolerates(pod, t));
      if (taint) { add('node(s) had untolerated taint {' + taint.key + ': ' + (taint.value || '') + '}'); continue; }
      candidates.push(node);
    }
    if (pod.spec.nodeName && !nodes.some(n => n.metadata.name === pod.spec.nodeName)) {
      return { node: null, message: 'node "' + pod.spec.nodeName + '" not found' };
    }
    // unbound PVCs block scheduling
    for (const v of pod.spec.volumes || []) {
      if (v.persistentVolumeClaim) {
        const pvc = cluster.getByKindName('PersistentVolumeClaim', pod.metadata.namespace, v.persistentVolumeClaim.claimName);
        if (!pvc) return { node: null, message: 'persistentvolumeclaim "' + v.persistentVolumeClaim.claimName + '" not found' };
        if (pvc.status.phase !== 'Bound') {
          const sc = pvc.spec.storageClassName && cluster.getByKindName('StorageClass', null, pvc.spec.storageClassName);
          if (!(sc && sc.volumeBindingMode === 'WaitForFirstConsumer')) return { node: null, message: 'pod has unbound immediate PersistentVolumeClaims. preemption: 0/' + nodes.length + ' nodes are available' };
        }
      }
    }
    if (!candidates.length) {
      const total = nodes.length;
      const parts = Object.entries(reasons).map(([r, n]) => n + ' ' + r);
      return { node: null, message: '0/' + total + ' nodes are available: ' + parts.join(', ') + '. preemption: 0/' + total + ' nodes are available: ' + total + ' Preemption is not helpful for scheduling.' };
    }
    const podEntry = cluster.kinds.resolve('pod');
    const load = (n) => cluster.list(podEntry, null).filter(p => p.spec.nodeName === n.metadata.name).length;
    candidates.sort((a, b) => load(a) - load(b) || a.metadata.name.localeCompare(b.metadata.name));
    return { node: candidates[0] };
  },

  /* ----- pod status ----- */
  podPhaseInfo(cluster, pod, now) {
    const st = cluster.simState(pod);
    const age = (now - (st.scheduledAt || st.createdAt)) / 1000;
    const containers = pod.spec.containers;
    const isJob = (pod.metadata.ownerReferences || []).some(r => r.kind === 'Job') || (pod.spec.restartPolicy !== 'Always' && st.runSeconds !== undefined);
    const info = { phase: 'Running', ready: 0, total: containers.length, restarts: 0, statusText: 'Running', cstates: [] };
    if (st.staticComponent) {
      const prob = cluster.staticPodProblem(st.staticComponent);
      st.forcedStatus = prob ? 'CrashLoopBackOff' : undefined;
    }

    if (!pod.spec.nodeName) {
      info.phase = 'Pending'; info.statusText = 'Pending';
      info.cstates = containers.map(c => ({ name: c.name, image: c.image, ready: false, restartCount: 0, started: false, state: { waiting: { reason: 'ContainerCreating' } } }));
      return info;
    }
    if (st.forcedStatus) {
      info.statusText = st.forcedStatus; info.phase = st.forcedStatus === 'Running' ? 'Running' : 'Pending';
    }
    const initCount = (pod.spec.initContainers || []).length;
    if (initCount && age < 4) {
      info.phase = 'Pending'; info.statusText = 'Init:0/' + initCount;
      info.cstates = containers.map(c => ({ name: c.name, image: c.image, ready: false, restartCount: 0, started: false, state: { waiting: { reason: 'PodInitializing' } } }));
      return info;
    }
    const startDelay = initCount ? 4 : 0;
    let anyWaiting = null;
    for (const c of containers) {
      const bad = !imagePullable(c.image, cluster);
      const crash = st.crash === true || (Array.isArray(st.crash) && st.crash.includes(c.name)) || /^(exit 1|false)$/.test((c.args || c.command || []).join(' ').trim()) || ((c.command || []).join(' ').match(/\bexit [1-9]/));
      const cs = { name: c.name, image: c.image, imageID: '', ready: false, restartCount: 0, started: false };
      if (age < startDelay + 2) {
        cs.state = { waiting: { reason: 'ContainerCreating' } }; anyWaiting = anyWaiting || 'ContainerCreating';
      } else if (bad) {
        const reason = age < 15 ? 'ErrImagePull' : 'ImagePullBackOff';
        cs.state = { waiting: { reason, message: 'Back-off pulling image "' + c.image + '"' } }; anyWaiting = anyWaiting || reason;
      } else if (crash) {
        cs.restartCount = Math.min(50, Math.floor((age - 2) / 10));
        const inBackoff = Math.floor(age) % 10 < 8;
        cs.state = inBackoff ? { waiting: { reason: 'CrashLoopBackOff', message: 'back-off restarting failed container' } } : { running: { startedAt: new Date(now).toISOString() } };
        cs.lastState = { terminated: { exitCode: 1, reason: 'Error', finishedAt: new Date(now - 1000).toISOString() } };
        anyWaiting = anyWaiting || (inBackoff ? 'CrashLoopBackOff' : 'Error');
      } else if (isJob && age >= (st.runSeconds !== undefined ? st.runSeconds : 5) + 2) {
        cs.state = { terminated: { exitCode: 0, reason: 'Completed', startedAt: new Date(st.createdAt + 2000).toISOString(), finishedAt: new Date(now).toISOString() } };
        cs.ready = false;
      } else {
        cs.state = { running: { startedAt: new Date(st.createdAt + 2000).toISOString() } };
        cs.ready = true; cs.started = true;
      }
      info.cstates.push(cs);
      if (cs.ready) info.ready++;
      info.restarts += cs.restartCount;
    }
    if (info.cstates.length && info.cstates.every(c => c.state.terminated)) {
      info.phase = 'Succeeded'; info.statusText = 'Completed';
    } else if (anyWaiting === 'ContainerCreating') {
      info.phase = 'Pending'; info.statusText = 'ContainerCreating';
    } else if (anyWaiting) {
      info.phase = anyWaiting.startsWith('ErrImage') || anyWaiting === 'ImagePullBackOff' ? 'Pending' : 'Running';
      info.statusText = anyWaiting;
    }
    if (st.forcedStatus) info.statusText = st.forcedStatus;
    return info;
  },

  refreshPod(cluster, pod, now) {
    const st = cluster.simState(pod);
    const info = Sim.podPhaseInfo(cluster, pod, now);
    st.info = info;
    const status = {
      phase: info.phase,
      qosClass: pod.spec.containers.every(c => c.resources && c.resources.limits && c.resources.requests && JSON.stringify(c.resources.limits) === JSON.stringify(c.resources.requests)) ? 'Guaranteed' : pod.spec.containers.some(c => c.resources && (c.resources.requests || c.resources.limits)) ? 'Burstable' : 'BestEffort',
    };
    if (pod.spec.nodeName) {
      const host = cluster.nodeHost(pod.spec.nodeName);
      status.hostIP = host ? host.ip : (cluster.node(pod.spec.nodeName) && (cluster.node(pod.spec.nodeName).status.addresses || [{}])[0].address) || '10.0.0.1';
      if (!st.podIP) st.podIP = cluster.allocPodIp(pod.spec.nodeName);
      status.podIP = st.podIP;
      status.podIPs = [{ ip: st.podIP }];
      status.startTime = new Date(st.scheduledAt || st.createdAt).toISOString();
      status.containerStatuses = info.cstates;
      const ready = info.ready === info.total && info.phase === 'Running';
      status.conditions = [
        { type: 'PodReadyToStartContainers', status: 'True', lastTransitionTime: status.startTime },
        { type: 'Initialized', status: 'True', lastTransitionTime: status.startTime },
        { type: 'Ready', status: ready ? 'True' : 'False', lastTransitionTime: status.startTime },
        { type: 'ContainersReady', status: ready ? 'True' : 'False', lastTransitionTime: status.startTime },
        { type: 'PodScheduled', status: 'True', lastTransitionTime: status.startTime },
      ];
    } else {
      status.conditions = [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: st.scheduleMessage || 'no nodes available', lastTransitionTime: new Date(st.createdAt).toISOString() }];
    }
    pod.status = status;
  },

  isPodReady(cluster, pod) {
    const st = cluster.simState(pod);
    return !!(st.info && st.info.phase === 'Running' && st.info.ready === st.info.total);
  },

  /* ----- controllers ----- */
  podFromTemplate(cluster, owner, template, name, extra) {
    const pod = {
      apiVersion: 'v1', kind: 'Pod',
      metadata: {
        name, namespace: owner.metadata.namespace,
        labels: Object.assign({}, template.metadata.labels || {}, extra && extra.labels || {}),
        annotations: template.metadata.annotations ? deepClone(template.metadata.annotations) : undefined,
        ownerReferences: [ownerRef(owner, true)],
      },
      spec: deepClone(template.spec),
    };
    if (!pod.metadata.annotations) delete pod.metadata.annotations;
    if (extra && extra.nodeName) pod.spec.nodeName = extra.nodeName;
    return cluster.create(pod, { sim: extra && extra.sim || {} });
  },

  reconcileDeployments(cluster) {
    const entry = cluster.kinds.resolve('deploy');
    for (const d of cluster.list(entry, null)) {
      const rsEntry = cluster.kinds.resolve('rs');
      const owned = cluster.list(rsEntry, d.metadata.namespace).filter(rs => ownedBy(rs, d));
      const tmpl = deepClone(d.spec.template);
      const hash = shortHash(JSON.stringify(tmpl), 9);
      let current = owned.find(rs => (rs.metadata.labels || {})['pod-template-hash'] === hash);
      const key = cluster.keyOf(d);
      let hist = cluster.history.get(key);
      if (!hist) { hist = []; cluster.history.set(key, hist); }
      if (!current && !d.spec.paused) {
        const revision = (hist.length ? Math.max(...hist.map(h => h.revision)) : 0) + 1;
        const rsName = d.metadata.name + '-' + hash;
        current = cluster.create({
          apiVersion: 'apps/v1', kind: 'ReplicaSet',
          metadata: {
            name: rsName, namespace: d.metadata.namespace,
            labels: Object.assign({}, tmpl.metadata.labels, { 'pod-template-hash': hash }),
            annotations: { 'deployment.kubernetes.io/revision': String(revision), 'deployment.kubernetes.io/desired-replicas': String(d.spec.replicas), 'deployment.kubernetes.io/max-replicas': String(d.spec.replicas + 1) },
            ownerReferences: [ownerRef(d, true)],
          },
          spec: {
            replicas: d.spec.replicas,
            selector: { matchLabels: Object.assign({}, (d.spec.selector.matchLabels || {}), { 'pod-template-hash': hash }) },
            template: { metadata: Object.assign({}, tmpl.metadata, { labels: Object.assign({}, tmpl.metadata.labels, { 'pod-template-hash': hash }) }), spec: tmpl.spec },
          },
        });
        hist.push({ revision, template: tmpl, cause: (d.metadata.annotations || {})['kubernetes.io/change-cause'] || '<none>', rsName });
        d.metadata.annotations = d.metadata.annotations || {};
        d.metadata.annotations['deployment.kubernetes.io/revision'] = String(revision);
      }
      if (current) {
        if (current.spec.replicas !== d.spec.replicas) { current.spec.replicas = d.spec.replicas; current.metadata.annotations['deployment.kubernetes.io/desired-replicas'] = String(d.spec.replicas); }
        for (const rs of owned) if (rs !== current && rs.spec.replicas !== 0) rs.spec.replicas = 0;
        // trim history
        const olds = owned.filter(rs => rs !== current).sort((a, b) => parseInt(a.metadata.annotations['deployment.kubernetes.io/revision'], 10) - parseInt(b.metadata.annotations['deployment.kubernetes.io/revision'], 10));
        while (olds.length > (d.spec.revisionHistoryLimit === undefined ? 10 : d.spec.revisionHistoryLimit)) cluster.removeObject(olds.shift(), true);
      }
    }
  },

  reconcileReplicaSets(cluster) {
    const rsEntry = cluster.kinds.resolve('rs');
    const podEntry = cluster.kinds.resolve('pod');
    for (const rs of cluster.list(rsEntry, null)) {
      const pods = cluster.list(podEntry, rs.metadata.namespace).filter(p => ownedBy(p, rs));
      const want = rs.spec.replicas;
      while (pods.length < want) {
        try { pods.push(Sim.podFromTemplate(cluster, rs, rs.spec.template, rs.metadata.name + '-' + randSuffix(5))); }
        catch (e) { if (!(e instanceof ApiError)) throw e; cluster.addEvent(rs, { type: 'Warning', reason: 'FailedCreate', message: 'Error creating: ' + e.message, source: 'replicaset-controller' }); break; }
      }
      pods.sort((a, b) => Date.parse(b.metadata.creationTimestamp) - Date.parse(a.metadata.creationTimestamp));
      while (pods.length > want) cluster.removeObject(pods.shift(), true);
      const ready = pods.filter(p => Sim.isPodReady(cluster, p)).length;
      rs.status = { replicas: pods.length, fullyLabeledReplicas: pods.length, readyReplicas: ready, availableReplicas: ready, observedGeneration: rs.metadata.generation };
    }
  },

  refreshDeploymentStatus(cluster) {
    const entry = cluster.kinds.resolve('deploy');
    const rsEntry = cluster.kinds.resolve('rs');
    for (const d of cluster.list(entry, null)) {
      const owned = cluster.list(rsEntry, d.metadata.namespace).filter(rs => ownedBy(rs, d));
      const hash = shortHash(JSON.stringify(d.spec.template), 9);
      const current = owned.find(rs => (rs.metadata.labels || {})['pod-template-hash'] === hash);
      const total = owned.reduce((n, rs) => n + (rs.status ? rs.status.replicas : 0), 0);
      const ready = owned.reduce((n, rs) => n + (rs.status ? rs.status.readyReplicas : 0), 0);
      const updated = current && current.status ? current.status.replicas : 0;
      const now = new Date().toISOString();
      d.status = {
        observedGeneration: d.metadata.generation, replicas: total, updatedReplicas: updated,
        readyReplicas: ready, availableReplicas: ready,
        conditions: [
          { type: 'Available', status: ready >= Math.ceil(d.spec.replicas * 0.75) && (d.spec.replicas === 0 || ready > 0) ? 'True' : 'False', reason: ready > 0 ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable', message: ready > 0 ? 'Deployment has minimum availability.' : 'Deployment does not have minimum availability.', lastUpdateTime: now, lastTransitionTime: now },
          { type: 'Progressing', status: 'True', reason: ready === d.spec.replicas ? 'NewReplicaSetAvailable' : 'ReplicaSetUpdated', message: 'ReplicaSet "' + (current ? current.metadata.name : '') + '" ' + (ready === d.spec.replicas ? 'has successfully progressed.' : 'is progressing.'), lastUpdateTime: now, lastTransitionTime: now },
        ],
      };
      if (ready < d.spec.replicas) d.status.unavailableReplicas = d.spec.replicas - ready;
    }
  },

  reconcileDaemonSets(cluster) {
    const dsEntry = cluster.kinds.resolve('ds');
    const podEntry = cluster.kinds.resolve('pod');
    for (const ds of cluster.list(dsEntry, null)) {
      const pods = cluster.list(podEntry, ds.metadata.namespace).filter(p => ownedBy(p, ds));
      const wantNodes = cluster.nodes().filter(node => {
        const labels = node.metadata.labels || {};
        const sel = ds.spec.template.spec.nodeSelector || {};
        if (!Object.entries(sel).every(([k, v]) => labels[k] === v)) return false;
        const fake = { spec: Object.assign({}, ds.spec.template.spec, { tolerations: [...(ds.spec.template.spec.tolerations || []), { key: 'node.kubernetes.io/unschedulable', operator: 'Exists' }, { key: 'node.kubernetes.io/unreachable', operator: 'Exists' }, { key: 'node.kubernetes.io/not-ready', operator: 'Exists' }] }) };
        if (!Sim.nodeAffinityOk(fake, node)) return false;
        return !(node.spec.taints || []).some(t => (t.effect === 'NoSchedule' || t.effect === 'NoExecute') && !Sim.tolerates(fake, t));
      });
      for (const node of wantNodes) {
        if (!pods.some(p => p.spec.nodeName === node.metadata.name)) {
          try { pods.push(Sim.podFromTemplate(cluster, ds, ds.spec.template, ds.metadata.name + '-' + randSuffix(5), { nodeName: node.metadata.name, labels: { 'controller-revision-hash': shortHash(JSON.stringify(ds.spec.template), 10), 'pod-template-generation': String(ds.metadata.generation) } })); }
          catch (e) { if (!(e instanceof ApiError)) throw e; cluster.addEvent(ds, { type: 'Warning', reason: 'FailedCreate', message: 'Error creating: ' + e.message, source: 'daemonset-controller' }); break; }
        }
      }
      for (const p of pods) if (!wantNodes.some(n => n.metadata.name === p.spec.nodeName)) cluster.removeObject(p, true);
      const live = cluster.list(podEntry, ds.metadata.namespace).filter(p => ownedBy(p, ds));
      const ready = live.filter(p => Sim.isPodReady(cluster, p)).length;
      ds.status = { currentNumberScheduled: live.length, desiredNumberScheduled: wantNodes.length, numberMisscheduled: 0, numberReady: ready, numberAvailable: ready, updatedNumberScheduled: live.length, observedGeneration: ds.metadata.generation };
      if (ready < wantNodes.length) ds.status.numberUnavailable = wantNodes.length - ready;
    }
  },

  reconcileStatefulSets(cluster) {
    const entry = cluster.kinds.resolve('sts');
    const podEntry = cluster.kinds.resolve('pod');
    for (const sts of cluster.list(entry, null)) {
      const pods = cluster.list(podEntry, sts.metadata.namespace).filter(p => ownedBy(p, sts));
      for (let i = 0; i < sts.spec.replicas; i++) {
        const name = sts.metadata.name + '-' + i;
        if (!pods.some(p => p.metadata.name === name)) {
          if (i > 0 && !Sim.isPodReady(cluster, pods.find(p => p.metadata.name === sts.metadata.name + '-' + (i - 1)) || { metadata: { uid: 'x' } })) break;
          try { pods.push(Sim.podFromTemplate(cluster, sts, sts.spec.template, name, { labels: { 'statefulset.kubernetes.io/pod-name': name, 'controller-revision-hash': sts.metadata.name + '-' + shortHash(JSON.stringify(sts.spec.template), 10) } })); }
          catch (e) { if (!(e instanceof ApiError)) throw e; cluster.addEvent(sts, { type: 'Warning', reason: 'FailedCreate', message: 'create Pod ' + name + ' in StatefulSet ' + sts.metadata.name + ' failed error: ' + e.message, source: 'statefulset-controller' }); break; }
        }
      }
      for (const p of pods) {
        const idx = parseInt(p.metadata.name.slice(sts.metadata.name.length + 1), 10);
        if (idx >= sts.spec.replicas) cluster.removeObject(p, true);
      }
      const live = cluster.list(podEntry, sts.metadata.namespace).filter(p => ownedBy(p, sts));
      const ready = live.filter(p => Sim.isPodReady(cluster, p)).length;
      sts.status = { replicas: live.length, readyReplicas: ready, availableReplicas: ready, currentReplicas: live.length, updatedReplicas: live.length, observedGeneration: sts.metadata.generation, collisionCount: 0 };
    }
  },

  reconcileJobs(cluster) {
    const entry = cluster.kinds.resolve('job');
    const podEntry = cluster.kinds.resolve('pod');
    for (const job of cluster.list(entry, null)) {
      const pods = cluster.list(podEntry, job.metadata.namespace).filter(p => ownedBy(p, job));
      const succeeded = pods.filter(p => cluster.simState(p).info && cluster.simState(p).info.phase === 'Succeeded').length;
      const active = pods.filter(p => !(cluster.simState(p).info && cluster.simState(p).info.phase === 'Succeeded')).length;
      const want = Math.min(job.spec.parallelism, job.spec.completions - succeeded);
      if (!job.spec.suspend) {
        for (let i = active; i < want; i++) {
          try { Sim.podFromTemplate(cluster, job, job.spec.template, job.metadata.name + '-' + randSuffix(5), { sim: { runSeconds: cluster.simState(job).runSeconds !== undefined ? cluster.simState(job).runSeconds : 5 } }); }
          catch (e) { if (!(e instanceof ApiError)) throw e; cluster.addEvent(job, { type: 'Warning', reason: 'FailedCreate', message: 'Error creating: ' + e.message, source: 'job-controller' }); break; }
        }
      }
      const st = cluster.simState(job);
      job.status = job.status || {};
      job.status.startTime = job.status.startTime || new Date(st.createdAt).toISOString();
      if (active) job.status.active = active; else delete job.status.active;
      if (succeeded) job.status.succeeded = succeeded; else delete job.status.succeeded;
      if (succeeded >= job.spec.completions) {
        if (!job.status.completionTime) job.status.completionTime = new Date().toISOString();
        job.status.conditions = [{ type: 'Complete', status: 'True', reason: '', lastProbeTime: job.status.completionTime, lastTransitionTime: job.status.completionTime }];
      }
      job.status.ready = 0;
      job.status.uncountedTerminatedPods = {};
    }
  },

  reconcilePvcs(cluster) {
    const pvcEntry = cluster.kinds.resolve('pvc');
    const pvEntry = cluster.kinds.resolve('pv');
    const podEntry = cluster.kinds.resolve('pod');
    for (const pvc of cluster.list(pvcEntry, null)) {
      if (pvc.status.phase === 'Bound') continue;
      const want = parseQuantity(pvc.spec.resources && pvc.spec.resources.requests && pvc.spec.resources.requests.storage);
      const scName = pvc.spec.storageClassName;
      const pv = cluster.list(pvEntry, null).find(pv =>
        pv.status.phase === 'Available' &&
        (pv.spec.storageClassName || '') === (scName || '') &&
        (!pvc.spec.volumeName || pvc.spec.volumeName === pv.metadata.name) &&
        (pvc.spec.accessModes || []).every(m => (pv.spec.accessModes || []).includes(m)) &&
        parseQuantity(pv.spec.capacity && pv.spec.capacity.storage) >= want);
      if (pv) {
        pv.status.phase = 'Bound';
        pv.spec.claimRef = { kind: 'PersistentVolumeClaim', namespace: pvc.metadata.namespace, name: pvc.metadata.name, uid: pvc.metadata.uid, apiVersion: 'v1' };
        pvc.spec.volumeName = pv.metadata.name;
        pvc.status = { phase: 'Bound', accessModes: pv.spec.accessModes, capacity: pv.spec.capacity };
        pvc.metadata.annotations = Object.assign({}, pvc.metadata.annotations, { 'pv.kubernetes.io/bind-completed': 'yes', 'pv.kubernetes.io/bound-by-controller': 'yes' });
        continue;
      }
      const sc = scName && cluster.getByKindName('StorageClass', null, scName);
      if (sc && sc.provisioner && sc.provisioner !== 'kubernetes.io/no-provisioner') {
        const waitForPod = sc.volumeBindingMode === 'WaitForFirstConsumer';
        const used = cluster.list(podEntry, pvc.metadata.namespace).some(p => (p.spec.volumes || []).some(v => v.persistentVolumeClaim && v.persistentVolumeClaim.claimName === pvc.metadata.name));
        if (!waitForPod || used) {
          const pvName = 'pvc-' + pvc.metadata.uid;
          const created = cluster.create({
            apiVersion: 'v1', kind: 'PersistentVolume',
            metadata: { name: pvName, annotations: { 'pv.kubernetes.io/provisioned-by': sc.provisioner } },
            spec: { capacity: { storage: pvc.spec.resources.requests.storage }, accessModes: pvc.spec.accessModes, persistentVolumeReclaimPolicy: sc.reclaimPolicy || 'Delete', storageClassName: scName, hostPath: { path: '/var/lib/provisioner/' + pvName, type: 'DirectoryOrCreate' }, claimRef: { kind: 'PersistentVolumeClaim', namespace: pvc.metadata.namespace, name: pvc.metadata.name, uid: pvc.metadata.uid, apiVersion: 'v1' } },
          });
          created.status.phase = 'Bound';
          pvc.spec.volumeName = pvName;
          pvc.status = { phase: 'Bound', accessModes: pvc.spec.accessModes, capacity: { storage: pvc.spec.resources.requests.storage } };
        }
      }
    }
  },

  reconcileScheduler(cluster) {
    const podEntry = cluster.kinds.resolve('pod');
    const schedulerOk = cluster.schedulerHealthy();
    for (const pod of cluster.list(podEntry, null)) {
      if (pod.spec.nodeName) continue;
      const st = cluster.simState(pod);
      if (!schedulerOk) { st.scheduleMessage = 'no scheduler is running'; continue; }
      const res = Sim.schedule(cluster, pod);
      if (res.node) {
        pod.spec.nodeName = res.node.metadata.name;
        st.scheduledAt = Date.now();
        delete st.scheduleMessage;
        cluster.addEvent(pod, { reason: 'Scheduled', message: 'Successfully assigned ' + pod.metadata.namespace + '/' + pod.metadata.name + ' to ' + res.node.metadata.name, source: 'default-scheduler' });
      } else {
        st.scheduleMessage = res.message;
        cluster.addEvent(pod, { type: 'Warning', reason: 'FailedScheduling', message: res.message, source: 'default-scheduler' });
      }
    }
  },

  refreshPodEvents(cluster) {
    const podEntry = cluster.kinds.resolve('pod');
    for (const pod of cluster.list(podEntry, null)) {
      const st = cluster.simState(pod);
      if (!st.info || !pod.spec.nodeName) continue;
      for (const cs of st.info.cstates) {
        const w = cs.state && cs.state.waiting;
        if (w && (w.reason === 'ErrImagePull' || w.reason === 'ImagePullBackOff')) {
          cluster.addEvent(pod, { type: 'Warning', reason: 'Failed', message: 'Failed to pull image "' + cs.image + '": rpc error: code = NotFound desc = failed to pull and unpack image "' + cs.image + '": not found' });
          cluster.addEvent(pod, { type: 'Warning', reason: 'Failed', message: 'Error: ' + w.reason });
        } else if (w && w.reason === 'CrashLoopBackOff') {
          cluster.addEvent(pod, { type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container ' + cs.name + ' in pod ' + pod.metadata.name + '_' + pod.metadata.namespace });
        } else if (!st.pulledEventDone && cs.state && (cs.state.running || cs.state.terminated)) {
          cluster.addEvent(pod, { reason: 'Pulled', message: 'Container image "' + cs.image + '" already present on machine' });
          cluster.addEvent(pod, { reason: 'Created', message: 'Created container ' + cs.name });
          cluster.addEvent(pod, { reason: 'Started', message: 'Started container ' + cs.name });
        }
      }
      if (st.info.cstates.every(c => c.state && (c.state.running || c.state.terminated))) st.pulledEventDone = true;
    }
  },

  /* Full pass: controllers then status. Safe to call often. */
  reconcile(cluster) {
    const now = Date.now();
    for (const n of cluster.nodes()) Sim.refreshNode(cluster, n);
    const podEntry = cluster.kinds.resolve('pod');
    for (const p of cluster.list(podEntry, null)) Sim.refreshPod(cluster, p, now);
    if (cluster.controllerManagerHealthy()) {
      Sim.reconcileDeployments(cluster);
      Sim.reconcileReplicaSets(cluster);
      Sim.reconcileDaemonSets(cluster);
      Sim.reconcileStatefulSets(cluster);
      Sim.reconcileJobs(cluster);
      Sim.reconcilePvcs(cluster);
    }
    Sim.reconcileScheduler(cluster);
    for (const p of cluster.list(podEntry, null)) Sim.refreshPod(cluster, p, now);
    Sim.refreshPodEvents(cluster);
    if (cluster.controllerManagerHealthy()) {
      Sim.reconcileReplicaSets(cluster);
      Sim.refreshDeploymentStatus(cluster);
    }
  },
};
