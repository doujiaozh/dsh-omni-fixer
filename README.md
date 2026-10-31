# Omni-Fixer · God-tier Universal Error Repair Pipeline

> Works with **any model** (weak or strong) and **any codebase size**
> (up to 100k-line legacy mountains), even on a **Win7 / 8GB RAM** host.

The thesis: weak models fail on big projects not because they are dumb, but
because **the context is noisy and localization is wrong**. Omni-Fixer uses
«extreme slicing (Error Fix Contract) + physical sandbox verification +
weak/strong model hybrid routing» to compress any error into an isolated task
where the model only has to look at 50 lines:

**The model never has to understand the whole codebase — it just has to fix
the one error in front of it.**

---

## 1. Architecture: weak/strong models cooperate

```mermaid
flowchart TD
    subgraph SCAN["omni_scan · full error sniffing"]
        A[walkSourceTree] --> B{language routing}
        B -->|JS/TS/JSX/TSX/MJS/CJS| C[zero-dependency AST lexer<br/>bracket balance / unterminated strings / full-width chars]
        B -->|Python| D[mini-Python lexer<br/>indent / missing colon / brackets / triple quotes]
        C --> E[diagnostics]
        D --> E
        A --> F[toolchain authority scan<br/>tsc / vitest / node --test / pytest]
        F --> E
        A --> G[per-file fallback<br/>node --check / py_compile batch]
        G --> E
    end

    subgraph ISOLATE["omni_isolate · surgical isolation"]
        E --> H[group by file + proximity clustering]
        H --> I["Error Fix Contract<br/>50-line window + hard rules + verify spec"]
        I --> J{complexity}
        J -->|syntax only| K[trivial]
        J -->|logic/type| L[moderate]
        J -->|test failure| M[hard]
    end

    subgraph HEAL["omni_heal · adaptive model routing"]
        J --> N{rule engine can fix?}
        N -->|yes| O["deterministic rule engine<br/>full-width→ASCII / closers / colons<br/>0 tokens · seconds]
        N -->|no| P{complexity}
        P -->|trivial| Q[weak model<br/>e.g. Atria-Dawn]
        P -->|moderate/hard| R[strong model<br/>e.g. deepseek-v4.1]
        R --> S[local failing-test output forced into prompt]
    end

    subgraph VERIFY["omni_verify · physical sandbox gate"]
        O --> T[sandbox / inplace verification]
        Q --> T
        R --> T
        T -->|"tsc --noEmit / node --check /<br/>py_compile / vitest / pytest"| U{green?}
        U -->|yes| V[atomic write-back<br/>temp file + rename]
        U -->|no| W[feed new error back to omni_heal<br/>channel escalation · max 3 rounds]
        W --> O
        W --> Q
        W --> R
    end

    V --> X["omni_reporter · battle report<br/>lines scanned / errors found / fixed / tokens / per-model record"]
    W -.all rounds failed.-> Y[nothing changed · source byte-level safe]
```

Plain-text version:

```
legacy codebase
  |
  v
omni_scan        fast AST scan (0 deps) --+-- toolchain scan (tsc/vitest/pytest/node --test)
                                        `-- per-file fallback (node --check / py_compile)
  |  diagnostics (only severity=error enter the pipeline)
  v
omni_isolate     group by file -> proximity cluster -> Error Fix Contract
                 each contract = 50-line window + hard rules + verify spec + complexity
  |
  v
