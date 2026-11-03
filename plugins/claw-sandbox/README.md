# claw-sandbox

Docker `ctx.sandbox` provider for the official DSH `bash-sandbox` executor. It follows the OpenClaw model: persistent session container plus container-local `docker exec`, while native DSH `bash`/`bash_compact` schemas, jobs, cancellation and output contracts remain unchanged.

## Guarantees

- Registers **only** `ctx.sandbox`; the base `@deepseek-ai/dsh-bash-sandbox` provides `ctx.shell`. No second bash tool registration, no tool wrapper and no per-call monkey patch.
- The policy workspace root comes from the base session layer. Only that trusted workspace is mounted at the same absolute path. Host credentials, other workspaces and Docker socket are not mounted.
- Container root filesystem is read-only; `/tmp` is a private 64 MiB tmpfs; workspace `.tmp` is the preferred temporary directory.
- Network is disabled by default (`--network none`). Web research uses controlled tools, not shell networking.
- Non-root UID/GID matching the host workspace owner, all capabilities dropped, `no-new-privileges`.
- Limits: 1 CPU, 1 GiB RAM (and same swap cap), 128 PIDs. DSH command timeouts still apply.
- Docker/image failure fails closed via `SANDBOX_UNAVAILABLE`; never runs the command on the host.
- Plugin teardown removes containers it created.

## Configuration

The bundle patch disables the base local sandbox provider and enables official `bash-sandbox`:

```yaml
- id: sandbox
  disabled: true
- id: bash-sandbox
  config: { timeoutMs: 60000 }
- insert:
    - id: claw-sandbox
      name: '@dsh-friends/claw-sandbox'
      config:
        image: dsh-user-sandbox:bookworm
        uid: 1000
        gid: 1000
        network: none
        workspaceRoots: [/data/dsh/home/agents]
        memory: 1g
        cpus: 1
        pidsLimit: 128
```

`bash_compact` must pass the base per-session policy: `ctx.sandboxPolicy.resolve({ session: exec.agent?.session })`. A policy without session falls back to `/` and must be rejected by this provider.

## Image and tests

The image includes pinned NumPy, pandas and matplotlib wheels for numerical, date-aligned tabular analysis and offline charts, plus a CJK font. BLAS worker pools default to one thread to stay within the sandbox CPU/PID budget. It intentionally excludes scipy and scikit-learn.

Programs live on the host in `tools/` and are mounted at `/opt/dsh-tools:ro`. The user's own workspace is writable; the system tool directory and container root are read-only. Updating a host tool requires **no image rebuild or service restart**; existing containers see the new file contents immediately. Rebuild only when changing dependencies or the environment image.

`market-analysis <ths_klines.json>` computes deterministic MA5/10/20/60, MACD(12,26,9), Wilder RSI14/ATR14, Bollinger bands, returns, drawdown, VWAP, volume ratios and weekly OHLCV from existing market-tool JSON. For a direct market-tool to sandbox handoff, pass the original JSON through one bash pipeline into `market-analysis /dev/stdin`; do not create a placeholder JSON or alternate host `write/edit` with sandbox writes on the same file. Optional `--chart <workspace.png>` renders K-lines, moving averages, volume and MACD; `--csv <workspace.csv>` exports the full indicator series. It reads only the supplied file, performs no adjustment, has no network/credentials and never calls trading or quote APIs. Prices retain the adjustment explicitly supplied by `ths_klines`. Run `python3 test_market_analysis.py` inside the built image for deterministic indicator and chart tests.

Partial-session volume comparison is available without a bars file: `market-analysis --volume-current 140 --volume-previous-day 131 --as-of 2026-11-03T14:00:00+08:00`. It excludes the 11:30–13:00 lunch break (14:00 is 180/240 = 75%), labels a linear full-day projection as an estimate, and prefers `--volume-previous-same-time` when a comparable historical cumulative value is available. Use identical units and an actual source timestamp on a confirmed trading date; the offline helper does not supply a holiday calendar or infer a bottom from volume.

The build defaults to the Tsinghua PyPI mirror; override it with `--build-arg PIP_INDEX_URL=<index-url>` when needed. Do not use build-time mirror settings as a reason to enable runtime networking: the sandbox must remain offline.

Build from this directory. The build helper defaults to the LAN SOCKS5 pool at `192.168.5.254:1081-1086`; select one with `SANDBOX_PROXY_PORT=1082 sh build.sh`. The proxy is passed only to build `RUN` instructions via Build ARGs, not saved in the image or user-sandbox runtime. The running sandbox remains `--network none`.

```sh
sh build.sh
npm test
```

Tests cover container isolation, offline execution, standard MA/MACD/Wilder RSI/ATR/Bollinger calculations, weekly aggregation, minute bars, warm-up/flat/zero-volume cases, malformed OHLCV, Chinese chart output and the real `market-analysis` CLI.

Image updates do not affect existing persistent containers. After the tests pass, run `sh rebuild-workspace-sandbox.sh <absolute-user-workspace> <existing-dsh-user-container>`. It checks the exact workspace mount, UID/GID, new image, read-only tools and writable workspace, then atomically renames the verified new container into the live provider's cached name. No DSH service restart is needed for an image-only update. Changing the sandbox provider's JavaScript still requires restarting the affected identity service once.

End-to-end Feishu regression uses the owner-authorized test OAuth identity and fails if either of two consecutive turns escapes Docker:

```sh
node feishu-regression.mjs
```

Do not mount this plugin on owner/trusted profiles merely for convenience.
