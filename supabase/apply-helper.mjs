// Helper for supabase/apply.sh. Node is already a prerequisite (INSTALL step 0), so the SQL lexing and
// the JSON reading live here instead of in shell.
//
//   node supabase/apply-helper.mjs strip <file.sql>     print the execution copy (see below) to stdout
//   node supabase/apply-helper.mjs scan <file.sql>...   print which files carry transaction control
//   node supabase/apply-helper.mjs tables <project>     print expected-tables.json's list for core|content
//
// Why "strip": apply.sh runs every file as  BEGIN; <file>; INSERT tracking row; COMMIT;  in one psql
// session, so the migration and its tracking row commit together or not at all. Transactions do not
// nest: a file's own COMMIT would end apply.sh's transaction early, before the tracking row. So the
// runner owns the transaction and removes the file's own top-level `begin;` / `commit;` lines.
//
// The stripper is deliberately strict. It only removes a line that is exactly `begin;`, `commit;` or
// `start transaction;` (any case, surrounding spaces allowed), outside comments, strings and
// dollar-quoted bodies, at most one pair per file, begin before commit. Anything else that controls
// transactions (END, ROLLBACK, SAVEPOINT, BEGIN ISOLATION LEVEL ..., a second pair) or cannot run
// inside a transaction block (CONCURRENTLY, VACUUM, CREATE DATABASE, ALTER TYPE ... ADD VALUE, ...)
// stops with an error naming the file and line, because guessing could commit half a migration.
// Removed lines become `-- [apply.sh] removed: ...` so psql's line numbers still match the file.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

class LexError extends Error {
  constructor(line, message) {
    super(message);
    this.line = line;
  }
}

// ---------------------------------------------------------------------------------------------
// Lexer: split a SQL file into top-level statements. Comments are dropped; the contents of strings,
// quoted identifiers and $$ bodies are blanked out so keywords inside them are never matched.
// Returns [{ text, startLine, endLine }].
// ---------------------------------------------------------------------------------------------

function isIdentChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

// At src[i] === '$': the dollar-quote tag ("$$" or "$name$"), or null when it is not one.
function dollarTagAt(src, i) {
  if (isIdentChar(src[i - 1])) return null; // foo$bar is an identifier, not a quote
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 100));
  return match ? match[0] : null; // $1 (a parameter) does not match
}

function splitStatements(src) {
  const statements = [];
  let text = '';
  let line = 1;
  let startLine = null;
  let i = 0;

  function push(ch) {
    if (startLine === null && /\S/.test(ch)) startLine = line;
    text += ch;
  }

  function endStatement() {
    if (startLine !== null) statements.push({ text: text.trim(), startLine, endLine: line });
    text = '';
    startLine = null;
  }

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '\n') {
      line++;
      text += ' ';
      i++;
      continue;
    }

    // -- line comment: skip to the end of the line
    if (ch === '-' && next === '-') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    // /* block comment */, which nests in PostgreSQL
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === '\n') line++;
        if (src[i] === '/' && src[i + 1] === '*') { depth++; i += 2; continue; }
        if (src[i] === '*' && src[i + 1] === '/') { depth--; i += 2; continue; }
        i++;
      }
      if (depth > 0) throw new LexError(line, 'unterminated /* comment');
      text += ' ';
      continue;
    }

    // 'string' or "identifier". E'...' strings also honour backslash escapes.
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const backslashEscapes = quote === "'" && /[eE]/.test(src[i - 1] ?? '') && !isIdentChar(src[i - 2]);
      push(ch);
      i++;
      let closed = false;
      while (i < src.length) {
        const c = src[i];
        if (c === '\n') line++;
        if (backslashEscapes && c === '\\') { text += 'xx'; i += 2; continue; }
        if (c === quote && src[i + 1] === quote) { text += 'xx'; i += 2; continue; } // '' or ""
        if (c === quote) { text += c; i++; closed = true; break; }
        text += c === '\n' ? ' ' : 'x';
        i++;
      }
      if (!closed) throw new LexError(line, `unterminated ${quote} quote`);
      continue;
    }

    // $tag$ ... $tag$ (function bodies, DO blocks): one opaque token
    if (ch === '$') {
      const tag = dollarTagAt(src, i);
      if (tag) {
        const end = src.indexOf(tag, i + tag.length);
        if (end === -1) throw new LexError(line, `unterminated ${tag} body`);
        for (let k = i; k < end + tag.length; k++) if (src[k] === '\n') line++;
        push('$');
        text += 'body$ ';
        i = end + tag.length;
        continue;
      }
    }

    // psql meta-commands (\i, \connect, \if ...) change what runs and where: refuse them.
    if (ch === '\\' && text.trim() === '') {
      throw new LexError(line, 'psql meta-command (backslash command); apply.sh cannot reason about it');
    }

    if (ch === ';') {
      endStatement();
      i++;
      continue;
    }

    push(ch);
    i++;
  }

  endStatement();
  return statements;
}

