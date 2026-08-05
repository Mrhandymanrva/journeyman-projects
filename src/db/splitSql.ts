export interface SqlStatement {
  text: string;
  /** 1-based line in the source file where the statement begins. */
  startLine: number;
}

/**
 * Split a PostgreSQL script into top-level statements.
 *
 * Naive splitting on ';' is wrong for this schema: it carries dollar-quoted
 * function bodies that themselves contain semicolons, and one DO block that
 * nests `$f$` inside `$$`. Nested dollar quoting with distinct tags is legal
 * Postgres — the tag has to match to close — so the scanner tracks the open tag
 * rather than any '$$'.
 */
export function splitSqlStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let buffer = '';
  let line = 1;
  let startLine = 1;
  let i = 0;

  const push = () => {
    if (buffer.trim().length > 0) statements.push({ text: buffer.trim(), startLine });
    buffer = '';
    startLine = line;
  };

  while (i < sql.length) {
    const ch = sql[i]!;
    const rest = () => sql.slice(i);

    // line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      buffer += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // block comment (nestable in Postgres)
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 0;
      const start = i;
      while (i < sql.length) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else {
          if (sql[i] === '\n') line++;
          i++;
        }
      }
      buffer += sql.slice(start, i);
      continue;
    }

    // single-quoted literal ('' is an embedded quote)
    if (ch === "'") {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        if (sql[i] === '\n') line++;
        i++;
      }
      buffer += sql.slice(start, i);
      continue;
    }

    // double-quoted identifier
    if (ch === '"') {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i++;
          break;
        }
        if (sql[i] === '\n') line++;
        i++;
      }
      buffer += sql.slice(start, i);
      continue;
    }

    // dollar-quoted string: $tag$ ... $tag$
    if (ch === '$') {
      const open = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest());
      if (open) {
        const tag = open[0];
        const start = i;
        i += tag.length;
        const close = sql.indexOf(tag, i);
        const stop = close === -1 ? sql.length : close + tag.length;
        for (let k = start; k < stop; k++) if (sql[k] === '\n') line++;
        buffer += sql.slice(start, stop);
        i = stop;
        continue;
      }
    }

    if (ch === ';') {
      buffer += ch;
      i++;
      push();
      continue;
    }

    if (ch === '\n') line++;
    buffer += ch;
    i++;
  }

  push();
  return statements;
}
