/* exam/exam.js — the Exam: questions, timer, per-question checking and
   final grading. Exam specs are JSON (see exams/*.json); the exam "type"
   (CKA, CKS...) is just metadata plus which check types the questions use. */

class Exam {
  constructor(spec, world) {
    this.spec = spec;
    this.world = world;
    this.uuid = spec.uuid;
    this.name = spec.name;
    this.type = spec.exam || 'CKA';
    this.durationMs = (spec.durationMinutes || 120) * 60000;
    this.passPercent = spec.passPercent || 66;
    // id, weight and checks are normalized here so an imported spec cannot put
    // arbitrary values into the panel markup.
    this.questions = (spec.questions || []).map((q, i) => {
      const weight = Number(q && q.weight);
      return Object.assign({}, q, { id: i + 1, weight: Number.isFinite(weight) && weight >= 0 ? weight : 4, checks: Array.isArray(q && q.checks) ? q.checks : [] });
    });
    this.startedAt = Date.now();
    this.endedAt = null;
    this.flagged = new Set();
    this.revealed = new Set();     // ids whose solution was shown
    this.results = new Map();      // id -> {pass, failures: [], checkedAt}
    this.current = 1;
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  get totalWeight() { return this.questions.reduce((n, q) => n + q.weight, 0); }
  question(id) { return this.questions.find(q => q.id === Number(id)) || null; }
  timeLeftMs() { return Math.max(0, this.startedAt + this.durationMs - (this.endedAt || Date.now())); }
  get ended() { return this.endedAt !== null; }

  select(id) { if (this.question(id)) { this.current = Number(id); this.emit(); } }
  toggleFlag(id) { if (this.flagged.has(id)) this.flagged.delete(id); else this.flagged.add(id); this.emit(); }
  reveal(id) { if (this.question(id)) { this.revealed.add(Number(id)); this.emit(); } }

  check(id) {
    const q = this.question(id);
    if (!q) return null;
    const failures = [];
    for (const c of q.checks) {
      const r = Checks.run(this.world, c);
      if (!r.pass) failures.push({ hint: c.hint || r.detail || 'check failed', detail: r.detail });
    }
    const result = { pass: !failures.length && q.checks.length > 0, failures, checkedAt: Date.now() };
    this.results.set(q.id, result);
    this.emit();
    return result;
  }

  grade() {
    let earned = 0;
    const rows = [];
    for (const q of this.questions) {
      const r = this.check(q.id);
      if (r.pass) earned += q.weight;
      rows.push({ id: q.id, title: q.title, weight: q.weight, pass: r.pass, failures: r.failures, domain: q.domain, revealed: this.revealed.has(q.id) });
    }
    const percent = this.totalWeight ? Math.round(earned / this.totalWeight * 1000) / 10 : 0;
    return { earned, total: this.totalWeight, percent, pass: percent >= this.passPercent, rows };
  }

  end() {
    if (this.endedAt) return this.lastGrade;
    this.endedAt = Date.now();
    this.lastGrade = this.grade();
    this.emit();
    return this.lastGrade;
  }
}
