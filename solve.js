// Fast drop-in for csv-reader 1.0.0 (make.fun's own reference program).
//
// Returns exactly what csv-reader 1.0.0 returns for {text, header}:
// {columns, rows, errors}. Same broken-row policy, byte for byte:
//  - U+FEFF at the very start is dropped.
//  - A record ends at LF or CRLF; a line left with no characters is no record.
//  - Outside quotes a CR not followed by LF is dropped (stray_cr).
//  - A field opening with a quote runs to the next quote that is not doubled
//    ("" inside it is one quote; CRLF or a lone CR inside it reads as LF);
//    what follows its closing quote, up to the next comma or line break, is
//    appended as it stands (quote_junk, when the field ends); a quote that
//    never closes is a literal character and the text after it is read again
//    as unquoted (unterminated_quote).
//  - A quote inside an unquoted field is a literal character. Fields stay
//    strings, never trimmed or converted.
//  - columns is the first record when header is true, else null; rows holds
//    the records after it, each padded (short_row, with fields: its count)
//    or cut (long_row, with extra: the cut fields) to the first record's
//    width. Each error is {code, line, row}, in the order met; line is the
//    1-based line its record starts on, row its index in rows (null for the
//    header).
//
// Speed comes from letting the engine do the scanning: String.indexOf and
// String.split are native, so a record with no quote and no stray CR is
// sliced and split in C++ instead of walked character by character in JS.
// Only records that actually hold a quote or a stray CR take the
// field-by-field path, and there each field is still found with indexOf
// (next ',' or LF) instead of a per-character loop. No state is kept
// between calls; every run(input) is answered alone.

const COMMA = 0;
const BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function err(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // A quoted segment with its line breaks counted and its CRs read as LF.
  // Segments without a CR or LF (the common case) pass through untouched.
  function normSeg(seg) {
    if (seg.indexOf('\r') === -1) {
      if (seg.indexOf('\n') === -1) return seg;
      let cnt = 0;
      let k = -1;
      while ((k = seg.indexOf('\n', k + 1)) !== -1) cnt++;
      line += cnt;
      return seg;
    }
    const breaks = seg.match(/\r\n|\r|\n/g);
    if (breaks) line += breaks.length;
    return seg.replace(/\r\n?/g, '\n');
  }

  // Reads unquoted characters onto `init` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field
  // and how it ended; `added` counts the characters kept.
  function readUnquoted(init) {
    const ci = text.indexOf(',', pos);
    const li = text.indexOf('\n', pos);
    let end;
    let ended;
    if (ci === -1) {
      if (li === -1) { end = n; ended = END; }
      else { end = li; ended = BREAK; }
    } else if (li === -1) {
      end = ci; ended = COMMA;
    } else if (ci < li) {
      end = ci; ended = COMMA;
    } else {
      end = li; ended = BREAK;
    }
    const seg = text.slice(pos, end);
    let value;
    let added;
    const ri = seg.indexOf('\r');
    if (ri === -1) {
      value = init ? init + seg : seg;
      added = seg.length;
    } else {
      // Every CR in the segment is stray, except a trailing one when the
      // field ends at a LF: that one is the CRLF line break itself.
      let stray = 0;
      let k = ri;
      while (k !== -1) { stray++; k = seg.indexOf('\r', k + 1); }
      if (ended === BREAK && seg.charCodeAt(seg.length - 1) === 13) stray--;
      for (let i = 0; i < stray; i++) err('stray_cr');
      const clean = seg.replaceAll('\r', '');
      value = init ? init + clean : clean;
      added = clean.length;
    }
    if (ended === COMMA) pos = end + 1;
    else if (ended === BREAK) { pos = end + 1; line++; }
    else pos = n;
    return { value, ended, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let cur = pos;
    let parts = null;
    let value = '';
    for (;;) {
      const q = text.indexOf('"', cur);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        err('unterminated_quote');
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one quote in the value, keep scanning.
        if (!parts) parts = [];
        parts.push(normSeg(text.slice(cur, q)));
        parts.push('"');
        cur = q + 2;
        continue;
      }
      const seg = normSeg(text.slice(cur, q));
      value = parts ? parts.join('') + seg : seg;
      pos = q + 1;
      if (pos >= n) return { value, ended: END, added: 0 };
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value, ended: COMMA, added: 0 };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value, ended: BREAK, added: 0 };
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        return { value, ended: BREAK, added: 0 };
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      const junk = readUnquoted(value);
      if (junk.added > 0) err('quote_junk');
      return junk;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record holds no quote and no CR before its line break
    // (a CR that is the CRLF terminator itself is allowed), so the whole
    // record is one slice split on commas.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    const qi = text.indexOf('"', pos);
    const ri = text.indexOf('\r', pos);
    let fields;
    let lastQuoted = false;
    if (
      (qi === -1 || qi >= lineEnd) &&
      (ri === -1 || (nl !== -1 && ri === nl - 1))
    ) {
      const segEnd = nl !== -1 && ri === nl - 1 ? ri : lineEnd;
      fields = text.slice(pos, segEnd).split(',');
      if (nl === -1) {
        pos = n;
      } else {
        pos = nl + 1;
        line += 1;
      }
    } else {
      fields = [];
      let ended;
      do {
        let field;
        if (text.charCodeAt(pos) === 34) {
          lastQuoted = true;
          field = readQuoted();
        } else {
          lastQuoted = false;
          field = readUnquoted('');
        }
        fields.push(field.value);
        ended = field.ended;
      } while (ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
