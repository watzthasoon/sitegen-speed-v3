// solve.js — drop-in fast site generator for makefun-site 1.0.0.
//
// Semantics: byte-identical to the reference implementation for every
// input the kit's scorer can feed it. Speed: the hot paths (Markdown
// inline rendering, HTML escaping, word counting, front-matter parsing,
// template rendering) avoid token arrays, per-character regexes and
// repeated concatenation. All text work is index-based over the original
// string; the output is assembled into one shared array and joined once
// per page.
//
// Entry point: run(input) -> output (see the bottom of this file).
// Input and output are plain objects whose shape is fixed by the kit's
// program/main.ts (input: {files, config, ...}; output: {files, ...}).

const SLUG_MAX = 64;

// ---------------------------------------------------------------- text ---

// HTML escape map for the five characters the reference escapes.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Global regex used by escapeTo; lastIndex is reset on every call.
const SPECIAL_G = /[&<>"']/g;

// Append s[start..end) HTML-escaped to out. Fast path: a single native
// scan when the range holds no escapable character at all.
function escapeTo(s, start, end, out) {
  SPECIAL_G.lastIndex = start;
  let m = SPECIAL_G.exec(s);
  if (m === null || m.index >= end) {
    out.push(s.slice(start, end));
    return;
  }
  let last = start;
  do {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(ESCAPES[m[0]]);
    last = m.index + 1;
    m = SPECIAL_G.exec(s);
  } while (m !== null && m.index < end);
  if (last < end) out.push(s.slice(last, end));
}

// Escape a whole string and return it (for the few places that need a
// string, e.g. a link target). Short strings: a tiny array + join.
function escapeStr(s) {
  const out = [];
  escapeTo(s, 0, s.length, out);
  return out.join('');
}

// Test for any of the five escapable characters (non-global regex, so
// no lastIndex state to manage).
const HAS_SPECIAL = /[&<>"']/;

// --- slugify -------------------------------------------------------------
const NON_ASCII = /[^\x00-\x7F]/;
const COMBINING = /\p{M}/gu;

// Lowercase ASCII alnum kept, everything else dropped, runs of dropped
// chars become one '-', result capped at 64 chars with trailing dashes
// stripped, empty becomes 'untitled'. Operates on UTF-16 code units;
// astral characters are never alnum, so they drop exactly as they would
// under code-point iteration.
function slugCore(plain) {
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;            // A-Z -> a-z
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

// Per-case memoised slugify (the memo lives in the run context, so a
// case never sees another case's entries). Non-ASCII input is first
// decomposed (NFKD) with combining marks dropped, exactly as the
// reference does; ASCII input skips that work entirely.
function slugify(text, memo) {
  let s = memo.get(text);
  if (s !== undefined) return s;
  s = NON_ASCII.test(text)
    ? slugCore(text.normalize('NFKD').replace(COMBINING, ''))
    : slugCore(text);
  memo.set(text, s);
  return s;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

// --- dates ---------------------------------------------------------------
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
];

// 'YYYY-MM-DD' -> 'D Month YYYY' (day without a leading zero).
function longDate(date) {
  return Number(date.slice(8, 10)) + ' ' +
    MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
}

// --- word count ----------------------------------------------------------
// JS \s is exactly: 9-13, 32, 160, 5760, 8192-8202, 8232, 8233, 8239,
// 8287, 12288, 65279. Counting runs of non-whitespace code units gives
// the same count as text.match(/\S+/g).length (surrogate pairs are two
// non-whitespace units in a row, i.e. one word, in both cases).
function isWS(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
    c === 8287 || c === 12288 || c === 65279;
}

function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWS(text.charCodeAt(i))) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// --- paths ---------------------------------------------------------------
// Join dir + '/' + rel, collapsing '.' and '..' segments. Fast path:
// when rel holds no dot segment, no empty segment and no trailing
// slash, the result is a plain concatenation. The slow path is the
// reference's segment loop (used rarely).
function resolvePath(dir, rel) {
  if (rel.length > 0 &&
    rel.indexOf('..') === -1 &&
    rel.indexOf('./') === -1 &&
    rel.charCodeAt(0) !== 46 && rel.charCodeAt(0) !== 47 &&
    !rel.endsWith('/.') && !rel.endsWith('/') &&
    rel.indexOf('//') === -1) {
    return dir === '' ? rel : dir + '/' + rel;
  }
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// Split a source path into its directory ('a/b' -> 'a', 'a' -> '').
function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

// ---------------------------------------------------------- front matter ---

// Front-matter value parsers. Each returns {value} or {error} with the
// exact error string the reference produces, so a bad source is reported
// (and skipped) the same way.

// "key: value" line. Returns {key, raw} (raw has trailing spaces/tabs
// stripped), or {error} when the line is not a valid key/value line.
// The reference regex is /^([a-z_]+):(?: (.*))?$/ — the value must be
// separated from the key by exactly one space, or absent entirely.
function fmLine(line, lineno) {
  const colon = line.indexOf(':');
  if (colon === -1) return { error: `line ${lineno} is not "key: value"` };
  const key = line.slice(0, colon);
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || c === 95)) {
      return { error: `line ${lineno} is not "key: value"` };
    }
  }
  if (key.length === 0) return { error: `line ${lineno} is not "key: value"` };
  let raw;
  if (colon === line.length - 1) raw = '';
  else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
  else return { error: `line ${lineno} is not "key: value"` };
  // strip trailing spaces and tabs
  let e = raw.length;
  while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
  return { key, raw: raw.slice(0, e) };
}

