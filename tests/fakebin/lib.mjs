// Shared plumbing for tests/fakebin/* stubs — each stub is a fake harness
// binary emitting the contract output its adapter parses. Env knobs mirror
// the echo adapter's AGENTFLOW_ECHO_* convention:
//   FAKEBIN_EXIT=<n>    exit n with a generic stderr line (failure classify)
//   FAKEBIN_DENY=1      permission-shaped stderr, exit 1 (permissionDenied)
//   FAKEBIN_SLEEP=<ms>  sleep before responding (timeout tests)
//   FAKEBIN_ARGV_FILE   append received argv to this file (wrap assertions —
//                       file-capture adapters like codex never see stdout)
import { writeFileSync, appendFileSync } from 'node:fs';

export async function main(argv, emit) {
  const sleep = Number(process.env.FAKEBIN_SLEEP ?? 0);
  if (sleep) await new Promise((r) => setTimeout(r, sleep));
  if (process.env.FAKEBIN_DENY) {
    process.stderr.write('Error: approval required to run exec\n');
    process.exit(1);
  }
  const forced = process.env.FAKEBIN_EXIT;
  if (forced !== undefined && forced !== '0') {
    process.stderr.write(`fakebin: forced exit ${forced}\n`);
    process.exit(Number(forced));
  }
  if (process.env.FAKEBIN_ARGV_FILE) {
    appendFileSync(process.env.FAKEBIN_ARGV_FILE, argv.join(' ') + '\n');
  }
  emit(argv);
}

// Prompt-level schema injection (withSchemaPrompt) and codex's native
// --output-schema both mean "answer with JSON" — a stub answers with a
// fenced object the adapter's extractJson recovers.
export function wantsSchema(argv) {
  return argv.join(' ').includes('JSON object matching this schema')
    || argv.includes('--output-schema');
}

export const FENCED = '```json\n{"ok":true}\n```';

// codex-style capture: write the final message to the file named by -o.
export function writeLastMessage(argv, content) {
  const i = argv.findIndex((a) => a === '-o' || a === '--output-last-message');
  if (i !== -1 && argv[i + 1]) writeFileSync(argv[i + 1], content);
}
