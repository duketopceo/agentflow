// Schema support (R6): prompt-level instruction for harnesses without native
// structured output, plus a lenient extractor that handles raw, fenced, and
// embedded JSON.

export function schemaInstruction(schema) {
  return `Respond with only JSON matching this shape, no prose or fences: ${JSON.stringify(schema)}`;
}

function parseCandidate(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// Scan text for the first balanced JSON object or array starting at index i.
function balancedSlice(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Returns a parsed value or null. Order: whole text, fenced blocks,
// first balanced embedded JSON value.
export function extractJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;

  const whole = parseCandidate(text.trim());
  if (whole !== undefined) return whole;

  for (const m of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) {
    const v = parseCandidate(m[1].trim());
    if (v !== undefined) return v;
  }

  // Cap candidate positions — an unbalanced candidate scans to end-of-text,
  // so unbounded scanning is quadratic on degenerate transcripts.
  let tried = 0;
  for (let i = 0; i < text.length && tried < 64; i++) {
    if (text[i] === "{" || text[i] === "[") {
      tried++;
      const slice = balancedSlice(text, i);
      if (slice) {
        const v = parseCandidate(slice);
        if (v !== undefined) return v;
      }
    }
  }
  return null;
}
