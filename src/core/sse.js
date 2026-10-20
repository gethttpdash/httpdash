'use strict';

/**
 * Server-Sent Events (text/event-stream) parsing, as the HTML spec describes it: "data" lines are
 * joined with newlines, "event" names the event (default "message"), "id" sets the last event ID,
 * "retry" the reconnection delay, and lines starting with ":" are comments. Lines may end in
 * \r\n, \n or \r, and may be split across network chunks.
 */

const isEventStream = (contentType) => /^\s*text\/event-stream\b/i.test(String(contentType || ''));

function createParser() {
  let buffer = '';
  let data = [];
  let event = '';
  let lastId = '';
  let retry = null;
  let comments = 0;

  const line = (text, out) => {
    if (text === '') {
      if (data.length) out.push({ event: event || 'message', data: data.join('\n'), id: lastId });
      data = [];
      event = '';
      return;
    }
    if (text[0] === ':') { comments++; return; }
    const i = text.indexOf(':');
    const field = i === -1 ? text : text.slice(0, i);
    let value = i === -1 ? '' : text.slice(i + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') { if (!value.includes('\0')) lastId = value; }
    else if (field === 'retry') { if (/^\d+$/.test(value)) retry = Number(value); }
  };

  return {
    /** Adds text from the stream; returns the events it completed. */
    push(text) {
      buffer += text;
      const out = [];
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const c = buffer[i];
        if (c !== '\n' && c !== '\r') continue;
        // A "\r" at the very end might be the first half of "\r\n"; wait for the next chunk.
        if (c === '\r' && i === buffer.length - 1) break;
        line(buffer.slice(start, i), out);
        if (c === '\r' && buffer[i + 1] === '\n') i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
      return out;
    },
    get lastEventId() { return lastId; },
    get retry() { return retry; },
    get comments() { return comments; },
  };
}

// All the events in a complete stream. An event without its closing blank line is incomplete
// and, as in browsers, not delivered.
function parseEventStream(text) {
  return createParser().push(String(text || ''));
}

module.exports = { createParser, parseEventStream, isEventStream };
