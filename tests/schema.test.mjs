import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJson, schemaInstruction } from "../src/schema.mjs";

test("extracts raw JSON object", () => {
  assert.deepEqual(extractJson('{"a": 1}'), { a: 1 });
});

test("extracts fenced JSON", () => {
  assert.deepEqual(extractJson('text\n```json\n{"a": 2}\n```\nmore'), { a: 2 });
});

test("extracts embedded JSON inside prose", () => {
  assert.deepEqual(extractJson('The answer is {"ok": true, "n": [1,2]} as shown.'), { ok: true, n: [1, 2] });
});

test("extracts top-level array", () => {
  assert.deepEqual(extractJson("[1, 2, 3]"), [1, 2, 3]);
});

test("handles braces inside strings", () => {
  assert.deepEqual(extractJson('{"s": "a {not} brace"}'), { s: "a {not} brace" });
});

test("returns null on empty/non-JSON text", () => {
  assert.equal(extractJson(""), null);
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson(null), null);
});

test("schemaInstruction embeds the schema", () => {
  const s = { type: "object", properties: { name: { type: "string" } } };
  const ins = schemaInstruction(s);
  assert.ok(ins.includes('"name"'));
});
