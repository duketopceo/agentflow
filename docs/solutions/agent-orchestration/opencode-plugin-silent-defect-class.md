---
title: "OpenCode plugin silent-defect class: wrong stream, wrong SDK, wrong runtime"
date: 2026-10-11
category: agent-orchestration
module: plugins/agentflow
problem_type: runtime_error
component: tooling
severity: high
resolution_type: code_fix
applies_when:
  - Writing or reviewing a plugin/SDK integration against an API version you cannot execute
  - Capturing a child process whose output stream contract you have assumed rather than measured
  - Building a test double for a process that writes to more than one stream
tags:
  - opencode-plugin
  - stdout-stderr
  - dual-sdk
  - node20
  - exports-map
  - mutation-testing
  - tool-result-contract
related_docs:
  - docs/plans/2026-10-11-003-feat-opencode-dual-version-plugin-plan.md
  - docs/solutions/agent-orchestration/via-wrap-contract.md
---

# OpenCode plugin silent-defect class: wrong stream, wrong SDK, wrong runtime

## Problem

The `agentflow` OpenCode plugin (`plugins/agentflow/`) shipped four defects that shared
one property: **none of them failed loudly at the point of the mistake.** Each produced a
plugin that loaded, registered tools, and returned successfully-shaped results while doing
the wrong thing. They arrived in sequence over a single day (commits `73302f0` → `c1c1fb0`
→ `0de396d` → `df5d369` → `8d9e138` → `d6b6169`), and each was only visible once the
previous one was fixed.

The class is what makes this worth writing down. Individually these are small mistakes —
read the wrong stream, import from the wrong package, point `exports` at `.ts`, write a stub
that only covers half the contract. Together they are a coherent failure mode: **every layer
of the plugin was written against a plausible model of the runtime rather than the runtime
itself**, and nothing in the test suite was capable of telling the difference.

The root cause in one line: the code used APIs that *imported* cleanly and *looked* correct,
without ever checking their behavior against the actual runtime shape.

Four sub-problems, in the order they were found.

### 1. stdout vs stderr — the capture was correct-shaped and semantically empty

The `agentflow run` subcommand writes **all** operator-relevant output to stderr: the
`[agentflow] run <run-id>` line, the `[t] [lane] -> ok` phase markers, and the script's own
`log()` output (which is how `workflows/deep-research.mjs` surfaces its synthesis). stdout is
empty. This is verified in `src/cli.mjs`:

```js
// src/cli.mjs:91  — the run-id, on stderr
if (runId) process.stderr.write(`[agentflow] run ${runId}\n`);
// src/cli.mjs:107 — doctor's probe rows, on stdout
process.stdout.write(`${mark} ${name.padEnd(9)} ${p.path ?? '(not found)'}\n`);
```

The shipped v1 plugin used Bun's tagged-template shell helper and read `.text()`, which
captures **stdout only**:

```ts
// BEFORE — .opencode/plugins/agentflow.ts (deleted in 73302f0)
import { tool } from "@opencode-ai/plugin";

export const agentflow = async ({ $, directory }) => {
  const run = (args) => $`agentflow ${args}`.cwd(directory).text();   // <-- stdout only
  return {
    tool: {
      agentflow_run: tool({
        /* ... */
        async execute(a) {
          const argv = ["run", a.script];
          if (a.harness) argv.push("--harness", a.harness);
          if (a.via) argv.push("--via", a.via);
          if (a.scriptArgs) argv.push("--", a.scriptArgs);
          return run(argv);          // <-- "" on every successful run
        },
      }),
      // ...
    },
  };
};
```

Net effect: `agentflow_run` returned `""` on **every successful run**. The agent got no
run-id, so it could not `agentflow status <id>` or `agentflow stop <id>` afterward — the
workflow completed invisibly. On failure the agent got only `ShellError: Failed with exit
code 1`, with the real reason discarded in stderr. And no test covered this file at all:
it was the only `.ts` file in a repo whose runtime is otherwise plain `.mjs`, and
`grep -rl plugin tests/` returned nothing.

The stream contract is asymmetric across subcommands, which is what made a single
"capture both" rule necessary rather than merely tidy:

