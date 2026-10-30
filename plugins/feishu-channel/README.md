# Official Lark for DSH

A clean DeepSeek Harness bundle built on the official
[`larksuite/openclaw-lark`](https://github.com/larksuite/openclaw-lark)
implementation. It runs in-process in DSH and does not require OpenClaw.

## Behavior

- Official Lark WebSocket events and message converters.
- Official CardKit `Thinking → Streaming → Complete` cards, with the official
  IM-card fallback when CardKit is unavailable.
- DSH agent/session creation and resumption, with a new independent session
  registry under `$DSH_HOME/lark/sessions.json`.
- Secret-free app identity and session membership under
  `$DSH_HOME/lark/workspace.json`. Web creates one real directory workspace per
  application, and new/reset chats use `<workspaceRoot>/<appId>` as their cwd.
  Existing chat bindings keep their original cwd and are not migrated.
- Official OAPI, document MCP, and OAuth tools registered on the DSH tool
  runtime.
- `/stop` cancels the current turn; `/new` starts a fresh DSH session;
  `/status` reports the channel state.

There is no legacy DSH Feishu bridge, legacy card renderer, legacy panel, or
OpenClaw reply runtime in this package.

## Configuration

```yaml
- id: feishu
  name: '@larksuite/dsh-lark'
  config:
    appId: cli_xxx
    # Optional: defaults to the bot name returned by Feishu.
    appName: My Bot
    appSecret: yyy
    defaultCwd: /path/to/workspace
    # Optional: defaults to <defaultCwd>/feishu.
    workspaceRoot: /path/to/feishu-workspaces
    replyMode: streaming
    groupMentionMode: always
```

Optional `allowedChats` and `allowedUsers` arrays restrict access. Use
`tools: { deny: [<feishu_tool_name>] }` to disable selected official tools.
The app needs the permissions required by the enabled tools; enabling a tool
in DSH does not grant permissions in the Feishu developer console.

## Multiple Feishu applications

One DSH Agent runtime can host multiple Bot WebSockets. `botsFile` points to a
`0600` JSON array of `{ accountId, appId, appSecret, appName, dataDir,
workspaceRoot }`. Every account must have a distinct appId and dataDir; IDs are
canonicalized to lowercase and `default` is reserved for the primary Bot. Each
Bot owns its SessionStore and application/user/session workspaces. Official
OAPI/OAuth and encrypted token storage use `appId + senderOpenId`, never another
Bot's credentials. Web discovers the primary workspace.json plus
`bots/*/workspace.json` beneath one 飞书应用 parent.

## Build and test

```sh
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
```
