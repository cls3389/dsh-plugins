# execution-sandbox

Per-Agent Docker shell backend for external Feishu identities. It follows the OpenClaw model: persistent sandbox container plus container-local `docker exec`, not host `workspace-write` execution.

## Guarantees

- Native DSH `bash` schema, output, foreground/background and cancellation remain intact.
- Each Agent receives its own scoped native bash, shell executor and working-directory boundary.
- Only the trusted session workspace is mounted, at the same absolute path. Host credentials, other user workspaces and Docker socket are not mounted.
- Container root filesystem is read-only; `/tmp` is a private 64 MiB tmpfs; workspace `.tmp` is the preferred temporary directory.
- Network is disabled by default. Web research uses the normal controlled tools, not shell networking.
- Non-root UID/GID matching the host workspace owner, all capabilities dropped, no-new-privileges.
- Limits: 1 CPU, 1 GiB RAM (and same swap cap), 128 PIDs. DSH command timeouts still apply.
- Docker unavailable or image missing fails closed; never runs the command on the host.
- Agent teardown removes its sandbox container.

## Image and configuration

Build from this directory:

```sh
docker build --pull -t dsh-user-sandbox:bookworm .
```

The image provides bash, Python, Node.js, git, jq, curl and ordinary file utilities. Installing network packages from inside a command is intentionally unavailable while network is `none`.

Install only on profiles serving untrusted users. Do not mount this plugin on an owner/trusted trading profile merely for convenience. The plugin declares `inject = ['tools', 'workingDirectory', 'agents']` and installs a scoped bash when the Agent is created, so the original global tool is not redefined.

```sh
npm test
```