| subcommand | stdout | stderr |
|---|---|---|
| `run` | *(empty)* | run-id, phase markers, lane results, script `log()` |
| `doctor` | probe rows | — |
| `status` / `list` | run/journal rows | — |

### 2. The two-SDK trap — "it imports" is not "it works"

This is the deepest lesson of the four, and the one most likely to recur.

OpenCode v1 and v2 ship as **two different npm packages with confusingly similar APIs**:

| | OpenCode **v1** | OpenCode **v2** |
|---|---|---|
| package | `@opencode-ai/plugin` | `@opencode/plugin` |
| plugin shape | calls `server()`, gets a hooks object | default-exports `Plugin.define({ id, setup })` |
| tool registration | `tool()` helper, **Zod** schemas | `ctx.tool.transform((editor) => editor.add(...))`, **JSON Schema** |
| tool return | `string` | `{ content }` |

The trap: **`@opencode-ai/plugin` (the v1 package) also ships a v2 surface**, at its
`/v2/promise` subpath, and it exports a `define` that looks *exactly* like v2's
`Plugin.define`:

```
node_modules/@opencode-ai/plugin/dist/v2/promise/index.d.ts
  export { define } from "./plugin.js";
  export type { PluginContext } from "./context.js";
```

So the obvious consolidation — "one SDK can serve both arms, so depend on one package" — is
tempting and wrong. Read the v1 package's v2 `PluginContext` and the `tool` domain is simply
absent:

```ts
// node_modules/@opencode-ai/plugin/dist/v2/promise/context.d.ts:11
export interface PluginContext {
    readonly options: PluginOptions;
    readonly agent: AgentHooks & Reload;
    readonly aisdk: AISDKHooks;
    readonly catalog: CatalogHooks & Reload;
    readonly command: CommandHooks & Reload;
    readonly integration: IntegrationHooks & Reload;
    readonly plugin: PluginDomain;
    readonly reference: ReferenceHooks & Reload;
    readonly skill: ReferenceHooks & Reload;
}
```

No `tool`. No `location`. The consolidation attempt (`c1c1fb0`) produced a module that
**imported fine, type-shaped fine, and looked correct on review** — and then died at load:

```
TypeError: Cannot read properties of undefined (reading 'transform')
    at setup (index.ts:...)   // ctx.tool.transform — ctx.tool is undefined
```

Because OpenCode `await`s `setup()` during plugin load, that throw did not disable one tool.
It killed the entire plugin. The identical name on the identical-looking `define` is what
made this possible: nothing in the import, the type, or the call signature distinguished the
two SDKs. Only the *runtime context object* differed.

**The meta-lesson:** when you depend on an SDK, verify its API against its actual runtime
shape, not against its exports map or its type signatures. "It imports" and "the types
check" are both necessary and both insufficient. The check that would have caught this is
trivial: read the `PluginContext` interface for the package you are actually importing, and
confirm the domain you call on it exists.

### 3. `.ts` broke the Node 20 CI leg

The split-entry fix (`0de396d`) shipped the entries as `v1.ts` / `v2.ts`, and pointed
`package.json` `exports` at them. Node **20 cannot import `.ts` at all** — type stripping
landed unflagged in Node **22.18+**, and on Node 20 the import throws:

```
ERR_UNKNOWN_FILE_EXTENSION
```

This is not a test-only problem. The `exports` map *is* the package's public API — so every
Node 20 consumer installing `agentflow` got an unloadable package, while `engines` claimed
`"node": ">=20.3"` in the same file that pointed `exports` at unimportable entries.

The first mitigation attempt (`df5d369`) was a test skip:

```js
// df5d369 — gate entry tests on the runtime's type-stripping capability
const canImportTs = typeof process.features?.typescript === 'string';
test('v1 entry: default export exposes the server() plugin function',
     { skip: !canImportTs }, async () => { /* ... */ });
```

That made CI green by **not running the plugin's own tests on the oldest supported runtime** —
which converts a loud failure into a silent one. It was the wrong fix and it was reverted in
the same session.

### 4. The test suite had false confidence, proven by mutation

After fixes 1–3 landed, four mutations were deliberately applied to the plugin and the suite
re-run. **Two survived.** The suite was green against code that was demonstrably broken:

