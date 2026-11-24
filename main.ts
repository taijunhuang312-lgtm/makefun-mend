// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON tool calls), finds the lines it names even when the
// whitespace has drifted, and changes every file or none. See SPEC.md.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// When MAKEFUN_ENV_URL is set, the entry hands the trial over to runner.ts.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { runTrial } from './runner.ts';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

// A parse fault carries the 1-based patch line the format's section names.
class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

// A patch's lines: split at '\n', one trailing '\r' removed from each, and
// without the empty piece after a final '\n'.
function splitPatch(text: string): string[] {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// A file's lines, its line break, and whether it ends with one. The break is
// CRLF when the first line feed follows a carriage return, LF otherwise.
interface FileLines {
  lines: string[];
  eol: '\r\n' | '\n';
  endsWithBreak: boolean;
}

function splitLines(text: string): FileLines {
  if (text === '') return { lines: [], eol: '\n', endsWithBreak: false };
  const firstLF = text.indexOf('\n');
  const eol: '\r\n' | '\n' =
    firstLF > 0 && text[firstLF - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(eol);
  const endsWithBreak = text.endsWith(eol);
  if (endsWithBreak) parts.pop();
  return { lines: parts, eol, endsWithBreak };
}

function joinLines(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.eol) + (f.endsWithBreak ? f.eol : '');
}

// A path is safe when it is not empty, does not start with '/', holds no '\',
// and none of its '/'-separated segments is empty, '.' or '..'.
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// The leading spaces and tabs of a line.
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC section 5)
// ---------------------------------------------------------------------------

// One line of a hunk or chunk body: a context line (in both O and N), a '-'
// line (in O only) or a '+' line (in N only). noNL is set when a '\' line
// follows it (it marks the file's last line as having no final break).
interface BodyLine {
  type: 'ctx' | 'del' | 'add';
  text: string;
  noNL: boolean;
}

// The old lines of a body, in body order: its context and '-' lines.
function bodyOld(body: BodyLine[]): string[] {
  const o: string[] = [];
  for (const b of body) {
    if (b.type === 'ctx' || b.type === 'del') o.push(b.text);
  }
  return o;
}

// The new lines of a body after the match at pos: context lines are written
// as the file's own matched lines; at tier 2 every other line is re-indented
// (its leading P replaced by F when it starts with P and is not blank).
function bodyNew(
  body: BodyLine[],
  fileLines: string[],
  pos: number,
  tier: number,
): string[] {
  const O = bodyOld(body);
  const F = leadingWs(fileLines[pos] ?? '');
  const P = O.length > 0 ? leadingWs(O[0]) : '';
  const out: string[] = [];
  let oIdx = 0;
  for (const b of body) {
    if (b.type === 'ctx') {
      out.push(fileLines[pos + oIdx]);
      oIdx++;
    } else if (b.type === 'del') {
      oIdx++;
    } else {
      let t = b.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(P)) {
        t = F + t.slice(P.length);
      }
      out.push(t);
    }
  }
  return out;
}

// Whether a '\' line follows the body's last context or '+' line.
function lastCtxOrAddNoNL(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i].type === 'ctx' || body[i].type === 'add') return body[i].noNL;
  }
  return false;
}

