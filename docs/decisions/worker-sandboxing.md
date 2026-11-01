# Decision: worker sandboxing

**Status:** decided · **Date:** 2026-11-01 · **Plan:** `docs/plans/2026-10-19-003-eval-worker-sandboxing-plan.md`

## TL;DR

**Adopt `@anthropic-ai/sandbox-runtime` (`srt`) as the worker boundary now; defer OpenShell; keep smokescreen in reserve for shared/per-client egress policy.** All three candidates were verified on this box (aarch64, Asahi kernel 7.2.x); the choice is driven by weight and threat model, not feasibility.

## Threat model — what this defends against

Answer to the plan's framing question: **both, weighted toward (a).**

- **(a) Buggy/hallucinated destructive commands** — the common case. Covered by `srt`'s filesystem boundary (verified: writes outside `allowWrite` fail EROFS).
- **(b) Prompt-injected workers doing exfiltration** — partially covered today by `srt`'s network allowlist (verified: non-allowlisted domains blocked at the proxy with `X-Proxy-Error: blocked-by-allowlist`). Full (b) coverage — blocking IP-literal exfil, per-worker egress identity, SSRF-grade range rules — is smokescreen's territory and is deferred below.
- **Credentials** — `srt` does not address ambient credential visibility (agents still see real tokens). That stays at the MCP/oauth-broker layer; see *Layer ownership*.

## Evaluation evidence (aarch64 / Asahi, `omarchy-max`, 2026-11-01)

### sandbox-runtime (`@anthropic-ai/sandbox-runtime@0.0.81`, `srt` CLI)

- **Install:** `npm install` clean; Linux deps `bwrap` + `socat` already present on the host.
- **Inside-boundary normal op:** `srt -c 'echo hello > work/out.txt && node -e …'` → wrote file, ran node (`arm64`), exit 0. No functionality loss.
- **Denied write:** `echo x > outside/esc.txt` → `Read-only file system`, `WRITE_RC=1`. Enforced via bubblewrap mount namespace.
- **Denied egress:** `curl https://evil.example/` → `X-Proxy-Error: blocked-by-allowlist`, `CURL_RC=7`. Network namespace removed entirely; traffic routes through unix-socket proxies on the host.
- **Allowed egress:** `curl https://example.com/` (allowlisted) → `200`.
- **Overhead:** ~120–230 ms per spawn (bwrap setup + proxy spawn), near-zero steady-state CPU delta (`user 0.354s` sandboxed vs `0.370s` bare for identical workload). For workers that run minutes, overhead is far under the 10% gate; for per-command wrapping it is a fixed ~0.1–0.2 s tax.

### OpenShell (NVIDIA, v0.1.6 docs + host prerequisites)

- **Support matrix:** aarch64 Linux is *listed supported* — static-musl CLI, `linux/arm64` images for both cluster and gateway containers.
- **Host prereqs verified:** Docker Engine 29.9.2 (needs ≥28.0) ✓; `CONFIG_SECURITY_LANDLOCK=y` and `landlock` in `/sys/kernel/security/lsm` ✓; seccomp standard ✓. Podman absent (docker driver would be used).
- **Not installed.** The gate passes on paper, but even the minimal path is a systemd-user gateway service + control plane + per-sandbox containers — disproportionate to the current need. Telemetry is anonymous-on with env opt-out.
- **Distinctive value** (credential injection at the gateway, seccomp+Landlock syscall layer, declarative policy with formal diff-proving) doesn't match today's primary threat (a).

### smokescreen (stripe, v0.1.0)

- **Build:** `go install github.com/stripe/smokescreen@latest` → clean aarch64 binary, `smokescreen --help` works.
- **Live ACL test:** ran on `127.0.0.1:4750` with a `default` service ACL (`allowed_domains: [example.com]`, `allow_missing_role`):
  - `http://example.com/` via proxy → `200` ✓
  - `http://evil.example/` → `407` deny ✓
  - `http://169.254.169.254/` (metadata IP) → `407` deny ✓ — the SSRF-grade IP blocking `srt`'s domain allowlist doesn't do.
- **Caveats found:** role extraction defaults to TLS client-cert CN — per-client ACLs mean running mTLS, which is real machinery for a local tool. `allow_missing_role` + a `default:` ACL block is the low-effort mode.

## Comparison matrix

| | sandbox-runtime | OpenShell | smokescreen |
|---|---|---|---|
| aarch64 verified | **yes, live** (fs+net denies enforced) | docs-supported + host prereqs verified; not installed | **yes, live** (allow/deny/SSRF blocks) |
| Boundary | userspace: bwrap fs + proxy net | kernel: Landlock+seccomp + gateway | egress-only CONNECT proxy |
| Weight | wrap a command (`srt -c`) | control plane (gateway svc + containers) | one Go binary + ACL file |
| Credentials | ambient | injected at gateway | doesn't see creds |
| IP-literal/SSRF blocking | no (domains only) | yes (policy) | **yes (verified)** |
| Per-client egress identity | no | yes | yes, via mTLS CN (heavier) |
| Telemetry | none | anonymous, opt-out env | none |
| Overhead measured | ~0.12–0.23 s/spawn, ~0% CPU | — | proxy hop only |

## Decision

1. **Now — sandbox-runtime wraps worker spawns.** Wrap point: `applyVia()` in `src/adapters/base.mjs` — the same mechanism that already prefixes `ori`; `srt --settings <file>` becomes a composable `via` prefix. Per-worktree `allowWrite` (the spawn `cwd` is already the worker's isolated worktree — `src/runtime.mjs` creates one per task) plus a workflow-declared `allowedDomains` list. This lands as follow-on implementation work; the decision is which boundary, not the patch.
2. **Deferred — smokescreen**, for when we need what `srt`'s net layer lacks: IP-literal/CIDR egress rules, a single shared ACL file across N concurrent workers, or per-worker egress identity. Trigger: first workflow whose workers talk to a dynamic set of hosts, or first exfiltration-oriented eval finding.
3. **Deferred — OpenShell**, revisited when workers must hold real credentials (its gateway injection removes ambient tokens entirely) or when a fleet/control-plane need exists. Re-check then on aarch64 + docker-driver status.

## Layer ownership (vs. ContextForge / mcp-oauth-broker)

- **fs + process egress:** `srt` at the adapter spawn layer.
- **MCP credential brokering:** the oauth-broker/ContextForge plan owns raw-token custody for MCP tools. `srt` narrows *where* a stolen token can be *sent* (allowlist); the broker narrows whether the worker *has* it. Complementary, not overlapping.
- **OpenShell's credential injection** would partially subsume the broker's job — if it ever lands, the decision doc for that migration must say which layer owns token custody.

## Honest limitations

- **This protects agent-spawned processes, not the user.** Anything a user runs outside the boundary is unrestricted — by design.
- `srt` userspace boundary ≠ kernel LSM: a worker that can `bwrap`/unshare creatively or exploit a setuid path is out of scope; that's OpenShell's seccomp layer, deferred with it.
- `srt` network filtering is domain-based; `curl 1.2.3.4` to an exfil IP bypasses the domain allowlist unless proxies reject literals — noted as a smokescreen trigger, not silently ignored.
- OpenShell aarch64 support is docs-verified, not boot-verified; a future re-evaluation should smoke `openshell` on this box before committing.

## References

- Plan: `docs/plans/2026-10-19-003-eval-worker-sandboxing-plan.md`
- Wrap point: `src/adapters/base.mjs` (`applyVia`), `src/runtime.mjs` (per-task worktree creation)
- OpenShell support matrix: <https://docs.nvidia.com/openshell/reference/support-matrix>