- **Mutation A — discard stdout.** Change `runAgentflow`'s `const combined = \`${stdout}${stderr}\``
  to `` `${stderr}` ``. The old `tests/fakebin/agentflow` stub wrote *everything* to stderr,
  so a capture that threw stdout away was indistinguishable from a correct one. **Survived.**
- **Mutation B — `agentflow_doctor.execute` returns `""`.** Every test asserted on
  `agentflow_run` or on `runAgentflow` directly. Nothing ever invoked `doctor` *through an
  arm*. **Survived.**

A suite that survives a mutation of the exact defect it was written to catch is not
measuring that defect.

## Symptoms

- `agentflow_run` returned `""` on every successful run — no run-id, so the calling agent
  could not `status`, `resume`, or `stop` the run afterward.
- A failed run surfaced as `ShellError: Failed with exit code 1`, discarding the actual
  reason the runner had already written to stderr.
- The v2 arm threw `Cannot read properties of undefined (reading 'transform')` inside
  `setup()`; since `setup` is awaited at load, this killed the entire plugin rather than
  degrading one tool.
- The Node 20 CI leg failed with `ERR_UNKNOWN_FILE_EXTENSION` on `import '../plugins/agentflow/v1.ts'`,
  while the package `exports` map pointed every Node 20 consumer at the same unloadable files.
- Two of four deliberate mutations passed a green suite — the tests could not detect the
  class of defect they existed to detect.
- Failure modes collapsed: a missing binary, a timeout, and a truncated-output overflow all
  presented identically as `agentflow exited 1`.

## What Didn't Work

**Consolidating both arms on one SDK** (`c1c1fb0`). The premise was reasonable — depending on
two packages makes the module unloadable whenever either is missing, so the v1 package's
`/v2/promise` `define` looked like a way to get both APIs from one dependency. It was wrong
because the two `PluginContext` shapes are incompatible, and the v1 package's v2 context has
no `tool` domain. The consolidation "worked" in the sense that it imported; it failed at the
first `setup()` call.