// ---------------------------------------------------------------------------------------------
// Classify each top-level statement and build the execution copy.
// ---------------------------------------------------------------------------------------------

function normalise(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

const STRIPPABLE_BEGIN = new Set(['begin', 'start transaction']);
const STRIPPABLE_COMMIT = new Set(['commit']);

// Transaction control the stripper does not remove. Seeing one means the author wanted something
// apply.sh cannot reproduce inside its single transaction.
const OTHER_TRANSACTION_CONTROL =
  /^(begin|start transaction|commit|end|rollback|abort|savepoint|release|prepare transaction|set transaction|set session characteristics)\b/;

// Statements PostgreSQL refuses, or treats differently, inside a transaction block.
const NOT_IN_TRANSACTION = [
  { re: /\bconcurrently\b/, why: 'CONCURRENTLY cannot run inside a transaction block' },
  { re: /^vacuum\b/, why: 'VACUUM cannot run inside a transaction block' },
  { re: /^(create|drop) database\b/, why: 'CREATE/DROP DATABASE cannot run inside a transaction block' },
  { re: /^(create|drop) tablespace\b/, why: 'CREATE/DROP TABLESPACE cannot run inside a transaction block' },
  { re: /^alter system\b/, why: 'ALTER SYSTEM cannot run inside a transaction block' },
  {
    re: /^alter type\b.*\badd value\b/,
    why: 'ALTER TYPE ... ADD VALUE: the new value is unusable until commit (and refused inside a transaction before PostgreSQL 12)',
  },
  { re: /^(create|alter|drop) subscription\b/, why: 'subscription commands cannot run inside a transaction block' },
  { re: /^copy\b.*\bfrom stdin\b/, why: 'COPY FROM STDIN data cannot be fed through apply.sh' },
];

// Returns { text, stripped: [line numbers removed] } or throws LexError.
function buildExecutionCopy(src) {
  const lines = src.split('\n');
  const stripped = [];
  let opened = false;
  let closed = false;

  for (const stmt of splitStatements(src)) {
    const sql = normalise(stmt.text);

    for (const rule of NOT_IN_TRANSACTION) {
      if (rule.re.test(sql)) throw new LexError(stmt.startLine, rule.why);
    }

    const isBegin = STRIPPABLE_BEGIN.has(sql);
    const isCommit = STRIPPABLE_COMMIT.has(sql);
    if (!isBegin && !isCommit) {
      if (OTHER_TRANSACTION_CONTROL.test(sql)) {
        throw new LexError(stmt.startLine, `unsupported transaction control "${sql}"`);
      }
      continue;
    }

    // Only remove a statement that is the whole line, alone (`begin;`), never part of a line.
    const rawLine = lines[stmt.startLine - 1];
    const lineText = rawLine.replace(/\r$/, '');
    const alone = stmt.startLine === stmt.endLine && normalise(lineText) === `${sql};`;
    if (!alone) throw new LexError(stmt.startLine, `"${sql}" is not alone on its own line`);

    if (isBegin && (opened || closed)) throw new LexError(stmt.startLine, 'second BEGIN in one file');
    if (isCommit && (!opened || closed)) throw new LexError(stmt.startLine, 'COMMIT without a matching BEGIN');
    if (isBegin) opened = true;
    if (isCommit) closed = true;

    const cr = rawLine.endsWith('\r') ? '\r' : '';
    lines[stmt.startLine - 1] = `-- [apply.sh] removed: ${lineText.trim()}${cr}`;
    stripped.push(stmt.startLine);
  }

  if (opened && !closed) throw new LexError(lines.length, 'BEGIN without a matching COMMIT');
  return { text: lines.join('\n'), stripped };
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function strip(file) {
  let result;
  try {
    result = buildExecutionCopy(readFileSync(file, 'utf8'));
  } catch (err) {
    if (!(err instanceof LexError)) throw err;
    fail(`${file}:${err.line}: ${err.message}`);
  }
  process.stdout.write(result.text);
}

function scan(files) {
  let refused = 0;
  for (const file of files) {
    try {
      const { stripped } = buildExecutionCopy(readFileSync(file, 'utf8'));
      if (stripped.length > 0) console.log(`strips   ${file} (lines ${stripped.join(', ')})`);
    } catch (err) {
      if (!(err instanceof LexError)) throw err;
      console.log(`REFUSES  ${file}:${err.line}: ${err.message}`);
      refused++;
    }
  }
  if (refused > 0) process.exit(1);
}

function tables(project) {
  const expected = JSON.parse(readFileSync(join(here, 'expected-tables.json'), 'utf8'));
  const list = expected[project];
  if (!Array.isArray(list)) fail(`supabase/expected-tables.json has no "${project}" list`);
  console.log(list.join('\n'));
}

const [command, ...args] = process.argv.slice(2);
if (command === 'strip' && args.length === 1) strip(args[0]);
else if (command === 'scan' && args.length > 0) scan(args);
else if (command === 'tables' && args.length === 1) tables(args[0]);
else fail('usage: apply-helper.mjs strip <file> | scan <file>... | tables <core|content>');
