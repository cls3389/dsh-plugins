# Official Lark for DSH

A clean DeepSeek Harness bundle built on the official
[`larksuite/openclaw-lark`](https://github.com/larksuite/openclaw-lark)
implementation. It runs in-process in DSH and does not require OpenClaw.

## Behavior

- Official Lark WebSocket events and message converters.
- Official CardKit `Thinking → Streaming → Complete` cards. User-initiated
  replies retain the official IM-card fallback; proactive background notifications
  require CardKit and retry failures without switching to another send path.
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
    workspaceRoot: /path/to/ui-workspaces
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

## Durable background notifications

The plugin provides `ctx.get('feishuNotifications')` with these host-only methods:

```ts
await notifications.deliver({ sessionId, ownerOpenId, ownerAppId, text, eventId });
notifications.status(eventId?, ownerAppId?);
await notifications.rebindPreviousSession({ sessionId, previousSessionId, ownerOpenId, ownerAppId });
```

`deliver` acknowledges only after the owning bot's `notifications.json` journal
has been atomically written and fsynced. It does not wait for the model turn.
Startup replays unfinished records after loading the existing SessionStore.
Records expose `status` (`accepted`, `running`, `completed`), `attempts`,
`lastError`, `currentSessionId`, and `card.cardMessageId`. Retries use exponential
backoff capped at 60 seconds. Full prompt/result receipts are kept for the newest
100 completed notifications; older records keep permanent id/hash/owner/card
receipts for deduplication. The JSON snapshot and permanent receipt metadata grow
with event count; this queue targets low-volume personal notifications and has
one owning process per bot/data directory.

Every acceptance and dispatch verifies the exact bot app and the existing
session owner. Validation runs again after waiting for an existing Agent turn.
The saved chatId must stay unchanged. Missing/ambiguous bindings, another app or
another owner are rejected before card creation or model submission. The sender
never chooses an arbitrary live session, substitutes a default owner or overwrites
Agent identity to make a mismatched session pass.

`previousSessionIds` on a binding allows a reset session to follow the same chat's
current session, with owner validation repeated on delivery. It cannot redirect a
notification to another chat. The migration method accepts no chatId and rejects
aliases already owned by another binding. It is a trusted host API and must not
be exposed without authentication or evidence for the old session. These checks
trust the host caller and persisted registry; possession of a shared hub token is
not a separately authenticated end-user identity.

Background turns share the inbound chat queue, active-session routing and
OfficialTurnStream. They send proactive CardKit messages with no reply messageId,
use `source: {kind: 'schedule'}`, and preserve the supplied eventId as the model
input identity. CardKit failure is retried before model submission; background
notifications require CardKit access. Finalization retries reuse the saved card.
The permanent local receipt and Feishu's stable UUID suppress ordinary duplicate
requests; they are not an atomic transaction with Feishu or session persistence,
so arbitrary power loss beyond Feishu's UUID retention window cannot provide
strict cross-system exactly-once delivery. Persisted claimed turns are recovered
from session events instead of being submitted a second time. OAuth callbacks
that assume a real inbound messageId are not supported in proactive turns.

### Receipt interpretation and production verification

A successful `deliver()` or wake bridge HTTP 200 means durable acceptance. It does
not mean the model has completed or that a person has read the message. Inspect
`status`, `result`, `card.cardMessageId`, `attempts` and `lastError` for the next
stages. A final CardKit API update with `code=0`, together with an IM message in
the expected chat and the saved model output, establishes server-side delivery.
The ordinary IM GET API may expose only CardKit's compatibility placeholder;
that placeholder is not proof that the final card body was missing.

On 2026-11-03 the investment assistant (`guests` / `investment-assistant`) loaded
this implementation by restarting only `dsh-guests`. Its authenticated loopback
watch bridge is `127.0.0.1:17922/wake`. A temporary one-shot rule triggered an AI
reply in the owner's existing private chat, with a successful final CardKit
update. Replaying the same event kept the same card and did not increment model
execution attempts. The test rule was removed. Channel tests: 77 passed;
notification tests: 7 passed; build and typecheck passed.

The other assistant profiles were not restarted as part of this deployment.
Shared source files alone do not prove that another running service has loaded
this version. AI signal trading and xiadan trading were not exercised by the
notification acceptance test.

## Build and test

```sh
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
```