**Writing the dual arm from the migration guide without exercising it.** The OpenCode v2
migration guide documents exactly the shape this codebase needed ("Support V1 and V2 from one
package" — one default export spreading `Plugin.define(...)` alongside a `server()` function).
Following it faithfully produced a package that could not load. The guide's shape is
structurally correct; nothing in it can tell you that two SDKs behind one name have different
runtime contexts.

**Skipping the entry tests on Node 20** (`df5d369`). The intent was to stop CI from failing
on a runtime that can't parse the source. The effect was to stop testing the plugin on the
oldest runtime it claims to support. A skip is not a fix; it is a suppressed failure.

**A stub that only covers one half of the contract.** The first `tests/fakebin/agentflow`
wrote every line to stderr. That was a faithful stub for `run` — and it made the `stdout`
half of the capture untestable, because the second correct-but-unverified stream had no
exerciser. A stub that is wrong in the direction of the thing under test removes the test.

**Naming spawn failures generically.** Returning `agentflow exited 1` for every nonzero exit
isn't wrong for the runner's own exit code, but it is wrong for `ENOENT`, `ETIMEDOUT`, and
max-buffer overflow — three failure modes whose real causes point an agent in completely
different directions (install the binary vs. increase the timeout vs. read the journal).

## Solution

### 1. One shared capture path for both arms, reading both streams

`plugins/agentflow/args.mjs` became the single place any child process is spawned, and it
concatenates both streams unconditionally:

```js
// AFTER — plugins/agentflow/args.mjs:65
export function runAgentflow(argv, { cwd, timeoutMs = 30 * 60_000, bin = 'agentflow' } = {}) {
  return new Promise((resolve) => {
    execFile(bin, argv, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const combined = `${stdout}${stderr}`;                       // <-- both, always
      if (!err) return resolve({ code: 0, out: combined || 'agentflow produced no output' });

      // Non-runner failure modes are NAMED, not collapsed into "exited 1".
      if (err.code === 'ENOENT') {
        return resolve({ code: 127, out: SPAWN_FAILURE.ENOENT });
      }
      if (err.killed) {
        return resolve({ code: 124, out:
          `${combined}\nagentflow timed out after ${Math.round(timeoutMs / 60000)}m and was terminated` });
      }
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return resolve({ code: 1, out:
          `${combined}\nagentflow output exceeded 8MB and was truncated — full journal in .agentflow/runs/` });
      }
      const code = typeof err.code === 'number' ? err.code : 1;
      resolve({ code, out: combined || `agentflow exited ${code}` });
    });
  });
}
```

Neither arm is allowed to shell out on its own. Both call this. That is the anti-drift
property: a future edit that reintroduces a stdout-only read would have to bypass the one
function in the package that already handles it.

Note the fallbacks are load-bearing too. `out: combined || 'agentflow produced no output'`
means a genuinely silent success still returns a truthy string, so no caller can
distinguish "empty output" from "capture broken" by looking alone.

### 2. Two entrypoints, each importing exactly one SDK

```js
// plugins/agentflow/v1.mjs — v1 SDK ONLY
import { tool } from "@opencode-ai/plugin";
import { RUN_DESCRIPTION, /* ... */ runAgentflow, toolOutcome } from "./args.mjs";

export default {
  async server({ directory }) {
    const cwd = directory;
    return {
      tool: {
        agentflow_run: tool({
          description: RUN_DESCRIPTION,
          args: {
            script: tool.schema.string().describe(SCRIPT_DESCRIPTION),
            harness: tool.schema.string().optional().describe(HARNESS_DESCRIPTION),
            /* ... */
          },
          async execute(args) {
            const r = await runAgentflow(buildRunArgs(args), { cwd });
            return toolOutcome(r).content;         // v1 returns a bare string
          },
        }),
        agentflow_doctor: tool({ /* ... */ }),
      },
    };
  },
};
```

```js
// plugins/agentflow/v2.mjs — v2 SDK ONLY
import { Plugin } from "@opencode/plugin";
import { RUN_DESCRIPTION, /* ... */ runAgentflow, toolOutcome } from "./args.mjs";

export default Plugin.define({
  id: "agentflow",
  async setup(ctx) {
    // Fail soft, but loudly enough to diagnose.
    if (!ctx?.tool?.transform) {
      console.error("[agentflow] v2 plugin context has no tool domain — tools not registered");
      return;
    }
    const cwd = ctx.location.directory;
    const registration = await ctx.tool.transform((editor) => {
      editor.add({
        name: "agentflow_run",
        description: RUN_DESCRIPTION,
        input: { type: "object", properties: { /* ... */ }, required: ["script"],
                 additionalProperties: false },
        async execute(input) {
          const r = await runAgentflow(buildRunArgs(input), { cwd });
          return toolOutcome(r);                   // v2 returns { content }
        },
      });
      // ...
    });
    return () => registration.dispose();           // reload disposes instead of stacking
  },
});
```

`plugins/agentflow/package.json` and the root manifest wire them so one install serves either
host, and each subpath resolves to an entry that imports only its own SDK:

```json
"exports": {
  ".":      "./plugins/agentflow/v2.mjs",
  "./server": "./plugins/agentflow/v1.mjs",
  "./v1":   "./plugins/agentflow/v1.mjs",
  "./v2":   "./plugins/agentflow/v2.mjs"
}
```

`@opencode/plugin` (v2) sits in `devDependencies` so an installer who only needs v1 does not
pull the v2 SDK's ~270 transitive packages. It remains a `peerDependency` of the plugin
subpackage.

### 3. Plain `.mjs` entries, and an honest `engines` floor

```json
"exports": {
  ".": "./plugins/agentflow/v2.mjs",
  "./server": "./plugins/agentflow/v1.mjs"
},
"engines": { "node": ">=20.3" }
```

The `df5d369` test-skip was reverted — the entry tests now run on **every** CI leg
(20/22/24/26), and the whole matrix is green because the code is loadable on all of them,
not because the tests stopped running on one. `args.mjs` was already `.mjs`; the entries
joined it.

### 4. Failure must throw, because there is no error channel in a tool result

This one is easy to get backwards. A tool's return value is what the host records. Neither
SDK gives you an error field inside a tool result — so **returning your error text returns a
success**:

```js
// plugins/agentflow/args.mjs:87 — shared by both arms
export function toolOutcome(r) {
  if (r.code !== 0) throw new Error(r.out);
  return { content: r.out };
}
```

The v1 arm unwraps `.content` (v1 tools return a bare string); v2 returns the object. Both
derive failure from the same function, so neither arm can drift into reporting a failed run
as a successful one.

### 5. A stub that mirrors the real per-subcommand stream contract

```js
// AFTER — tests/fakebin/agentflow
if (argv[0] === 'doctor') {
  process.stdout.write('ok      echo   (test adapter)\n');   // doctor -> stdout
} else {
  process.stderr.write('[0.0s] [p] a -> ok (0.0s)\n');        // run    -> stderr
  process.stderr.write('[0.0s] [p] RESULT: {"text":"PONG"}\n');
  process.stderr.write('[agentflow] run fake-run-0001\n');
}
```

Both halves are now exercised. The `run` half pins the original regression; the `doctor`
half makes stdout capture testable, which is what killed Mutation A.

### 6. Tests drive the tools, not just the helper

The tests that caught the surviving mutations all go *through an arm*:

```js
// tests/opencode-plugin.test.mjs:64 — the stderr-only regression, pinned
test('runAgentflow: a stderr-only run still yields non-empty output containing the run-id', async () => {
  const { code, out } = await withFakebin(() =>
    runAgentflow(buildRunArgs({ script: 'w.mjs' }), { cwd: tmpdir(), bin: 'agentflow' }));
  assert.equal(code, 0);
  assert.ok(out.length > 0, 'capture must not be empty for a successful run');
  assert.match(out, /\[agentflow\] run fake-run-0001/, 'run-id must survive the capture');
});

// tests/opencode-plugin.test.mjs:122 — the stdout half, which the old stub could not see
test('runAgentflow: stdout-only output is captured, not discarded', async () => {
  const { code, out } = await withFakebin(() =>
    runAgentflow(buildDoctorArgs(), { cwd: tmpdir(), bin: 'agentflow' }));
  assert.equal(code, 0);
  assert.match(out, /test adapter/, 'doctor writes to stdout; that half must be captured too');
});

// tests/opencode-plugin.test.mjs:202 — doctor driven THROUGH the v1 arm (Mutation B)
test('v1 arm: agentflow_doctor.execute returns the probe output', async () => {
  const mod = await import('../plugins/agentflow/v1.mjs');
  const hooks = await withFakebin(() => mod.default.server({ directory: tmpdir() }));
  const out = await withFakebin(() => hooks.tool.agentflow_doctor.execute({}));
  assert.ok(out && out.length > 0, 'doctor tool must return real probe output, not ""');
  assert.match(out, /test adapter/);
});

// tests/opencode-plugin.test.mjs:210 — failure semantics through the arm
test('v1 arm: a failed run throws rather than returning failure text as success', async () => {
  const mod = await import('../plugins/agentflow/v1.mjs');
  const hooks = await withFakebin(() => mod.default.server({ directory: tmpdir() }));
  await assert.rejects(
    () => withFakebin(() => hooks.tool.agentflow_run.execute({ script: 'w.mjs' }),
                      { AGENTFLOW_FAKE_EXIT: '2' }),
    /script failed with reason FAKED/,
  );
});
```

And the anti-drift check — the property `args.mjs` exists for, asserted rather than assumed:

```js
// tests/opencode-plugin.test.mjs:250
test('both arms expose the same two tools with the same descriptions', async () => {
  const v1 = await import('../plugins/agentflow/v1.mjs');
  const v2 = await import('../plugins/agentflow/v2.mjs');
  const v1hooks = await withFakebin(() => v1.default.server({ directory: tmpdir() }));
  const added = [];
  await withFakebin(() => v2.default.setup({
    location: { directory: tmpdir() },
    tool: { transform: async (cb) => {
      cb({ add: (t) => added.push(t) }); return { dispose: async () => {} };
    }},
  }));
  const names = (obj) => Object.keys(obj).sort();
  assert.deepEqual(names(v1hooks.tool), added.map((t) => t.name).sort());
  const RUN = 'Run an agentflow dynamic-workflow script';
  assert.ok(v1hooks.tool.agentflow_run.description.startsWith(RUN), 'v1 run description');
  assert.ok(added.find((t) => t.name === 'agentflow_run').description.startsWith(RUN), 'v2 run description');
});
```

Plus a regression guard for the exact load-time crash:

```js
// tests/opencode-plugin.test.mjs:172
test('v2 entry: setup() degrades quietly when the context has no tool domain', async () => {
  // An earlier draft called ctx.tool.transform unguarded and threw
  // `Cannot read properties of undefined` — and because setup is awaited
  // at load, that kills the plugin instead of degrading it.
  const mod = await import('../plugins/agentflow/v2.mjs');
  const ctx = { location: { directory: tmpdir() } };
  await assert.doesNotReject(() => mod.default.setup(ctx));
});
```

### 7. Docs corrected to commands that exist

`opencode plugin add <module>` is not a real verb — `add` parses as the module name and the
command fails. The install table now shows only `opencode plugin <module>`, names the `.mjs`
entries, and states the v2 arm's coverage accurately (a `ToolDomain` stub, not a live host,
since no v2 CLI is published — `opencode-ai` tops out at `1.19.0`).