// A bare string, or a quoted string with only \" and \\ escapes. A
// quoted string that is not closed, holds a stray quote, or holds any
// other escape is an error.
function stringOf(raw) {
  if (raw.length === 0) return { value: '' };
  if (raw.charCodeAt(0) !== 34) {
    if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
    return { value: raw };
  }
  if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
    return { error: 'a quoted string is not closed' };
  }
  let out = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i];
    if (c === '\\') {
      const n = raw[i + 1];
      if (i + 1 >= raw.length - 1 || (n !== '"' && n !== '\\')) {
        return { error: 'a quoted string holds an escape other than \\" or \\\\' };
      }
      out += n;
      i++;
    } else if (c === '"') {
      return { error: 'a quoted string holds a stray quote' };
    } else out += c;
  }
  return { value: out };
}

// YYYY-MM-DD, a real day between 1970-01-01 and 2099-12-31.
function daysIn(y, m) {
  switch (m) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12: return 31;
    case 4: case 6: case 9: case 11: return 30;
    default: return ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28;
  }
}

function dateOf(raw) {
  if (raw.length !== 10 ||
    raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) {
    return { error: 'not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) {
    const d = raw.charCodeAt(i);
    if (d < 48 || d > 57) return { error: 'not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  const y = Number(raw.slice(0, 4));
  const mo = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
    return { error: 'not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  return { value: raw };
}

// [a, b] — commas separate, each tag is trimmed, empty tags and tags
// holding " [ ] are errors.
function tagsOf(raw) {
  if (!raw.startsWith('[') || !raw.endsWith(']')) {
    return { error: 'key "tags": not a list [a, b]' };
  }
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return { value: [] };
  const parts = inner.split(',');
  const out = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].trim();
    if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
      return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    out[i] = t;
  }
  return { value: out };
}

function boolOf(raw) {
  if (raw === 'true') return { value: true };
  if (raw === 'false') return { value: false };
  return { error: 'key "draft": true or false' };
}

// [a-z0-9-]+
function nameOf(raw) {
  if (raw.length === 0) return { error: 'not a template name' };
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) {
      return { error: 'not a template name' };
    }
  }
  return { value: raw };
}

// [a-z0-9]+(-[a-z0-9]+)*, at most 64 chars.
function slugValOf(raw) {
  if (raw.length === 0 || raw.length > 64) {
    return { error: 'key "slug": not a slug' };
  }
  const first = raw.charCodeAt(0);
  if (!((first >= 97 && first <= 122) || (first >= 48 && first <= 57))) {
    return { error: 'key "slug": not a slug' };
  }
  let prevDash = false;
  for (let i = 1; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return { error: 'key "slug": not a slug' };
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return { error: 'key "slug": not a slug' };
  }
  if (prevDash) return { error: 'key "slug": not a slug' };
  return { value: raw };
}

