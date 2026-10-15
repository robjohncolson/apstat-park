// Finds every environment variable name a JavaScript source file reads. Used by schema-audit.test.mjs
// to keep config/env-schema.json true to the mirrored service code.
//
// What counts as a read (comments are ignored):
//   process.env.X   process.env['X']   process.env["X"]   env.X / env['X'] (an injected env object)
//   a string literal passed to one of the known helpers below, at the helper's env-key position
// Any other dynamic access such as process.env[name] throws with file:line, so a sync that adds a
// new indirection fails loudly instead of silently hiding keys.

// The helpers in the services that read an env var whose name is an argument. `args` are the
// zero-based argument positions holding env names; `access` is the dynamic read inside the helper.
//   services/roster/frq-worker.js     configuredNumber(config, key, envKey, fallback, minimum, maximum)
//   services/relay/ai-grade-auth.js   capFromEnv(env, routeKey, sharedKey, fallback)
//   services/roster/teacher-auth.js   configuredPayoutSecret(name)
export const ENV_HELPERS = [
  { name: 'configuredNumber', args: [2], access: ['process.env[envKey]'] },
  { name: 'capFromEnv', args: [1, 2], access: ['env[routeKey]', 'env[sharedKey]'] },
  { name: 'configuredPayoutSecret', args: [0], access: ['process.env[name]'] }
];

// Is a `/` at position i the start of a regex literal (rather than division)? Decided by the last
// non-space character before it, which is enough for the service code.
function startsRegex(text, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0) return true;
  if ('(,=:[!&|?{};+-*%<>~^'.includes(text[j])) return true;
  const word = text.slice(0, j + 1).match(/[A-Za-z_$][\w$]*$/);
  return !!word && ['return', 'typeof', 'case', 'in', 'of', 'void', 'delete'].includes(word[0]);
}

// Index just past the closing quote of the string that opens at i.
function skipString(text, i) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue; }
    if (text[j] === quote) return j + 1;
    j++;
  }
  return j;
}

// Index just past the closing `/` (and flags) of the regex literal that opens at i.
function skipRegex(text, i) {
  let j = i + 1;
  let inClass = false;
  while (j < text.length && text[j] !== '\n') {
    const c = text[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) break;
    j++;
  }
  j++;
  while (j < text.length && /[a-z]/i.test(text[j])) j++;
  return j;
}

// Comment text replaced by spaces; newlines kept so line numbers still match the original file.
const blank = (s) => s.replace(/[^\n]/g, ' ');

// Removes // and /* */ comments. String, template and regex literals are copied unchanged.
export function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && next === '/') {
      let end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
      out += blank(text.slice(i, end));
      i = end;
      continue;
    }
    if (c === '/' && next === '*') {
      let end = text.indexOf('*/', i + 2);
      end = end === -1 ? text.length : end + 2;
      out += blank(text.slice(i, end));
      i = end;
      continue;
    }
    if (c === '/' && startsRegex(text, i)) {
      const end = skipRegex(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

// The env name in a quoted string literal ('X' or "X"), or '' when the argument is anything else.
function quotedEnvName(arg) {
  const m = arg.trim().match(/^(['"])([A-Z][A-Z0-9_]*)\1$/);
  return m ? m[2] : '';
}

// Splits the call arguments that start just after the `(` at index `open`. Respects nested
// brackets and string literals; good enough for call sites written with literal env names.
function callArgs(text, open) {
  const args = [];
  let depth = 0;
  let current = '';
  let i = open + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(text, i);
      current += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth--;
    }
    if (c === ',' && depth === 0) {
      args.push(current);
      current = '';
      i++;
      continue;
    }
    current += c;
    i++;
  }
  if (current.trim()) args.push(current);
  return args;
}

// Keys named by string literals at the helper's env-key positions, at every call site in `code`.
function helperReads(code, file, helper, reads) {
  const callRe = new RegExp(`\\b${helper.name}\\s*\\(`, 'g');
  for (const m of code.matchAll(callRe)) {
    const isDefinition = /function\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index));
    if (isDefinition) continue;
    const args = callArgs(code, m.index + m[0].length - 1);
    for (const position of helper.args) {
      const key = quotedEnvName(args[position] || '');
      if (!key) {
        throw new Error(`${file}:${lineOf(code, m.index)}: ${helper.name}(...) argument ${position + 1} is not a quoted env name; the audit cannot tell which key it reads`);
      }
      reads.add(key);
    }
  }
}

// A dynamic env[...] read is allowed only as a known helper's own access, inside a file that
// defines that helper.
function isKnownHelperAccess(code, access) {
  for (const helper of ENV_HELPERS) {
    if (!helper.access.includes(access)) continue;
    if (new RegExp(`function\\s+${helper.name}\\s*\\(`).test(code)) return true;
  }
  return false;
}

/**
 * envReadsFromSource(text, file) -> Set of env names read by this source.
 * Throws (with file:line) on a dynamic env[...] read it does not recognise.
 */
export function envReadsFromSource(text, file = '<source>') {
  const code = stripComments(text);
  const reads = new Set();

  // process.env.X and an injected env object's env.X
  for (const m of code.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) reads.add(m[1]);

  // env[...] with process.env or an injected env object: a quoted name, or a known helper's access
  for (const m of code.matchAll(/\b((?:process\.)?env)\s*\[([^\]]*)\]/g)) {
    const key = quotedEnvName(m[2]);
    if (key) { reads.add(key); continue; }
    const access = `${m[1]}[${m[2].trim()}]`;
    if (isKnownHelperAccess(code, access)) continue;
    throw new Error(`${file}:${lineOf(code, m.index)}: unrecognised dynamic env read ${access}; add the helper to ENV_HELPERS in scripts/lib/env-reads.mjs`);
  }

  for (const helper of ENV_HELPERS) helperReads(code, file, helper, reads);
  return reads;
}
