// A fast drop-in replacement for csv-reader 1.0.0: run(input) returns exactly the answer csv-reader 1.0.0
// returns for every input {text, header} — the JSON value {columns, rows, errors} — but reads the text with
// slice-based field extraction instead of character-at-a-time concatenation.
//
// The reading policy is csv-reader's own, byte for byte:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled ("" inside it is one quote,
//     and each CRLF or lone CR inside it is read as LF); what follows its closing quote, up to the next comma
//     or line break, is appended as it stands (quote_junk, when anything was appended); a quote that never
//     closes is a literal character and the text after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed;
//   - columns is the first record when header is true, else null; rows holds the records after it (every
//     record when header is false), each padded with "" (short_row, with fields: its field count) or cut
//     (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row} in the order met: line the 1-based line its record starts on (every
//     LF, CRLF and lone CR inside quotes counted), row its record's index in rows (null for the header).
//
// Pure: no clock, no randomness, nothing kept from one call to the next.

const COMMA_END = 0;
const BREAK_END = 1;
const TEXT_END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read, shared through these instead of a fresh result object per field.
  let fValue = '';
  let fEnded = TEXT_END;
  let fAdded = 0;

  // Reads unquoted characters onto `prefix` up to the next comma or line break, dropping stray CRs.
  // Sets fValue, fEnded and fAdded (the characters kept from this call).
  function scanUnquoted(prefix) {
    let i = pos;
    let segStart = i;
    let parts = null; // kept segments, once a stray CR has split the field
    let partsLen = 0;
    let end = len;
    fEnded = TEXT_END;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 44) {
        // ','
        end = i;
        pos = i + 1;
        fEnded = COMMA_END;
        break;
      }
      if (c === 10) {
        // LF
        end = i;
        line += 1;
        pos = i + 1;
        fEnded = BREAK_END;
        break;
      }
      if (c === 13) {
        // CR
        if (text.charCodeAt(i + 1) === 10) {
          end = i;
          line += 1;
          pos = i + 2;
          fEnded = BREAK_END;
          break;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, i));
        partsLen += i - segStart;
        i += 1;
        segStart = i;
        continue;
      }
      i += 1;
    }
    if (fEnded === TEXT_END) pos = len;
    if (parts === null) {
      fAdded = end - segStart;
      fValue = segStart === end ? prefix : prefix === '' ? text.slice(segStart, end) : prefix + text.slice(segStart, end);
    } else {
      fAdded = partsLen + (end - segStart);
      parts.push(text.slice(segStart, end));
      const joined = parts.join('');
      fValue = prefix === '' ? joined : prefix + joined;
    }
  }

  // Builds a quoted field's content over [start, end) character by character: the slow path, taken only
  // when the content holds a doubled quote or a CR. Counts lines as it goes.
  function buildQuotedContent(start, end) {
    let out = '';
    let i = start;
    while (i < end) {
      const c = text.charCodeAt(i);
      if (c === 34) {
        // "" inside the field is one quote
        out += '"';
        i += 2;
      } else if (c === 13) {
        // CRLF and a lone CR inside quotes are each one LF
        out += '\n';
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
      } else {
        if (c === 10) line += 1;
        out += text[i];
        i += 1;
      }
    }
    return out;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue and fEnded.
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    // Find the closing quote: the next quote that is not doubled.
    let i = open + 1;
    let hasEscape = false;
    let close = -1;
    while (i < len) {
      const j = text.indexOf('"', i);
      if (j === -1) break;
      if (text.charCodeAt(j + 1) === 34) {
        hasEscape = true;
        i = j + 2;
        continue;
      }
      close = j;
      break;
    }
    if (close === -1) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      scanUnquoted('"');
      return;
    }
    const cStart = open + 1;
    let value;
    const crAt = text.indexOf('\r', cStart);
    if (!hasEscape && (crAt === -1 || crAt >= close)) {
      // Clean content: one slice, and count its LFs.
      value = text.slice(cStart, close);
      let p = cStart;
      for (;;) {
        const q = text.indexOf('\n', p);
        if (q === -1 || q >= close) break;
        line += 1;
        p = q + 1;
      }
    } else {
      value = buildQuotedContent(cStart, close);
    }
    pos = close + 1;
    if (pos >= len) {
      fValue = value;
      fEnded = TEXT_END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value;
      fEnded = COMMA_END;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = BREAK_END;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = BREAK_END;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    scanUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
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
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) scanQuoted();
      else scanUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA_END);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

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