omni_heal        rule engine can fix? --yes-> deterministic quick fix (0 tokens)
                     |no
                     |-- trivial    -> weak model (Atria-Dawn)
                     `-- moderate/hard -> strong model (deepseek-v4.1, with failing test output)
  |  patch (NEVER written to source directly)
  v
omni_verify      physical sandbox: single-file verifiers run in a temp dir;
                 project verifiers mirror the tree (junctions)
                 tsc --noEmit / node --check / py_compile / vitest / pytest
       |----- green -----|          |----- red -----|
       v                 |          |               v
   atomic write-back     |      retry with new error (channel escalation, max 3 rounds)
       v                 |               v
omni_reporter  report    `-- all failed --> nothing changed (source byte-level safe)
```

---

## 2. Why this beats the classic approach

| Classic pain | Omni-Fixer answer |
|---|---|
| Stuff the whole file/project into the context | **Error Fix Contract**: 50-line window + one explicit error |
| Weak model wastes strong-model tokens on syntax errors | **Adaptive routing**: rule engine -> weak model -> strong model |
| Model output overwrites source; hallucinations ship | **Physical sandbox gate**: the patch must actually pass a real toolchain first |
| One failure = give up | **Evidence-driven retry**: new error output goes back to the model, channel escalates |
| Black-box fixing | **Battle report**: per-model calls, tokens, and wins recorded |

The verify gate is the key line of defense: **model (and rule-engine) output
never touches source files directly.** Every patch runs inside a sandbox with
real toolchains first; only `exitCode === 0` triggers an atomic write-back
(write `.{path}.~omni-fix` then `rename` — no half-written files even on power
loss). When every round fails, the source file is **byte-for-byte unchanged**.

---

## 3. Taking down a 100k-line legacy codebase on low-spec Win7

Host: Windows 7 + 8GB RAM, no compiler toolchain, no native modules allowed.
Omni-Fixer is engineered exactly against that red line:

- **Pure Node.js + TypeScript**, zero native dependencies. Nothing to compile.
- **Zero-dependency scanners**: the JS/TS-family and Python lexers are
  hand-written, so no `typescript` / `@babel/parser` AST giants are loaded to
  scan a tree — a 100k-line project is scanned in seconds with linear memory.
- **Toolchain calls invoke real executables directly**: `argv` carries absolute
  `node.exe` / `python.exe` paths, never going through `cmd.exe` to interpret
  `.cmd` shims (a legendary footgun on Win7).
- **Sandbox mirrors use junctions, not copies**: for project-wide verifiers
  (vitest/pytest/tsc), big directories like `node_modules` are NTFS junctions
  into the real tree — native to Win7, no elevation, zero copy cost. Mirroring
  a huge `node_modules` cannot OOM an 8GB box.
- **tsc verifies in place**: under the `auto` strategy tsc uses backup ->
  write candidate -> verify -> unconditional restore, because tsc depends on
  `tsbuildinfo` incremental caches and a cold sandbox would force a full
  rebuild of a big project on every attempt.
- **The Node >=20 test-runner trap is handled**: spawned toolchain processes
  scrub `NODE_TEST_CONTEXT`, otherwise the child `node --test` thinks it is a
  recursive `run()` call, silently skips all tests, exits 0, and emits
  nothing — a trap that masquerades as "all green".

### Workflow example (100k-line Node project)

```bash
# 1) Dry-run first to size up the damage (no source file is touched).
#    In a DSH session:
#    omni_fix { "root": "D:/Code/that-codebase", "dryRun": true }

# 2) Read the battle report: how many errors, how many trivial
#    (rule-engine fixable), how many need a model.
#    Located at <root>/.omni-fix-report/latest.md

# 3) Without any LLM credentials you can still clear the low-hanging fruit:
#    full-width punctuation, unclosed brackets, missing colons are fixed by
#    the rule engine in seconds with zero tokens — and still verified in the
#    physical sandbox.
#    omni_fix { "root": "D:/Code/that-codebase", "maxRetries": 1 }

# 4) Configure models for the full automatic run (weak handles trivial,
#    strong handles moderate/hard).
#    Settings -> Plugin Configuration -> Omni-Fixer, or env vars:
set OMNI_LLM_BASE_URL=https://api.deepseek.com/v1
set OMNI_LLM_API_KEY=sk-xxxx
set OMNI_LLM_WEAK_MODEL=Atria-Dawn
set OMNI_LLM_STRONG_MODEL=deepseek-v4.1
#    omni_fix { "root": "D:/Code/that-codebase" }

# 5) Slice big projects: maxContracts caps how many contracts one run handles.
#    omni_fix { "root": "...", "maxContracts": 20 }
```

### Slicing knobs for large codebases

- `maxFiles` (default 20000): scan file cap; anything beyond is skipped and logged.
- `maxFileToolchainChecks` (default 1500): among AST-clean files, at most this
  many get the `node --check` / `py_compile` fallback — the speed/memory dial.
- `maxContracts` (default 0 = unlimited): per-run contract cap for batched runs.
- `include` / `exclude`: glob filters — slice the scan to a subsystem first
  (e.g. `include: ["src/auth/**"]`) and fix subsystem by subsystem.
- Every contract carries its own verify spec and retry budget, so contracts
  never pollute each other — the slicing is parallelization-friendly.

---

## 4. The six DSH tools

| Tool | Purpose | Key parameters |
|---|---|---|
| `omni_scan` | full error sniffing (AST + toolchain + fallback) | `root`, `include`, `exclude`, `useToolchain` |
| `omni_isolate` | build Error Fix Contracts (preview what the model will see) | `root`, `contextLines` |
| `omni_fix` | **the full automatic pipeline**: scan -> isolate -> heal <-> verify -> rescan -> report | `root`, `dryRun`, `maxRetries`, `maxContracts` |
| `omni_heal` | fix only a given file/contract (surgical mode) | `root`, `file` or `contractId` |
| `omni_verify` | run the physical gate on a single file directly | `root`, `file` |
| `omni_report` | read a past battle report | `root`, `runId` (defaults to latest) |

Tools are used the same way by models and humans: describe the goal in a DSH
session and the model calls them; configuration is visible in Settings.

---

## 5. Installation

### As a DSH plugin (recommended)

```bash
# published npm release
dsh plugin add dsh-omni-fixer

