/* core/filesystem.js — one FileSystem per Host. All operations take the
   acting User and enforce permissions; pass null as the user for internal
   (system) operations that bypass checks. Errors are FsError with the
   conventional Unix message, prefixed by the caller with the command name. */

class FileSystem {
  constructor() {
    this.root = new VDirectory('root', 0o755);
  }

  /* Walk to parts, checking execute on every directory traversed. */
  traverse(parts, user) {
    let node = this.root;
    for (let i = 0; i < parts.length; i++) {
      if (!node.isDir) throw new FsError(pathString(parts.slice(0, i)) + ': Not a directory');
      if (!node.allows(user, 'x')) throw new FsError((pathString(parts.slice(0, i)) || '/') + ': Permission denied');
      node = node.get(parts[i]);
      if (!node) return null;
    }
    return node;
  }

  node(parts, user) {
    const n = this.traverse(parts, user);
    if (!n) throw new FsError(pathString(parts) + ': No such file or directory');
    return n;
  }

  exists(parts, user) { return !!this.traverse(parts, user); }

  parentDir(parts, user) {
    if (!parts.length) throw new FsError('/: invalid operation on root');
    const p = this.node(parts.slice(0, -1), user);
    if (!p.isDir) throw new FsError(pathString(parts.slice(0, -1)) + ': Not a directory');
    return p;
  }

  list(parts, user) {
    const n = this.node(parts, user);
    if (!n.isDir) return null; // caller decides how to render a file target
    if (!n.allows(user, 'r')) throw new FsError((pathString(parts) || '/') + ': Permission denied');
    return n;
  }

  readFile(parts, user) {
    const n = this.node(parts, user);
    if (n.isDir) throw new FsError(pathString(parts) + ': Is a directory');
    if (!n.allows(user, 'r')) throw new FsError(pathString(parts) + ': Permission denied');
    return n.content;
  }

  writeFile(parts, text, user, { append = false } = {}) {
    const parent = this.parentDir(parts, user);
    const name = parts[parts.length - 1];
    const existing = parent.get(name);
    if (existing) {
      if (existing.isDir) throw new FsError(pathString(parts) + ': Is a directory');
      if (!existing.allows(user, 'w')) throw new FsError(pathString(parts) + ': Permission denied');
      existing.content = append ? existing.content + text : text;
      existing.touch();
      return existing;
    }
    if (!parent.allows(user, 'w')) throw new FsError(pathString(parts.slice(0, -1)) + ': Permission denied');
    const f = new VFile(text, user ? user.name : 'root');
    parent.set(name, f);
    return f;
  }

  touchFile(parts, user) {
    const parent = this.parentDir(parts, user);
    const name = parts[parts.length - 1];
    const existing = parent.get(name);
    if (existing) { existing.touch(); return existing; }
    if (!parent.allows(user, 'w')) throw new FsError(pathString(parts.slice(0, -1)) + ': Permission denied');
    const f = new VFile('', user ? user.name : 'root');
    parent.set(name, f);
    return f;
  }

  mkdir(parts, user, { parents = false, mode = 0o755 } = {}) {
    if (!parts.length) throw new FsError('/: File exists');
    if (parents) {
      let node = this.root;
      for (let i = 0; i < parts.length; i++) {
        if (!node.allows(user, 'x')) throw new FsError((pathString(parts.slice(0, i)) || '/') + ': Permission denied');
        let child = node.get(parts[i]);
        if (!child) {
          if (!node.allows(user, 'w')) throw new FsError((pathString(parts.slice(0, i)) || '/') + ': Permission denied');
          child = new VDirectory(user ? user.name : 'root', mode);
          node.set(parts[i], child);
        }
        if (!child.isDir) throw new FsError(pathString(parts.slice(0, i + 1)) + ': Not a directory');
        node = child;
      }
      return node;
    }
    const parent = this.parentDir(parts, user);
    const name = parts[parts.length - 1];
    if (parent.get(name)) throw new FsError(pathString(parts) + ': File exists');
    if (!parent.allows(user, 'w')) throw new FsError(pathString(parts.slice(0, -1)) + ': Permission denied');
    const d = new VDirectory(user ? user.name : 'root', mode);
    parent.set(name, d);
    return d;
  }

  remove(parts, user, { recursive = false } = {}) {
    const parent = this.parentDir(parts, user);
    const name = parts[parts.length - 1];
    const node = parent.get(name);
    if (!node) throw new FsError(pathString(parts) + ': No such file or directory');
    if (node.isDir && !recursive) throw new FsError(pathString(parts) + ': Is a directory');
    if (!parent.allows(user, 'w')) throw new FsError(pathString(parts) + ': Permission denied');
    parent.delete(name);
    return node;
  }

  copy(srcParts, destParts, user, { recursive = false } = {}) {
    const src = this.node(srcParts, user);
    if (src.isDir && !recursive) throw new FsError(pathString(srcParts) + ': Is a directory (use -r)');
    if (!src.allows(user, 'r')) throw new FsError(pathString(srcParts) + ': Permission denied');
    const destNode = this.traverse(destParts, user);
    const finalParts = destNode && destNode.isDir
      ? destParts.concat([srcParts[srcParts.length - 1]])
      : destParts;
    const parent = this.parentDir(finalParts, user);
    const name = finalParts[finalParts.length - 1];
    const existing = parent.get(name);
    if (existing && existing.isDir) throw new FsError(pathString(finalParts) + ': Is a directory');
    if (existing ? !existing.allows(user, 'w') : !parent.allows(user, 'w')) {
      throw new FsError(pathString(finalParts) + ': Permission denied');
    }
    parent.set(name, src.clone(user ? user.name : undefined));
  }

  move(srcParts, destParts, user) {
    const srcStr = pathString(srcParts);
    const src = this.node(srcParts, user);
    const destNode = this.traverse(destParts, user);
    const finalParts = destNode && destNode.isDir
      ? destParts.concat([srcParts[srcParts.length - 1]])
      : destParts;
    const destStr = pathString(finalParts);
    if (destStr === srcStr || destStr.startsWith(srcStr + '/')) {
      throw new FsError('cannot move ' + srcStr + ' into itself');
    }
    const srcParent = this.parentDir(srcParts, user);
    if (!srcParent.allows(user, 'w')) throw new FsError(srcStr + ': Permission denied');
    const destParent = this.parentDir(finalParts, user);
    if (!destParent.allows(user, 'w')) throw new FsError(pathString(finalParts.slice(0, -1)) + ': Permission denied');
    srcParent.delete(srcParts[srcParts.length - 1]);
    destParent.set(finalParts[finalParts.length - 1], src);
    return finalParts;
  }

  chmod(parts, mode, user) {
    const n = this.node(parts, user);
    if (user && !user.admin && user.name !== n.owner) {
      throw new FsError(pathString(parts) + ': Operation not permitted');
    }
    n.mode = mode;
    n.touch();
  }

  chown(parts, newOwner, user) {
    if (user && !user.admin) throw new FsError(pathString(parts) + ': Operation not permitted');
    const n = this.node(parts, user);
    n.owner = newOwner;
    n.touch();
  }
}
