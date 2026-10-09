// Devin smoke: one trivial live call to verify the devin adapter end-to-end.
// Small model spend (~1 ACU-ish). Requires devin CLI on PATH.
//   bin/agentflow run examples/devin-smoke.mjs --harness devin --live

export const meta = {
  name: "devin-smoke",
  description: "Single live devin -p call to verify the adapter",
};

if (!live) {
  log("skipping live smoke — pass --live to spend ACUs");
  return { ok: true, skipped: true };
}

phase("smoke");
const r = await agent("Reply with exactly the word 'pong' and nothing else.", {
  label: "smoke:pong",
  timeout: 120_000,
});

if (!r) throw new Error("devin smoke failed — check doctor output and journal");
log(`devin replied: ${r.text.slice(0, 80)}`);
return { ok: true, reply: r.text };