# or a local development copy (this repo)
dsh plugin add D:/Code/dsh-omni-fixer
```

After install, configure models and pipeline parameters under
**Settings -> Plugin Configuration -> Omni-Fixer**.

### Configuration

| Option | Default | Description |
|---|---|---|
| `contextLines` | 50 | contract context window lines (~25 above/below) |
| `maxRetries` | 3 | repair rounds per contract |
| `maxFullFileLines` | 400 | contracts include the full file below this line count |
| `allowedDrift` | 3 | line-count drift tolerance for range patches (anti-hallucination) |
| `verifyStrategy` | `auto` | `auto` / `sandbox` / `inplace` |
| `dryRun` | false | verify but never write |
| `maxContracts` | 0 | per-run contract cap (0 = unlimited) |
| `llm.baseUrl` | env var -> `https://api.deepseek.com` | OpenAI-compatible endpoint |
| `llm.weakModel` | `Atria-Dawn` | model for simple errors |
| `llm.strongModel` | `deepseek-v4.1` | model for complex errors |

Environment variables (recommended for credentials, keeps config clean):
`OMNI_LLM_BASE_URL` / `OMNI_LLM_API_KEY` / `OMNI_LLM_WEAK_MODEL` /
`OMNI_LLM_STRONG_MODEL`.

Any OpenAI Chat Completions compatible gateway works: official DeepSeek API,
OpenAI, vLLM, ollama, local LM Studio, etc. Without credentials the
rule-engine channel still works.

---

## 6. Development

```bash
# Build (any TypeScript 4.7+ works)
npm run build         # emits lib/
npm run typecheck     # type-check only

# End-to-end smoke tests (node:test, zero external deps, built-in broken fixtures)
npm test
```

The suite covers: precise AST sniffing, toolchain failure detection,
rule-engine quick fix + sandbox verification + atomic write-back + rescan,
dry-run safety, and contract structure.

### Layout

```
src/
+-- core/          # ubiquitous-language layer (decoupled from the DSH host, unit-testable)
|   +-- types.ts   #   Diagnostic / FixContract / FixAttempt / RunStats
|   +-- util.ts    #   zero-dep utils: source tree walk / glob / snippet rendering
|   `-- proc.ts    #   process layer: unifies host ctx.subprocess and child_process
+-- scan/          # omni_scan
|   +-- ast-js.ts  #   zero-dependency JS/TS-family lexer
|   +-- ast-py.ts  #   Python lexer
|   +-- toolchain.ts # tsc / vitest / pytest / node --test / py_compile
|   `-- index.ts   #   three-phase orchestration: fast AST -> toolchain -> per-file fallback
+-- isolate/
|   `-- contract.ts # omni_isolate: Error Fix Contract builder
+-- heal/
|   +-- rules.ts   #   deterministic rule engine (0-token quick-fix channel)
|   +-- llm.ts     #   OpenAI-compatible LLM client (pure node:http/https)
|   +-- router.ts  #   adaptive model routing
|   `-- healer.ts  #   omni_heal executor: prompts / extraction / range patches
+-- verify/
|   `-- sandbox.ts # omni_verify: sandbox / inplace verification / atomic write-back
+-- pipeline.ts    # orchestration: scan -> isolate -> heal <-> verify -> rescan -> report
+-- reporter.ts    # omni_reporter: battle report (JSON + Markdown + latest.md)
+-- config.ts      # Schemastery config (single source of truth for tunables)
+-- tools.ts       # the six DSH tool definitions
`-- index.ts       # plugin entry (apply / tool registration)
```

### Key design constraints (from the DSH plugin contract)

- Plugin = `name` + `apply(ctx, config)` with `inject: ['tools']`;
  registration is an effect.
- Config via Schemastery `Schema<Config>`, no hardcoded tunables; secrets use
  `role('secret')` or environment variables.
- `execute` never throws — exceptions collapse into structured failures; only
  values declared in `output.schema` are returned; `exec.signal` is respected.
- Subprocesses go through a single `SpawnFn` abstraction (host
  `ctx.subprocess.spawn` when available, else `child_process`), so the core
  layer never imports host APIs and stays independently testable.

---

## 7. Roadmap

- [ ] More rule-engine rules (import order, unused variables, common pytest assertion patterns)
- [ ] Parallel contract healing (currently serial, with a concurrency dial)
- [ ] More languages (Go / Rust / Java lexers)
- [ ] LLM streaming and finer-grained token budgets
- [ ] A standalone VSCode extension (without the DSH host)

## License

MIT (c) 2026 DSH Omni-Fixer contributors