// Parse one key's raw value. Mirrors the reference's valueOf switch.
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const r = stringOf(raw);
      if (r.error) return { error: `key "${key}": ${r.error}` };
      return r;
    }
    case 'date': {
      const r = dateOf(raw);
      if (r.error) return { error: `key "date": ${r.error}` };
      return r;
    }
    case 'tags': return tagsOf(raw);
    case 'draft': return boolOf(raw);
    case 'layout': {
      const r = nameOf(raw);
      if (r.error) return { error: `key "layout": ${r.error}` };
      return r;
    }
    case 'slug': return slugValOf(raw);
    default: return { error: `unknown key "${key}"` };
  }
}

const FM_KEY_SET = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

// Is a front-matter line blank, or a '#' comment?
function fmSkip(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 35) return true; // '#'
  if (c === 32 || c === 9) {
    for (let i = 0; i < line.length; i++) {
      const d = line.charCodeAt(i);
      if (d !== 32 && d !== 9) return false;
    }
    return true;
  }
  return false;
}

// Parse the front matter of a source whose lines[0] is '---'.
// Returns {data, bodyStart} or {error}. The body is lines[bodyStart..]
// of the same lines array (no copy is made). The check order and the
// error strings match the reference: unknown key, then a key given
// twice, then a key with no value, then the value's own error.
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (fmSkip(line)) continue;
    const parsed = fmLine(line, i + 1);
    if (parsed.error) return { error: parsed.error };
    const key = parsed.key;
    if (!FM_KEY_SET.has(key)) return { error: `unknown key "${key}"` };
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      return { error: `key "${key}" is given twice` };
    }
    if (parsed.raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, parsed.raw);
    if (v.error) return { error: v.error };
    data[key] = v.value;
  }
  if (!Object.prototype.hasOwnProperty.call(data, 'title')) {
    return { error: 'no title' };
  }
  return { data, bodyStart: close + 1 };
}

// -------------------------------------------------------------- markdown ---

// A line of only spaces and tabs (or empty) — the reference's BLANK.
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A line with spaces and tabs dropped at either end (the reference's
// trimLine). Only spaces and tabs count; other whitespace is kept.
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

// A fenced-code opening line: '```' + a language of [A-Za-z0-9_+-]*
// + only spaces/tabs. Returns the language, or null.
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
    i++;
  }
  const lang = line.slice(3, i);
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === line.length ? lang : null;
}

