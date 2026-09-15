/* core/vnode.js — filesystem nodes. VFile and VDirectory both carry an
   owner and a Unix-style mode; group semantics are simplified: the check
   uses the owner triad for the owner and the 'other' triad for everyone
   else (admins bypass everything). The group triad is stored and shown
   for realism but not consulted. */

class VNode {
  constructor(owner, mode) {
    this.owner = owner;   // username string
    this.mode = mode;     // number, e.g. 0o644
    this.mtime = Date.now();
  }

  get isDir() { return this instanceof VDirectory; }

  /* perm: 'r' | 'w' | 'x' */
  allows(user, perm) {
    if (!user || user.admin) return true;
    const shift = { r: 2, w: 1, x: 0 }[perm];
    const triad = user.name === this.owner ? (this.mode >> 6) : this.mode;
    return ((triad >> shift) & 1) === 1;
  }

  permString() {
    let s = this.isDir ? 'd' : '-';
    for (let t = 2; t >= 0; t--) {
      const triad = (this.mode >> (t * 3)) & 7;
      s += (triad & 4 ? 'r' : '-') + (triad & 2 ? 'w' : '-') + (triad & 1 ? 'x' : '-');
    }
    return s;
  }

  touch() { this.mtime = Date.now(); }

  mtimeString() {
    const d = new Date(this.mtime);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    return months[d.getMonth()] + ' ' + String(d.getDate()).padStart(2) + ' ' + hh + ':' + mm;
  }
}

class VFile extends VNode {
  constructor(content = '', owner = 'root', mode = 0o644) {
    super(owner, mode);
    this.content = content;
  }
  get size() { return this.content.length; }
  clone(newOwner) { return new VFile(this.content, newOwner || this.owner, this.mode); }
}

class VDirectory extends VNode {
  constructor(owner = 'root', mode = 0o755) {
    super(owner, mode);
    this.children = new Map();
  }
  get size() { return this.children.size; }
  get(name) { return this.children.get(name); }
  set(name, node) { this.children.set(name, node); this.touch(); }
  delete(name) { this.children.delete(name); this.touch(); }
  names() { return [...this.children.keys()].sort(); }
  clone(newOwner) {
    const d = new VDirectory(newOwner || this.owner, this.mode);
    for (const [name, child] of this.children) d.children.set(name, child.clone(newOwner));
    return d;
  }
}