## Why This Works

**Combining the streams removes a category instead of fixing an instance.** There is no
longer a code path in the plugin that can read only stdout, because no code path spawns a
process at all — there is exactly one, and it reads both. The defect became unrepresentable
rather than merely fixed.

**Two entrypoints make the SDK boundary explicit.** After the split, the v2 surface
(`ctx.tool.transform`) exists only in a module that imports only `@opencode/plugin`, and only
the v1 surface exists in the module that imports only `@opencode-ai/plugin`. Each file is
loadable only by the host it was written for, so the "which context do I actually have"
question — the question that caused the load-time crash — cannot be answered wrongly at
import time. A single module importing both SDKs cannot have this property.

**The fail-soft guard converts a fatal class into a diagnosable one.** `if (!ctx?.tool?.transform)`
means a mismatched host now produces one clear stderr line and *no tools*, rather than a
throw inside an awaited `setup()` that takes down the entire plugin — including any future
tools added to this file by anyone else.

**The stub mirrors reality in both directions.** The original defect survived because the
stub was faithful only to the subcommand the assertion used. Splitting the stub by
subcommand — `run` to stderr, `doctor` to stdout — means a regression in *either* stream is
visible to *some* test.

**Driving the tools through an arm tests the seam, not the helper.** `runAgentflow` can be
perfect while `agentflow_doctor.execute` returns `""`, or while an arm swallows a failed run
and reports success. Those are the two mutations that survived; both are now covered by
tests that call `execute` the way the host calls it.