// Positions where O occurs in lines at or after `from`, at one tier.
function occurrencesAt(O: string[], lines: string[], tier: number, from: number): number[] {
  const t = tier === 0 ? (s: string) => s : tier === 1 ? stripTrailing : stripBoth;
  const o = O.map(t);
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (t(lines[i + j]) !== o[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// The first tier at which O occurs at or after `from`, with its occurrences.
function findTier(
  O: string[],
  lines: string[],
  from: number,
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(O, lines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// Re-indent N lines against O's first line and the file's matched line, at
// tier 2 (used where N has no context lines, as in SEARCH/REPLACE).
function reindentLines(
  N: string[],
  O: string[],
  fileLines: string[],
  pos: number,
  tier: number,
): string[] {
  if (tier !== 2) return [...N];
  const F = leadingWs(fileLines[pos] ?? '');
  const P = O.length > 0 ? leadingWs(O[0]) : '';
  return N.map((t) =>
    t.trim() !== '' && t.startsWith(P) ? F + t.slice(P.length) : t,
  );
}

// ---------------------------------------------------------------------------
// The tree: files as read, changed only in memory until the end
// ---------------------------------------------------------------------------

interface EditFailure {
  code: string;
  path: string;
}

class Tree {
  cwd = process.cwd();
  files = new Map<string, { before: string | null; after: string | null }>();
  moves: { old: string; nw: string }[] = [];

  fsPath(p: string): string {
    return join(this.cwd, ...p.split('/'));
  }

  read(p: string): string | null {
    let r = this.files.get(p);
    if (r === undefined) {
      let text: string | null = null;
      try {
        text = readFileSync(this.fsPath(p), 'utf8');
      } catch {
        text = null;
      }
      r = { before: text, after: text };
      this.files.set(p, r);
    }
    return r.after;
  }

  exists(p: string): boolean {
    return this.read(p) !== null;
  }

  set(p: string, text: string): void {
    let r = this.files.get(p);
    if (r === undefined) {
      this.read(p);
      r = this.files.get(p)!;
    }
    r.after = text;
  }

  remove(p: string): void {
    let r = this.files.get(p);
    if (r === undefined) {
      this.read(p);
      r = this.files.get(p)!;
    }
    r.after = null;
  }

  recordMove(oldP: string, newP: string): void {
    this.moves.push({ old: oldP, nw: newP });
  }

  // The report lines for every path whose state changed, in byte order of
  // the paths (UTF-8). A successful move is one 'R old -> new' line, sorting
  // by the new path, in place of the pair's 'D' and 'A' lines.
  changes(): { sortKey: string; line: string }[] {
    const out: { sortKey: string; line: string }[] = [];
    const rOld = new Set<string>();
    const rNew = new Set<string>();
    for (const m of this.moves) {
      const o = this.files.get(m.old);
      const n = this.files.get(m.nw);
      if (
        o && n &&
        o.before !== null && o.after === null &&
        n.before === null && n.after !== null &&
        !rOld.has(m.old) && !rNew.has(m.nw)
      ) {
        rOld.add(m.old);
        rNew.add(m.nw);
        out.push({ sortKey: m.nw, line: `R ${m.old} -> ${m.nw}` });
      }
    }
    for (const [p, r] of this.files) {
      if (rOld.has(p) || rNew.has(p)) continue;
      if (r.before === r.after) continue;
      if (r.before === null) out.push({ sortKey: p, line: `A ${p}` });
      else if (r.after === null) out.push({ sortKey: p, line: `D ${p}` });
      else out.push({ sortKey: p, line: `M ${p}` });
    }
    out.sort((a, b) =>
      Buffer.compare(Buffer.from(a.sortKey, 'utf8'), Buffer.from(b.sortKey, 'utf8')),
    );
    return out;
  }

  // Write every change to disk, creating directories as files need them.
  writeAll(): void {
    for (const [p, r] of this.files) {
      if (r.before === r.after) continue;
      const fsPath = this.fsPath(p);
      if (r.after === null) {
        rmSync(fsPath, { force: true });
      } else {
        mkdirSync(dirname(fsPath), { recursive: true });
        writeFileSync(fsPath, r.after, 'utf8');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Arguments (SPEC section 1)
// ---------------------------------------------------------------------------

const FORMAT_NAMES = ['unified', 'search-replace', 'v4a', 'json', 'auto'] as const;
type FormatName = (typeof FORMAT_NAMES)[number];

interface CliOptions {
  format: FormatName;
  check: boolean;
  strict: boolean;
  patch: string | null; // null means read from standard input
}

// Returns the options, or null on a usage error.
function parseArgs(args: string[]): CliOptions | null {
  let format: FormatName = 'auto';
  let check = false;
  let strict = false;
  let patch: string | null = null;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let noMoreOptions = false;
  for (const a of args) {
    if (!noMoreOptions && a === '--') {
      noMoreOptions = true;
      continue;
    }
    if (!noMoreOptions && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (seenFormat) return null;
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (!(FORMAT_NAMES as readonly string[]).includes(v)) return null;
        format = v as FormatName;
      } else if (a === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else {
        return null;
      }
    } else {
      if (patch !== null) return null; // more than one positional argument
      patch = a;
    }
  }
  return { format, check, strict, patch };
}

// ---------------------------------------------------------------------------
// Detecting the format (SPEC section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): FormatName | null {
  let firstNonBlank: string | null = null;
  for (const l of lines) {
    if (l.trim() !== '') {
      firstNonBlank = l;
      break;
    }
  }
  if (firstNonBlank !== null && firstNonBlank.trim() === '*** Begin Patch') {
    return 'v4a';
  }
  if (firstNonBlank !== null) {
    const c = firstNonBlank.trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  for (const l of lines) {
    if (l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (
      lines[i].startsWith('--- ') &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith('+++ ')
    ) {
      return 'unified';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Edits: one per section, block or object, applied in the patch's order
// ---------------------------------------------------------------------------

interface UnifiedHunk {
  A: number;
  body: BodyLine[];
}

interface UnifiedSection {
  oldPath: string | null; // null: /dev/null, or nothing named one
  newPath: string | null;
  isCreate: boolean; // 'new file mode'
  isDelete: boolean; // 'deleted file mode'
  hunks: UnifiedHunk[];
}

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

interface V4AChunk {
  anchor: string | null;
  endOfFile: boolean;
  body: BodyLine[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null; // update only
  lines: string[]; // add only: the file's lines
  chunks: V4AChunk[]; // update only
}

type JSONEdit =
  | { command: 'create'; path: string; file_text: string }
  | { command: 'str_replace'; path: string; old_str: string; new_str: string }
  | { command: 'insert'; path: string; insert_line: number; new_str: string };

type EditDesc =
  | { kind: 'unified'; section: UnifiedSection }
  | { kind: 'sr'; block: SRBlock }
  | { kind: 'v4a'; section: V4ASection }
  | { kind: 'json'; edit: JSONEdit };

// The paths an edit names, in the order they are named, for the safety check.
function editPaths(e: EditDesc): string[] {
  if (e.kind === 'unified') {
    const out: string[] = [];
    if (e.section.oldPath !== null) out.push(e.section.oldPath);
    if (e.section.newPath !== null) out.push(e.section.newPath);
    return out;
  }
  if (e.kind === 'sr') return [e.block.path];
  if (e.kind === 'v4a') {
    const out = [e.section.path];
    if (e.section.moveTo !== null) out.push(e.section.moveTo);
    return out;
  }
  return [e.edit.path];
}

function fail(code: string, path: string): EditFailure {
  return { code, path };
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

// The path after '--- ' or '+++ ': the text after the four characters, up to
// the first tab, with surrounding spaces removed; a leading 'a/' or 'b/'
// removed. '/dev/null' is returned as-is and means no file.
function parseDiffPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab !== -1) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function toPathOrNull(p: string | undefined): string | null {
  if (p === undefined || p === '/dev/null') return null;
  return p;
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let cur: {
    gitOld: string | undefined;
    gitNew: string | undefined;
    pairOld: string | undefined;
    pairNew: string | undefined;
    renameFrom: string | undefined;
    renameTo: string | undefined;
    isCreate: boolean;
    isDelete: boolean;
    hunks: UnifiedHunk[];
  } | null = null;
  let curHunk: UnifiedHunk | null = null;
  let sawHunk = false; // the current section has seen a hunk (header is over)

  const pushHunk = () => {
    if (curHunk && cur) {
      // Empty lines at the end of a body are not part of it, except one a
      // '\' line follows (it marks the file's last line as having no break).
      const b = curHunk.body;
      while (
        b.length > 0 &&
        b[b.length - 1].type === 'ctx' &&
        b[b.length - 1].text === '' &&
        !b[b.length - 1].noNL
      ) {
        b.pop();
      }
      cur.hunks.push(curHunk);
      curHunk = null;
    }
  };

  const pushSection = () => {
    pushHunk();
    if (cur) {
      const oldPath = toPathOrNull(
        cur.pairOld !== undefined
          ? cur.pairOld
          : cur.renameFrom !== undefined
            ? cur.renameFrom
            : cur.gitOld,
      );
      const newPath = toPathOrNull(
        cur.pairNew !== undefined
          ? cur.pairNew
          : cur.renameTo !== undefined
            ? cur.renameTo
            : cur.gitNew,
      );
      sections.push({
        oldPath,
        newPath,
        isCreate: cur.isCreate,
        isDelete: cur.isDelete,
        hunks: cur.hunks,
      });
      cur = null;
      sawHunk = false;
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const ln = i + 1;
    const next = i + 1 < lines.length ? lines[i + 1] : null;

    if (curHunk !== null) {
      // Inside a hunk body.
      if (line.startsWith('diff --git ')) {
        pushSection();
        continue;
      }
      if (line.startsWith('--- ') && next !== null && next.startsWith('+++ ')) {
        pushSection();
        continue;
      }
      if (
        line.startsWith(' ') ||
        line.startsWith('-') ||
        line.startsWith('+') ||
        line.startsWith('\\') ||
        line === ''
      ) {
        if (line.startsWith('\\')) {
          // A '\' line refers to the body line before it.
          const b = curHunk.body;
          if (b.length > 0) b[b.length - 1].noNL = true;
        } else if (line === '') {
          curHunk.body.push({ type: 'ctx', text: '', noNL: false });
        } else if (line.startsWith(' ')) {
          curHunk.body.push({ type: 'ctx', text: line.slice(1), noNL: false });
        } else if (line.startsWith('-')) {
          curHunk.body.push({ type: 'del', text: line.slice(1), noNL: false });
        } else {
          curHunk.body.push({ type: 'add', text: line.slice(1), noNL: false });
        }
        i++;
        continue;
      }
      // Any other line ends the body; reprocess it outside the body.
      pushHunk();
      continue;
    }

    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (!m) throw new ParseError(ln);
      if (!cur) throw new ParseError(ln); // a hunk before any section
      curHunk = { A: parseInt(m[1], 10), body: [] };
      sawHunk = true;
      i++;
      continue;
    }

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (!m) throw new ParseError(ln);
      pushSection();
      cur = {
        gitOld: m[1],
        gitNew: m[2],
        pairOld: undefined,
        pairNew: undefined,
        renameFrom: undefined,
        renameTo: undefined,
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      sawHunk = false;
      i++;
      continue;
    }

    if (cur !== null && !sawHunk) {
      // Inside a section's header, before its first hunk.
      if (line.startsWith('--- ')) {
        if (next === null || !next.startsWith('+++ ')) throw new ParseError(ln + 1);
        cur.pairOld = parseDiffPath(line);
        cur.pairNew = parseDiffPath(next);
        i += 2;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length);
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length);
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      // index, old mode, new mode, similarity, dissimilarity, Index: and
      // any other line are ignored.
      i++;
      continue;
    }

    if (line.startsWith('--- ') && next !== null && next.startsWith('+++ ')) {
      pushSection();
      cur = {
        gitOld: undefined,
        gitNew: undefined,
        pairOld: parseDiffPath(line),
        pairNew: parseDiffPath(next),
        renameFrom: undefined,
        renameTo: undefined,
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      sawHunk = false;
      i += 2;
      continue;
    }

    // Outside bodies, lines that are not part of a section header are
    // ignored (prose, code fences).
    i++;
  }
  pushSection();
  return sections;
}

// Apply one section's hunks to a file's lines, in order, each to the result
// of the ones before it. Returns the new lines and final-break flag, or a
// failure code ('no-match' when a hunk's O is not in the file).
function applyHunks(
  lines: string[],
  endsWithBreak: boolean,
  hunks: UnifiedHunk[],
  strict: boolean,
): { lines: string[]; endsWithBreak: boolean } | { fail: string } {
  let cur = [...lines];
  let curEnds = endsWithBreak;
  let d = 0;
  for (const h of hunks) {
    const O = bodyOld(h.body);
    if (O.length === 0) {
      // A pure insertion: N is inserted after the first A + d lines.
      const oldLen = cur.length;
      const idx = Math.min(h.A + d, oldLen);
      const N = bodyNew(h.body, cur, idx, 0);
      cur = [...cur.slice(0, idx), ...N, ...cur.slice(idx)];
      if (idx === oldLen) curEnds = !lastCtxOrAddNoNL(h.body);
      d += N.length;
      continue;
    }
    const found = findTier(O, cur, 0, strict);
    if (!found) return { fail: 'no-match' };
    const target = h.A - 1 + d;
    let pos = found.occ[0];
    let best = Math.abs(pos - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    const N = bodyNew(h.body, cur, pos, found.tier);
    const runsToEnd = pos + O.length === cur.length;
    cur = [...cur.slice(0, pos), ...N, ...cur.slice(pos + O.length)];
    if (runsToEnd) curEnds = !lastCtxOrAddNoNL(h.body);
    d += N.length - O.length;
  }
  return { lines: cur, endsWithBreak: curEnds };
}

function applyUnified(
  tree: Tree,
  section: UnifiedSection,
  strict: boolean,
): EditFailure | null {
  const isCreate = section.isCreate || section.oldPath === null;
  const isDelete = !isCreate && (section.isDelete || section.newPath === null);
  if (isCreate) {
    const target = section.newPath;
    if (target === null) return fail('unsafe', '');
    if (tree.exists(target)) return fail('exists', target);
    const plusLines: string[] = [];
    let lastPlusNoNL = false;
    for (const h of section.hunks) {
      for (const b of h.body) {
        if (b.type === 'add') {
          plusLines.push(b.text);
          lastPlusNoNL = b.noNL;
        }
      }
    }
    const ends = plusLines.length === 0 ? false : !lastPlusNoNL;
    tree.set(target, joinLines({ lines: plusLines, eol: '\n', endsWithBreak: ends }));
    return null;
  }
  if (isDelete) {
    const target = section.oldPath;
    if (target === null) return fail('unsafe', '');
    if (!tree.exists(target)) return fail('missing', target);
    tree.remove(target);
    return null;
  }
  const from = section.oldPath;
  const to = section.newPath;
  if (from === null || to === null) return fail('unsafe', '');
  if (!tree.exists(from)) return fail('missing', from);
  if (from !== to && tree.exists(to)) return fail('exists', to);
  const text = tree.read(from)!;
  const fl = splitLines(text);
  const res = applyHunks(fl.lines, fl.endsWithBreak, section.hunks, strict);
  if ('fail' in res) return fail(res.fail, from);
  const newText = joinLines({ lines: res.lines, eol: fl.eol, endsWithBreak: res.endsWithBreak });
  if (from !== to) {
    tree.remove(from);
    tree.set(to, newText);
    tree.recordMove(from, to);
  } else {
    tree.set(from, newText);
  }
  return null;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

// A marker line, matched with its trailing whitespace removed.
function isMarker(line: string, marker: string): boolean {
  return line.replace(/[ \t]+$/, '') === marker;
}

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1; // index of the previous block's '>>>>>>> REPLACE' line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (isMarker(lines[i], '<<<<<<< SEARCH')) {
      const searchLine = i + 1;
      // The path is the nearest line before the SEARCH line, and after the
      // previous block's REPLACE line, that is not blank and does not start
      // with three backticks; the path is that line trimmed.
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const t = lines[j].trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new ParseError(searchLine);
        path = prevPath;
      }
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (isMarker(lines[j], '=======')) {
          eq = j;
          break;
        }
      }
      if (eq === -1) throw new ParseError(searchLine);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (isMarker(lines[j], '>>>>>>> REPLACE')) {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new ParseError(searchLine);
      blocks.push({
        path,
        oldLines: lines.slice(i + 1, eq),
        newLines: lines.slice(eq + 1, rep),
      });
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
      continue;
    }
    i++;
  }
  return blocks;
}

function applySR(tree: Tree, block: SRBlock, strict: boolean): EditFailure | null {
  const path = block.path;
  const O = block.oldLines;
  if (O.length === 0) {
    if (tree.exists(path)) return fail('exists', path);
    tree.set(path, joinLines({ lines: block.newLines, eol: '\n', endsWithBreak: true }));
    return null;
  }
  if (!tree.exists(path)) return fail('missing', path);
  const text = tree.read(path)!;
  const fl = splitLines(text);
  const found = findTier(O, fl.lines, 0, strict);
  if (!found) return fail('no-match', path);
  if (found.occ.length > 1) return fail('ambiguous', path);
  const pos = found.occ[0];
  const N = reindentLines(block.newLines, O, fl.lines, pos, found.tier);
  const out = [...fl.lines.slice(0, pos), ...N, ...fl.lines.slice(pos + O.length)];
  tree.set(path, joinLines({ lines: out, eol: fl.eol, endsWithBreak: fl.endsWithBreak }));
  return null;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

function parseV4A(lines: string[]): V4ASection[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);

  // Collect the raw sections between Begin and End Patch.
  interface RawSection {
    kind: 'add' | 'delete' | 'update';
    path: string;
    lineNo: number;
    lines: { text: string; no: number }[];
  }
  const raw: RawSection[] = [];
  let cur: RawSection | null = null;
  const sectionStart = (
    line: string,
  ): { kind: 'add' | 'delete' | 'update'; path: string } | null => {
    if (line.startsWith('*** Add File: ')) {
      return { kind: 'add', path: line.slice('*** Add File: '.length).trim() };
    }
    if (line.startsWith('*** Delete File: ')) {
      return { kind: 'delete', path: line.slice('*** Delete File: '.length).trim() };
    }
    if (line.startsWith('*** Update File: ')) {
      return { kind: 'update', path: line.slice('*** Update File: '.length).trim() };
    }
    return null;
  };
  for (let i = first + 1; i < last; i++) {
    const line = lines[i];
    const start = sectionStart(line);
    if (start) {
      if (cur) raw.push(cur);
      cur = { kind: start.kind, path: start.path, lineNo: i + 1, lines: [] };
      continue;
    }
    if (cur === null) {
      if (line.trim() === '') continue; // blank lines between sections
      throw new ParseError(i + 1);
    }
    cur.lines.push({ text: line, no: i + 1 });
  }
  if (cur) raw.push(cur);

  const sections: V4ASection[] = [];
  for (const r of raw) {
    // Blank lines at the end of a section are not part of it.
    const body = [...r.lines];
    while (body.length > 0 && body[body.length - 1].text.trim() === '') body.pop();
    if (r.kind === 'add') {
      const fileLines: string[] = [];
      for (const l of body) {
        if (l.text.startsWith('+')) fileLines.push(l.text.slice(1));
        else if (l.text === '') fileLines.push('');
        else throw new ParseError(l.no);
      }
      sections.push({ kind: 'add', path: r.path, moveTo: null, lines: fileLines, chunks: [] });
      continue;
    }
    if (r.kind === 'delete') {
      if (body.length > 0) throw new ParseError(body[0].no);
      sections.push({ kind: 'delete', path: r.path, moveTo: null, lines: [], chunks: [] });
      continue;
    }
    // Update: an optional '*** Move to: <path>' first line, then chunks.
    let moveTo: string | null = null;
    let idx = 0;
    if (idx < body.length && body[idx].text.startsWith('*** Move to: ')) {
      moveTo = body[idx].text.slice('*** Move to: '.length).trim();
      idx++;
    }
    const chunks: V4AChunk[] = [];
    let curChunk: V4AChunk | null = null;
    const pushChunk = () => {
      if (curChunk) {
        chunks.push(curChunk);
        curChunk = null;
      }
    };
    for (; idx < body.length; idx++) {
      const { text, no } = body[idx];
      if (text.startsWith('@@')) {
        pushChunk();
        const anchor = text.slice(2).trim();
        curChunk = { anchor: anchor === '' ? null : anchor, endOfFile: false, body: [] };
        continue;
      }
      if (text.trim() === '*** End of File') {
        if (!curChunk) throw new ParseError(no);
        curChunk.endOfFile = true;
        pushChunk();
        continue;
      }
      if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+') || text === '') {
        if (!curChunk) curChunk = { anchor: null, endOfFile: false, body: [] };
        if (text === '') curChunk.body.push({ type: 'ctx', text: '', noNL: false });
        else if (text.startsWith(' ')) {
          curChunk.body.push({ type: 'ctx', text: text.slice(1), noNL: false });
        } else if (text.startsWith('-')) {
          curChunk.body.push({ type: 'del', text: text.slice(1), noNL: false });
        } else {
          curChunk.body.push({ type: 'add', text: text.slice(1), noNL: false });
        }
        continue;
      }
      throw new ParseError(no);
    }
    pushChunk();
    if (chunks.length === 0 && moveTo === null) throw new ParseError(r.lineNo);
    sections.push({ kind: 'update', path: r.path, moveTo, lines: [], chunks });
  }
  return sections;
}

function applyV4A(tree: Tree, section: V4ASection, strict: boolean): EditFailure | null {
  const path = section.path;
  if (section.kind === 'add') {
    if (tree.exists(path)) return fail('exists', path);
    const ends = section.lines.length > 0;
    tree.set(path, joinLines({ lines: section.lines, eol: '\n', endsWithBreak: ends }));
    return null;
  }
  if (section.kind === 'delete') {
    if (!tree.exists(path)) return fail('missing', path);
    tree.remove(path);
    return null;
  }
  if (!tree.exists(path)) return fail('missing', path);
  const newPath = section.moveTo;
  if (newPath !== null && tree.exists(newPath)) return fail('exists', newPath);
  const text = tree.read(path)!;
  const fl = splitLines(text);
  let cur = [...fl.lines];
  let cursor = 0;
  for (const chunk of section.chunks) {
    if (chunk.anchor !== null) {
      const a = findTier([chunk.anchor], cur, cursor, strict);
      if (!a) return fail('no-match', path);
      cursor = a.occ[0] + 1;
    }
    const O = bodyOld(chunk.body);
    if (O.length === 0) {
      const idx = chunk.endOfFile ? cur.length : cursor;
      const N = bodyNew(chunk.body, cur, idx, 0);
      cur = [...cur.slice(0, idx), ...N, ...cur.slice(idx)];
      cursor = idx + N.length;
    } else {
      const found = findTier(O, cur, cursor, strict);
      if (!found) return fail('no-match', path);
      let pos: number | null = null;
      for (const p of found.occ) {
        if (chunk.endOfFile) {
          if (p + O.length === cur.length) {
            pos = p;
            break;
          }
        } else {
          pos = p;
          break;
        }
      }
      if (pos === null) return fail('no-match', path);
      const N = bodyNew(chunk.body, cur, pos, found.tier);
      cur = [...cur.slice(0, pos), ...N, ...cur.slice(pos + O.length)];
      cursor = pos + N.length;
    }
  }
  const newText = joinLines({ lines: cur, eol: fl.eol, endsWithBreak: fl.endsWithBreak });
  if (newPath !== null) {
    tree.remove(path);
    tree.set(newPath, newText);
    tree.recordMove(path, newPath);
  } else {
    tree.set(path, newText);
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

// One edit object, or null when it is a parse fault (a wrong command, or a
// missing or mistyped key).
function validateJSONEdit(obj: unknown): JSONEdit | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  const path = o.path as string;
  const command = o.command as string;
  if (command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { command: 'create', path, file_text: o.file_text as string };
  }
  if (command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str === undefined) {
      return { command: 'str_replace', path, old_str: o.old_str as string, new_str: '' };
    }
    if (typeof o.new_str !== 'string') return null;
    return {
      command: 'str_replace',
      path,
      old_str: o.old_str as string,
      new_str: o.new_str as string,
    };
  }
  if (command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return {
      command: 'insert',
      path,
      insert_line: o.insert_line as number,
      new_str: o.new_str as string,
    };
  }
  return null;
}

function parseJSON(patchText: string, lines: string[]): JSONEdit[] {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return [];
  const firstChar = lines[firstIdx].trimStart()[0];
  if (firstChar === '[') {
    // One JSON array of edit objects; any fault is the array's line.
    const arrayStartLine = firstIdx + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(patchText);
    } catch {
      throw new ParseError(arrayStartLine);
    }
    if (!Array.isArray(parsed)) throw new ParseError(arrayStartLine);
    const edits: JSONEdit[] = [];
    for (const el of parsed) {
      const e = validateJSONEdit(el);
      if (!e) throw new ParseError(arrayStartLine);
      edits.push(e);
    }
    return edits;
  }
  // JSON Lines: one edit object a line, blank lines ignored.
  const edits: JSONEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new ParseError(i + 1);
    }
    const e = validateJSONEdit(obj);
    if (!e) throw new ParseError(i + 1);
    edits.push(e);
  }
  return edits;
}

// Count overlapping occurrences of needle in hay, and the first index.
function countOccurrences(hay: string, needle: string): { count: number; first: number } {
  let count = 0;
  let first = -1;
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    count++;
    if (first === -1) first = idx;
    idx = hay.indexOf(needle, idx + 1);
  }
  return { count, first };
}

function applyJSON(tree: Tree, edit: JSONEdit): EditFailure | null {
  const path = edit.path;
  if (edit.command === 'create') {
    if (tree.exists(path)) return fail('exists', path);
    tree.set(path, edit.file_text);
    return null;
  }
  if (edit.command === 'str_replace') {
    if (!tree.exists(path)) return fail('missing', path);
    const text = tree.read(path)!;
    const fl = splitLines(text);
    const isCRLF = fl.eol === '\r\n';
    // In a CRLF file the text and both strings are read with every '\r\n'
    // as '\n', and the result is written back with '\r\n'.
    let hay = text;
    let oldS = edit.old_str;
    let newS = edit.new_str;
    if (isCRLF) {
      hay = text.replace(/\r\n/g, '\n');
      oldS = edit.old_str.replace(/\r\n/g, '\n');
      newS = edit.new_str.replace(/\r\n/g, '\n');
    }
    const { count, first } = countOccurrences(hay, oldS);
    if (count === 0) return fail('no-match', path);
    if (count > 1) return fail('ambiguous', path);
    let result = hay.slice(0, first) + newS + hay.slice(first + oldS.length);
    if (isCRLF) result = result.replace(/\n/g, '\r\n');
    tree.set(path, result);
    return null;
  }
  // insert
  if (!tree.exists(path)) return fail('missing', path);
  const text = tree.read(path)!;
  const fl = splitLines(text);
  const k = edit.insert_line;
  if (k < 0 || k > fl.lines.length) return fail('no-match', path);
  const insLines = edit.new_str === '' ? [] : splitPatch(edit.new_str);
  const out = [...fl.lines.slice(0, k), ...insLines, ...fl.lines.slice(k)];
  tree.set(path, joinLines({ lines: out, eol: fl.eol, endsWithBreak: fl.endsWithBreak }));
  return null;
}

// ---------------------------------------------------------------------------
// Main flow (SPEC sections 2 and 10)
// ---------------------------------------------------------------------------

function applyEdit(tree: Tree, e: EditDesc, strict: boolean): EditFailure | null {
  if (e.kind === 'unified') return applyUnified(tree, e.section, strict);
  if (e.kind === 'sr') return applySR(tree, e.block, strict);
  if (e.kind === 'v4a') return applyV4A(tree, e.section, strict);
  return applyJSON(tree, e.edit);
}

function runCli(args: string[]): number {
  const out = (s: string) => process.stdout.write(s + '\n');
  const opts = parseArgs(args);
  if (opts === null) {
    out('error: usage');
    return 2;
  }
  let patchText: string;
  if (opts.patch === null || opts.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(join(process.cwd(), opts.patch), 'utf8');
    } catch {
      out('error: no-patch');
      return 2;
    }
  }
  const lines = splitPatch(patchText);
  let format = opts.format;
  if (format === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) {
      out('error: format');
      return 2;
    }
    format = detected;
  }
  let edits: EditDesc[];
  try {
    if (format === 'unified') {
      edits = parseUnified(lines).map((section) => ({ kind: 'unified' as const, section }));
    } else if (format === 'search-replace') {
      edits = parseSR(lines).map((block) => ({ kind: 'sr' as const, block }));
    } else if (format === 'v4a') {
      edits = parseV4A(lines).map((section) => ({ kind: 'v4a' as const, section }));
    } else {
      edits = parseJSON(patchText, lines).map((edit) => ({ kind: 'json' as const, edit }));
    }
  } catch (e) {
    if (e instanceof ParseError) {
      out(`error: parse ${e.line}`);
      return 2;
    }
    throw e;
  }
  if (edits.length === 0) {
    out('error: parse 1');
    return 2;
  }

  // Edits apply in the patch's order to the tree as earlier edits left it.
  // Every path an edit names is checked for safety before anything else
  // about it. A failed edit changes nothing, and the edits after it still
  // run. When any edit failed, no file is written.
  const tree = new Tree();
  const failures: EditFailure[] = [];
  for (const e of edits) {
    let unsafePath: string | null = null;
    for (const p of editPaths(e)) {
      if (!isSafePath(p)) {
        unsafePath = p;
        break;
      }
    }
    if (unsafePath !== null) {
      failures.push(fail('unsafe', unsafePath));
      continue;
    }
    const r = applyEdit(tree, e, opts.strict);
    if (r !== null) failures.push(r);
  }
  if (failures.length > 0) {
    for (const f of failures) out(`error: ${f.code} ${f.path}`);
    out(`failed: ${failures.length} of ${edits.length} edits`);
    return 1;
  }
  const changes = tree.changes();
  if (!opts.check) tree.writeAll();
  for (const c of changes) out(c.line);
  out(`ok: ${changes.length} ${changes.length === 1 ? 'file' : 'files'}`);
  return 0;
}

// When MAKEFUN_ENV_URL is set, hand the trial over to the harness; otherwise
// run the command line.
async function mainAsync(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl) {
    try {
      await runTrial(envUrl);
    } catch (err) {
      process.stderr.write(`mend: trial failed: ${String(err)}\n`);
      process.exitCode = 1;
    }
  } else {
    process.exitCode = runCli(process.argv.slice(2));
  }
}

mainAsync();