// A fenced-code closing line: '```' + only spaces/tabs.
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// An ATX heading: 1-6 '#', then spaces/tabs, then text (trailing
// spaces/tabs dropped) that is not empty. Returns {depth, text} or null.
function headingOf(line) {
  let n = 0;
  while (n < 6 && line.charCodeAt(n) === 35) n++;
  if (n === 0) return null;
  if (line.charCodeAt(n) !== 32 && line.charCodeAt(n) !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

// A thematic break: exactly '---' or '***' + only spaces/tabs.
function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Whether a line ends a paragraph: blank, fence, heading or break.
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

// --- inline --------------------------------------------------------------

// The characters a backslash escapes. A lookup table by char code
// (only codes < 128 can be escapable, so a 128-entry table is exact).
const ESCAPABLE_TABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE_TABLE[ch.charCodeAt(0)] = 1;

// The next inline special in s from `from`: a backslash, a backtick, a
// star, an open bracket, or an HTML escapable character (& < > " ').
// One native regex search serves both the inline structure and the
// escaping: a plain run between two matches holds no character of
// either kind, so it is pushed as-is with no escape scan at all.
const NEXT_SPECIAL = /[\\`\*&<>"'[]/g;

// Whitespace in a link target (the reference's /\s/ test).
const HAS_WS = /\s/;

// Is the character at j escaped — preceded by an odd run of
// backslashes? The reference's forward scan from the span's start
// gives the same answer: a backslash run's parity decides the last
// one's effect, and a run cannot reach back past the span's opening
// characters (which are not backslashes).
function isEscaped(s, j) {
  let n = 0;
  let k = j - 1;
  while (k >= 0 && s.charCodeAt(k) === 92) { n++; k--; }
  return (n & 1) === 1;
}

// The first '**' from `from` outside an escape, or -1.
function findDoubleStar(s, from, end) {
  let j = s.indexOf('**', from);
  while (j !== -1 && j < end) {
    if (!isEscaped(s, j)) return j;
    j = s.indexOf('**', j + 1);
  }
  return -1;
}

// The first single '*' from `from` (one whose run is not '**'),
// outside an escape, or -1. A star that is itself escaped is skipped
// before the '**' check, so an escaped star in '\**' leaves the second
// star findable — exactly as the reference's left-to-right scan does.
function findSingleStar(s, from, end) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < end) {
    if (isEscaped(s, j)) { j = s.indexOf('*', j + 1); continue; }
    if (s.charCodeAt(j + 1) === 42) { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

// The first ']' from `from` outside an escape, or -1.
function findBracket(s, from, end) {
  let j = s.indexOf(']', from);
  while (j !== -1 && j < end) {
    if (!isEscaped(s, j)) return j;
    j = s.indexOf(']', j + 1);
  }
  return -1;
}

// Render s[start..end) inline into out. env.link(target) is a link's
// href. Nested strong/emphasis recurse on the same string by index
// (no slice is made for the inner span).
function inlineTo(s, start, end, out, env) {
  let i = start;
  while (i < end) {
    NEXT_SPECIAL.lastIndex = i;
    const m = NEXT_SPECIAL.exec(s);
    const next = (m !== null && m.index < end) ? m.index : end;
    if (next > i) {
      // A plain run: the unified regex guarantees it holds no inline
      // special and no HTML escapable character, so it goes out as-is.
      out.push(s.slice(i, next));
      i = next;
    }
    if (i >= end) break;
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      // An HTML escapable character, found by the unified search:
      // emit its entity and move on.
      out.push(ESCAPES[s[i]]);
      i++;
    } else if (c === 92) { // backslash
      const n = i + 1 < end ? s.charCodeAt(i + 1) : -1;
      if (n >= 0 && n < 128 && ESCAPABLE_TABLE[n] === 1) {
        if (n === 62) out.push('&gt;');
        else out.push(s[i + 1]);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
    } else if (c === 96) { // backtick: code span (plain indexOf, no escape check)
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < end && j > i + 1) {
        out.push('<code>');
        escapeTo(s, i + 1, j, out);
        out.push('</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
    } else if (c === 42) { // star
      if (s.charCodeAt(i + 1) === 42) {
        const j = findDoubleStar(s, i + 2, end);
        if (j !== -1 && j > i + 2) {
          out.push('<strong>');
          inlineTo(s, i + 2, j, out, env);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
      } else {
        const j = findSingleStar(s, i + 1, end);
        if (j !== -1 && j > i + 1) {
          out.push('<em>');
          inlineTo(s, i + 1, j, out, env);
          out.push('</em>');
          i = j + 1;
        } else {
          out.push('*');
          i++;
        }
      }
    } else { // '[': a link, or a literal bracket
      const k = findBracket(s, i + 1, end);
      const mIdx = (k !== -1 && s.charCodeAt(k + 1) === 40) ? s.indexOf(')', k + 2) : -1;
      const target = (mIdx !== -1 && mIdx < end) ? s.slice(k + 2, mIdx) : '';
      if (target !== '' && !HAS_WS.test(target)) {
        const href = env.link(target);
        out.push('<a href="');
        escapeTo(href, 0, href.length, out);
        out.push('">');
        inlineTo(s, i + 1, k, out, env);
        out.push('</a>');
        i = mIdx + 1;
      } else {
        out.push('[');
        i++;
      }
    }
  }
}

// Render the body lines[bodyStart..bodyEnd) to HTML, its table of
// contents (every level 2 and 3 heading: level, id and inline HTML)
// and its excerpt (the first paragraph's inline HTML, or '').
// Blocks are appended to one shared array, each followed by '\n',
// and joined once at the end — the same shape as the reference's
// blocks.map(b => b + '\n').join('').
// ctx: { ids: Set (heading ids taken in this body), slugMemo: Map }.
function renderMarkdown(lines, bodyStart, bodyEnd, env, ctx) {
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = bodyStart;
  while (i < bodyEnd) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i++;
      out.push('<pre><code');
      if (lang !== '') {
        out.push(' class="language-');
        escapeTo(lang, 0, lang.length, out);
        out.push('"');
      }
      out.push('>');
      while (i < bodyEnd && !isFenceClose(lines[i])) {
        escapeTo(lines[i], 0, lines[i].length, out);
        out.push('\n');
        i++;
      }
      if (i < bodyEnd) i++; // the closing fence
      out.push('</code></pre>\n');
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text, ctx.slugMemo), ctx.ids);
      const hOut = [];
      inlineTo(hd.text, 0, hd.text.length, hOut, env);
      const html = hOut.join('');
      out.push('<h', String(hd.depth), ' id="', id, '">', html, '</h', String(hd.depth), '>\n');
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { out.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) { // '>': blockquote
      const parts = [];
      while (i < bodyEnd && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        const t = trimLine(l);
        if (t !== '') parts.push(t);
      }
      if (parts.length === 0) {
        out.push('<blockquote>\n</blockquote>\n');
      } else {
        const joined = parts.join('\n');
        out.push('<blockquote>\n<p>');
        inlineTo(joined, 0, joined.length, out, env);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const c0 = line.charCodeAt(0);
    const isBullet = (c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32;
    // Ordered: 1-9 digits, '. ', then the item.
    let ordDigits = 0;
    if (!isBullet && c0 >= 48 && c0 <= 57) {
      let j = 0;
      while (j < 9 && j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
      if (j >= 1 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) ordDigits = j;
    }
    if (isBullet || ordDigits > 0) {
      const isOrdered = ordDigits > 0;
      const start = isOrdered ? Number(line.slice(0, ordDigits)) : 1;
      const tag = isOrdered ? 'ol' : 'ul';
      // Each item is its parts (the marker line, then continuation
      // lines), joined with '\n' and rendered once — as the reference
      // does. A continuation is 2+ spaces then a non-whitespace char.
      const items = [];
      while (i < bodyEnd) {
        const l = lines[i];
        const d0 = l.charCodeAt(0);
        let itemText = null;
        if (!isOrdered && (d0 === 45 || d0 === 42) && l.charCodeAt(1) === 32) {
          itemText = trimLine(l.slice(2));
        } else if (isOrdered) {
          let j = 0;
          while (j < 9 && j < l.length && l.charCodeAt(j) >= 48 && l.charCodeAt(j) <= 57) j++;
          if (j >= 1 && l.charCodeAt(j) === 46 && l.charCodeAt(j + 1) === 32) {
            itemText = trimLine(l.slice(j + 2));
          }
        }
        if (itemText !== null) {
          items.push([itemText]);
          i++;
          continue;
        }
        let sp = 0;
        while (sp < l.length && l.charCodeAt(sp) === 32) sp++;
        if (sp >= 2 && sp < l.length && !isWS(l.charCodeAt(sp))) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      if (isOrdered && start !== 1) out.push('<ol start="', String(start), '">\n');
      else out.push('<', tag, '>\n');
      for (const parts of items) {
        const itemText = parts.join('\n');
        out.push('<li>');
        inlineTo(itemText, 0, itemText.length, out, env);
        out.push('</li>\n');
      }
      out.push('</', tag, '>\n');
      continue;
    }
    // Paragraph: trimmed lines until a blank line, fence, heading or break.
    const pParts = [trimLine(line)];
    i++;
    while (i < bodyEnd && !endsParagraph(lines[i])) pParts.push(trimLine(lines[i++]));
    const pText = pParts.join('\n');
    const pOut = [];
    inlineTo(pText, 0, pText.length, pOut, env);
    const pHtml = pOut.join('');
    if (excerpt === null) excerpt = pHtml;
    out.push('<p>', pHtml, '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// -------------------------------------------------------------- templates ---

const INCLUDE_DEPTH = 8;

// A template that does not parse: its name and why.
class TemplateError extends Error {}

// A path is names joined by dots (a-z, A-Z, 0-9 and _, from a letter
// or _). Parse-time validation, so a regex is fine here.
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

// Only spaces/tabs in s[a..b)?
function onlySpaceTab(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// src's tokens: text, {{ }}, {{{ }}} and {% %}. A {% %} tag alone on
// its line (only spaces or tabs beside it) takes its whole line with
// it, its newline included.
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) { // not '{' or '%': a literal '{'
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) { // '{{' or '{{{'
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      }
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({
        t: raw ? 'raw' : 'var',
        path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()),
      });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaceTab(src, lineStart, open) && onlySpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// src parsed into its tree of nodes (a TemplateError when it does not
// parse). Nodes: text, var, raw, if {not, path, then, else}, for
// {name, path, body}, include {name}.
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) {
          throw new TemplateError(`template "${name}": an else outside an if`);
        }
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body
          : parent.kind === 'for' ? parent.body
          : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
        body.push({ kind: 'include', name: m[1] });
      } else {
        throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) {
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  }
  return root.body;
}

// The value at `path` in the scope chain: its first name from the
// nearest scope holding it, then own properties.
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.prototype.hasOwnProperty.call(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

// A value as text: a string itself, a number in JavaScript's digits,
// true or false, an array's items joined by ", ", else "".
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

// Whether a value counts as true in an if: not undefined, null, false,
// "", 0 or an empty array.
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// --- global-template analysis --------------------------------------------
// A template is global when its output depends only on the case-global
// values (site, tags, recent): every free first name it (or any
// template it includes, transitively) reads is one of those three, and
// no for-loop anywhere binds one of the global names (site, tags,
// recent, page) — a loop variable would shadow the case-global value
// for a template included inside the loop. A global template is
// rendered once per case and its string reused for every page that
// includes it (header, footer, nav, badge, note). A template that
// reads `loop` is not global: loop only exists inside a for.

// Collect a node tree's free first names (names not bound by an
// enclosing for) and the names it includes.
function collectFree(nodes, bound, free, includes) {
  for (const n of nodes) {
    if (n.kind === 'text') continue;
    if (n.kind === 'var' || n.kind === 'raw') {
      const first = n.path[0];
      if (!bound.has(first)) free.add(first);
    } else if (n.kind === 'if') {
      const first = n.path[0];
      if (!bound.has(first)) free.add(first);
      collectFree(n.then, bound, free, includes);
      if (n.else !== null) collectFree(n.else, bound, free, includes);
    } else if (n.kind === 'for') {
      const first = n.path[0];
      if (!bound.has(first)) free.add(first);
      const b2 = new Set(bound);
      b2.add(n.name);
      b2.add('loop');
      collectFree(n.body, b2, free, includes);
    } else if (n.kind === 'include') {
      includes.add(n.name);
    }
  }
}

// Does any for-loop in these nodes bind one of the given names?
function bindsGlobal(nodes, names) {
  for (const n of nodes) {
    if (n.kind === 'for') {
      if (names.has(n.name)) return true;
      if (bindsGlobal(n.body, names)) return true;
    } else if (n.kind === 'if') {
      if (bindsGlobal(n.then, names)) return true;
      if (n.else !== null && bindsGlobal(n.else, names)) return true;
    }
  }
  return false;
}

const GLOBAL_NAMES = new Set(['site', 'tags', 'recent']);
const LOOP_BOUND_GUARD = new Set(['site', 'tags', 'recent', 'page']);

// For every parsed template: whether it is global. Returns
// { info: Map(name -> boolean), ok: boolean } where ok is false when
// any for-loop binds a global name (then no template is cached).
function analyseGlobals(templates) {
  const info = new Map();
  let ok = true;
  for (const [name, nodes] of templates) {
    const free = new Set();
    const includes = new Set();
    collectFree(nodes, new Set(), free, includes);
    info.set(name, { free, includes, global: undefined });
    if (ok && bindsGlobal(nodes, LOOP_BOUND_GUARD)) ok = false;
  }
  if (!ok) {
    for (const v of info.values()) v.global = false;
    return { info, ok: false };
  }
  const visiting = new Set();
  function isGlobal(name) {
    const inf = info.get(name);
    if (inf === undefined) return true; // a missing template renders nothing
    if (inf.global !== undefined) return inf.global;
    if (visiting.has(name)) return true; // a cycle: the members' own
    // free-name checks decide; all-global members are global
    visiting.add(name);
    let g = true;
    for (const f of inf.free) {
      if (!GLOBAL_NAMES.has(f)) { g = false; break; }
    }
    if (g) {
      for (const inc of inf.includes) {
        if (!isGlobal(inc)) { g = false; break; }
      }
    }
    visiting.delete(name);
    inf.global = g;
    return g;
  }
  for (const name of info.keys()) isGlobal(name);
  return { info, ok: true };
}

// nodes rendered into out, in scope ({vars, parent}), at include
// depth `depth`. ctx carries the templates, the global analysis, the
// per-case cache of rendered global templates and the case-global
// scope they render in.
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const v = textOf(lookup(scope, n.path));
        if (v !== '') escapeTo(v, 0, v.length, out);
        break;
      }
      case 'raw': {
        const v = textOf(lookup(scope, n.path));
        if (v !== '') out.push(v);
        break;
      }
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = {
            [n.name]: xs[k],
            loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len },
          };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        if (ctx.globalOK) {
          const inf = ctx.globalInfo.get(n.name);
          if (inf !== undefined && inf.global) {
            let cached = ctx.globalCache.get(n.name);
            if (cached === undefined) {
              const tmp = [];
              renderNodes(t, ctx.globalScope, ctx, depth + 1, tmp);
              cached = tmp.join('');
              ctx.globalCache.set(n.name, cached);
            }
            if (cached !== '') out.push(cached);
            break;
          }
        }
        renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ build ---

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

// Code-unit order (never the locale's).
function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Does `target` start with a URI scheme (the reference's
// /^[A-Za-z][A-Za-z0-9+.-]*:/ test)?
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true; // ':'
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

// A page's link record as templates read it.
function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

// A post's card, as lists show it.
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

// A page as its layout reads it.
function pageOf(s) {
  const c = cardOf(s);
  c.slug = s.slug;
  c.content = s.html;
  c.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
  c.newer = linkOf(s.newer ?? null);
  c.older = linkOf(s.older ?? null);
  c.is_post = s.post;
  return c;
}

// One site's output tree: path -> text. The pipeline runs the
// reference's plugins in order; every rule, message and sort is the
// reference's, only the machinery is faster.
export function run(input) {
  const slugMemo = new Map();
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const bySource = new Map();
  const broken = new Set();
  const output = {};

  // 1. The sources, in code-unit order of their paths, line ends made
  // "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1
        ? f.content
        : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, lines: text.split('\n') });
    } else {
      statics.push({ path: f.path, content: f.content });
    }
  }

  // 2. Each source's front matter: a refused source is reported and
  // dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(d + '/')) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.prototype.hasOwnProperty.call(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  const keptSources = kept;

  // 3. Each page's output directory and url: its slug made unique in
  // its directory, in source order.
  const taken = new Map();
  for (const s of keptSources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(
      s.data.slug ?? slugify(s.data.title, slugMemo),
      set,
    );
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and
  // static files they name.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const mdCtx = { ids: null, slugMemo };
  for (const s of keptSources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) {
          return target;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
        if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    mdCtx.ids = new Set();
    const md = renderMarkdown(s.lines, s.bodyStart, s.lines.length, env, mdCtx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    // The body's words, counted per line (a '\n' between lines is a
    // word separator, so the sum over lines is the whole body's count).
    let words = 0;
    for (let i = s.bodyStart; i < s.lines.length; i++) words += wordsOf(s.lines[i]);
    s.words = words;
  }

  // 5. The posts, newest first and then by slug; each post's newer
  // and older neighbours.
  const posts = keptSources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in
  // the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    const tags = p.data.tags ?? [];
    for (const name of tags) {
      const slug = slugify(name, slugMemo);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of keptSources) {
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    const tags = s.data.tags ?? [];
    for (const name of tags) {
      const slug = slugify(name, slugMemo);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tagList = [...bySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
  );

  // 7. Every page through its layout, the index pages and the tag
  // pages through theirs.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const globals = analyseGlobals(templates);
  const ctx = {
    templates,
    globalInfo: globals.info,
    globalOK: globals.ok,
    globalCache: new Map(),
    globalScope: { vars: { site, tags: allTags, recent }, parent: null },
    slugMemo,
  };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    const scope = { vars: { site, tags: allTags, recent, ...vars }, parent: null };
    renderNodes(nodes, scope, ctx, 0, out);
    return out.join('');
  };
  for (const s of keptSources) {
    output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tagList) {
    const html = render('tag', {
      tag: {
        name: t.name,
        slug: t.slug,
        url: t.url,
        count: t.posts.length,
        posts: t.posts.map((p) => cards.get(p)),
      },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.prototype.hasOwnProperty.call(output, f.path)) {
      report.push(`shadowed ${f.path}: a built page has its path`);
    } else {
      output[f.path] = f.content;
    }
  }

  // 8. The report: every refusal, draft, broken link and template
  // that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of keptSources) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = lines.join('\n') + '\n';
  return output;
}