**Mutation testing converted "tests pass" into "tests measure something."** This is the
change with the highest leverage and the lowest cost. Green tests had been treated as
evidence of coverage; four deliberate breaks showed they were evidence of nothing. All four
are now caught (verified by re-applying each and observing the failure):

| Mutation | Before | After |
|---|---|---|
| `combined = \`${stderr}\`` (discard stdout) | **survived** | 3 tests fail |
| `agentflow_doctor.execute` returns `""` (v1) | **survived** | 1 test fails |
| `toolOutcome` returns `{content}` instead of throwing | 2 tests fail | 2 tests fail |
| v1 arm given its own divergent description | — | 1 test fails |

**Failures are typed.** `ENOENT` → 127 with a PATH hint; timeout → 124 with the elapsed
budget; maxBuffer overflow → an explicit truncation note pointing at the journal; anything
else → the runner's own exit code with its stderr reason attached. Each of those four causes
points a debugging agent somewhere different, and `agentflow exited 1` points it nowhere.

**A failed run throws.** Without this, a nonzero exit whose reason text was returned as a
string would be recorded by the host as a successful tool call. The calling agent would carry
on as if the workflow had completed. Throwing is the only available failure channel, which
is exactly why it has to be a deliberate decision rather than a stylistic one.

## Prevention

**Verify an SDK's API against its runtime shape before you build on it.** When a dependency
exposes a domain or method, confirm the object you will actually be handed contains it —
read the `PluginContext` interface for the package you are importing, not the one whose
`define` has the signature you want. Signatures and exports maps do not encode context
identity; two unrelated packages can export an identically-named function that receives
incompatible arguments. Write the ten-line context stub and run `setup()` against it before
writing any real logic.

**Audit every subprocess boundary for its stream contract.** Record which stream each
subcommand writes to (`src/cli.mjs` is the authority for `agentflow`), and capture both in
any consumer. The asymmetry — `run` on stderr, `doctor` on stdout — is the kind of fact that
is true, verifiable in ten seconds, and permanent if you don't write it down.

**Stubs must cover every channel the production code reads.** A stub written to one stream
makes the other stream untestable, and the untestable stream is where the bug lives. Model
the stub's behavior on the real binary's *diversity*, not just its shape: if the real thing
writes to two streams, so must the stub, split the way the real thing splits them.

**Run mutation testing on every test suite that claims to guard a regression.** Pick two or
three deliberate breaks — discard one output stream, make one function return a constant,
delete one argument — apply them, and confirm red. A suite that survives a mutation of the
exact defect it was written for is decoration. This takes minutes and it found two real
holes in a suite that had been passing for days.

**Never make a failing runtime leg green by skipping tests on it.** `{ skip: ... }` is a
suppressed failure with a friendly name. If a runtime cannot load the code, either the code
is wrong for that runtime or the declared support floor is — fix the code or fix the floor
(`engines`), never the test count. A CI matrix exists precisely to tell you when your floor
is a lie.

**Give every child-process call one home, and name its non-runner failures.** Route all
spawns through a single helper that concatenates both streams, maps spawn-level errors to
distinct exit codes, and returns a non-empty string on every path. Distinguishing "the binary
is missing" from "the script failed" from "it timed out" costs six lines and saves a
debugging session every time.

**Push shared strings into shared constants.** `RUN_DESCRIPTION` and friends live in
`args.mjs`, and a test asserts both arms expose identical tool names and descriptions. When
two surfaces must agree, the agreement should be a test assertion, not a review-time
intuition — duplicated prose is exactly how two surfaces drifted the first time.

**Know what your host does with a returned value.** Before returning diagnostics, confirm
whether the framework records your return as success. In both OpenCode SDKs it does. If
there is no error channel inside a tool result, then `throw` is the error channel, and
returning your failure text is a lie told to the agent reading your output.

---

## The plan's central decision was falsified mid-implementation

Worth recording separately, because the plan document
(`docs/plans/2026-10-11-003-feat-opencode-dual-version-plugin-plan.md`) is the repo's
design record and now misstates the shipped design.

Its **KTD1** prescribed *"one default export spreading `Plugin.define({id, setup})` for v2
alongside a v1 plugin function"* — the dual-module shape the OpenCode v2 migration guide
documents. That shape is real and documented. It does not work for agentflow, because the
two SDKs are not compatible within one module:

| | `@opencode-ai/plugin` (v1 pkg) | `@opencode/plugin` (v2 pkg) |
|---|---|---|
| v1 `tool()` Zod helper | yes | no |
| v2 `Plugin.define` | **yes** (`/v2/promise`) | yes |
| v2 `ctx.tool` domain | **no** | yes |

The v1 package ships a v2-shaped `define` that imports cleanly and type-checks, so the
dual-module version *looked* correct and passed review — until `setup()` ran and threw
`Cannot read properties of undefined (reading 'transform')`. Because `setup` is awaited at
load, that kills the entire plugin rather than degrading it.

Shipped instead: two entrypoints, each importing only the SDK it needs, wired through
`exports` (`"." → v2.mjs`, `"./server" → v1.mjs`, plus explicit `./v1` and `./v2`).

**A documented pattern is not a verified one.** The guide's dual-export shape is correct for
plugins that only need one SDK's tools. It does not survive two SDKs whose contexts differ.

## Related

- `docs/plans/2026-10-11-003-feat-opencode-dual-version-plugin-plan.md` — the design record
  for this work. Correct on the stream contract and the test-first posture; its KTD1
  packaging decision and its assumption that a `.ts` entry was loadable were both falsified
  during implementation.
- `docs/solutions/agent-orchestration/via-wrap-contract.md` — the same failure class in the
  same repo: a contract violation that shipped green and was caught only by a live smoke
  matrix. Its "argv-level tests can't see into a custom spawnAgent" note is the ancestor of
  the mutation-testing guidance above.
- `docs/plans/2026-10-10-001-feat-deterministic-suite-ci-plan.md` (M5) — introduced
  `tests/fakebin/`, the deterministic net this lesson then had to be extended to cover.
