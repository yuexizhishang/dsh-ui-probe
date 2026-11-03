/**
 * Host half of the ui-probe bundle — the in-DSH verification bridge.
 *
 * Definition of the tool: a local visual acceptance tool for DSH plugin pages.
 * The conversation decides what to verify, opens the target panel through this
 * bridge, exercises the plugin (including the plugin's own tools on the Host
 * side), and watches the UI reflect those effects.
 *
 * Verification is a session, not a snapshot:
 *   begin   open the target panel and remember the conversation it came from
 *   act     click / waitFor / audit / snapshot / wait / type — repeat as needed
 *   end     return the recorded timeline, then go back to that conversation
 * The client also ends the session by itself after 30s without an act, and puts
 * the page back after a reload, so a forgotten end does not strand the UI.
 *
 * The page reaches this Host half over a named HTTP route on the app's own
 * origin (no auth token needed), holding one long-poll request per page so an
 * idle window costs about one loopback request per minute.
 *
 * Development tooling only: `ui_page` acts on the live UI.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

export const inject = ['tools', 'webServer'];

const ROUTE_PREFIX = '/dsh-ui-probe';
const REQUEST_TIMEOUT_MS = 30000;
const HOLD_MS = 55000;

// Self-management (settings page): version check, update, uninstall.
const SELF_NAME = '@yuexizhishang/dsh-ui-probe';
const GITHUB_REPO = 'yuexizhishang/dsh-ui-probe';
const GITHUB_REF = 'main';
const UPDATE_DELAY_MS = 400;

async function localVersion() {
  const raw = await readFile(new URL('./package.json', import.meta.url), 'utf8');
  return JSON.parse(raw).version || null;
}

function compareVersion(a, b) {
  const pa = String(a || '0').split(/[.+-]/).map(function (n) { return parseInt(n, 10) || 0; });
  const pb = String(b || '0').split(/[.+-]/).map(function (n) { return parseInt(n, 10) || 0; });
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function fetchJson(url, headers) {
  const response = await fetch(url, {
    headers: Object.assign({ 'user-agent': 'dsh-ui-probe', accept: 'application/vnd.github+json' }, headers || {}),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' from ' + url);
  return await response.json();
}

function readBody(req) {
  return new Promise(function (resolve) {
    const chunks = [];
    let size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > 1024 * 1024) {
        req.destroy();
        resolve('');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', function () {
      resolve('');
    });
  });
}

const SKILL_CONTENT = `# dsh-ui-probe

Verify a DSH plugin page in the running app: open its panel, read real computed
styles, click a control, wait for an async effect, and capture console errors.
Afterwards the page returns to the conversation that asked for it.

## Tools

- \`ui_probe\` — bridge status (\`connected\`, \`polls\`, \`heldOpen\`, versions). Read-only.
- \`ui_page\` — one action:
  - \`begin { openText | openSelector, settleMs }\` opens the target panel and records the
    originating conversation (id + title). Omit both to verify in place (no navigation).
  - \`act { act: { kind, text | selector, value, ms, settleMs, timeoutMs } }\` one step;
    \`kind\` is \`click\` / \`waitFor\` / \`audit\` / \`snapshot\` / \`wait\` / \`type\` / \`key\`.
  - \`end\` returns the timeline (\`steps\`, each with \`kind/at/elapsedMs/result\`), a final
    snapshot and captured errors, then goes back to that conversation.
  - \`peek\` opens, audits one target and comes straight back (one call).
  - Read-only: \`audit\`, \`find\`, \`outline\`, \`info\`, \`errors\`; \`restore-origin\` returns to the
    recorded origin.

## How to verify

1. \`cordis_inspect_query\` → \`Slots.listSubTree\` confirms the slot registration (no window needed).
2. \`begin\` with the entry's visible text.
3. \`act waitFor\` until the panel's real content exists (past the skeleton state).
4. \`act audit\` for the element's box and computed styles; compare with a sibling host element.
5. To prove a plugin feature reaches the UI: call that plugin's own tool, then
   \`act waitFor\` the expected change and \`act audit\` the value. Report those values.
6. \`act errors\` (or the \`errors\` array from \`end\`) catches slot crashes.
7. \`end\`; quote the timeline values instead of claiming "looks fine".

## Rules

- **Settings, account, balance, recharge and the account menu are off-limits.** Clicks there
  are refused (\`refused: 'off-limits'\`); a click that opens them is undone immediately. Never
  try to work around this.
- A verification session keeps the UI on the panel on purpose; \`end\` (or 30 s without an
  \`act\`) returns to the conversation.
- \`type\` reports \`ok\` only after reading the value back; \`ok: false\` means it did not stick.
- Run one \`ui_page\` call at a time; the bridge has a single request queue.
- Pixel screenshots are not available from inside the app; use DOM and computed styles.
`;

export function apply(ctx) {
  const bridge = {
    pending: null,
    waiter: null,
    held: [],
    lastPollAt: 0,
    lastResultAt: 0,
    polls: 0,
    results: 0,
    holds: 0,
  };

  function sendJson(res, status, value) {
    if (!res || typeof res.writeHead !== 'function' || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  function flushHeld() {
    const held = bridge.held;
    bridge.held = [];
    for (const entry of held) {
      clearTimeout(entry.timer);
      sendJson(entry.res, 200, bridge.pending || { id: null });
    }
  }

  function settle(id, payload) {
    if (!bridge.pending || bridge.pending.id !== id) return false;
    bridge.pending = null;
    bridge.results += 1;
    bridge.lastResultAt = Date.now();
    if (bridge.waiter) {
      const waiter = bridge.waiter;
      bridge.waiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(payload);
    }
    return true;
  }

  function request(action, args) {
    return new Promise(function (resolve, reject) {
      if (bridge.pending) {
        reject(new Error('another page request is still pending; the bridge takes one at a time'));
        return;
      }
      const id = 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      bridge.pending = { id: id, action: action, args: args || {} };
      flushHeld();
      const timer = setTimeout(function () {
        if (bridge.pending && bridge.pending.id === id) bridge.pending = null;
        bridge.waiter = null;
        reject(
          new Error(
            'no answer from the DSH page within ' + REQUEST_TIMEOUT_MS + 'ms. Is the client half loaded in an open window?',
          ),
        );
      }, REQUEST_TIMEOUT_MS);
      bridge.waiter = { timer: timer, resolve: resolve };
    });
  }

  // Discovery for other people's profiles: a runtime skill carrying the usage guide,
  // plus one short prompt section so the model knows the skill exists. Both are
  // optional services; without them the tools still work.
  const skillsService = ctx.get('skills');
  if (skillsService && typeof skillsService.register === 'function') {
    ctx.effect(function () {
      const dispose = skillsService.register({
        name: 'dsh-ui-probe',
        description:
          'Verify a DSH plugin page in the running app: open its panel, read real DOM and computed styles, click controls, wait for async effects, catch console errors, then return to the conversation.',
        whenToUse:
          'When a DSH plugin or UI change must be verified in the running app, or the user asks whether a panel renders, looks right, reacts, or reports errors.',
        content: SKILL_CONTENT,
        source: 'runtime',
        invocation: { modelInvocable: true, userInvocable: true },
      });
      return function () {
        try {
          dispose();
        } catch (error) {
          // already disposed
        }
      };
    }, 'ui-probe: skill');
  }

  const promptService = ctx.get('systemPrompt');
  if (promptService && typeof promptService.section === 'function') {
    ctx.effect(function () {
      const dispose = promptService.section({
        name: 'dsh-ui-probe',
        order: 500,
        text:
          'Verifying a DSH plugin page in the running app: the `ui_page` tool runs a verification session ' +
          '(begin / act / end) that reads real DOM and computed styles, clicks controls, waits for async effects ' +
          'and returns a timeline plus captured console errors. Load the `dsh-ui-probe` skill for the full guide. ' +
          'Settings, account, balance, recharge and the account menu are off-limits to automation; never attempt them.',
      });
      return function () {
        try {
          dispose();
        } catch (error) {
          // already disposed
        }
      };
    }, 'ui-probe: prompt section');
  }

  function pluginManagerService() {
    const manager = ctx.get('pluginManager');
    if (!manager) throw new Error('pluginManager service is not available in this profile');
    return manager;
  }

  // Read the published state of this package. The comparison key is package.json's
  // version: pushing code without bumping it is not a new release.
  async function selfCheck() {
    const local = await localVersion();
    const info = {
      ok: true,
      local: local,
      remote: null,
      sha: null,
      upToDate: null,
      commitMessage: null,
      committedAt: null,
      repo: GITHUB_REPO,
      ref: GITHUB_REF,
      checkedAt: Date.now(),
    };
    try {
      const commit = await fetchJson('https://api.github.com/repos/' + GITHUB_REPO + '/commits/' + GITHUB_REF);
      info.sha = (commit && commit.sha) || null;
      const head = (commit && commit.commit && commit.commit.message) || '';
      info.commitMessage = String(head).split('\n')[0].slice(0, 160);
      info.committedAt = (commit && commit.commit && commit.commit.committer && commit.commit.committer.date) || null;
    } catch (error) {
      return {
        ok: false,
        local: local,
        repo: GITHUB_REPO,
        error: 'GitHub API: ' + ((error && error.message) || String(error)),
        hint: '仓库尚未推送或当前网络不可达 GitHub',
      };
    }
    try {
      const response = await fetch(
        'https://raw.githubusercontent.com/' + GITHUB_REPO + '/' + GITHUB_REF + '/package.json',
        { headers: { 'user-agent': 'dsh-ui-probe' }, signal: AbortSignal.timeout(15000) },
      );
      if (response.ok) {
        const manifest = JSON.parse(await response.text());
        info.remote = manifest.version || null;
      }
    } catch (error) {
      info.remoteError = (error && error.message) || String(error);
    }
    if (info.remote) info.upToDate = compareVersion(local, info.remote) >= 0;
    return info;
  }

  async function selfUpdate(sha) {
    const manager = pluginManagerService();
    const check = await selfCheck();
    if (!check.ok) return { ok: false, skipped: false, error: check.error, check: check };
    if (check.upToDate) {
      return { ok: true, skipped: true, reason: 'already up to date', check: check };
    }
    const ref = sha || check.sha;
    const spec = 'github:' + GITHUB_REPO + (ref ? '#' + ref : '');
    const result = await manager.installBundle(spec, { enabled: true });
    return {
      ok: result.application !== 'failed',
      skipped: false,
      spec: spec,
      application: result.application,
      restartReason: result.restartReason,
      version: result.version,
      warnings: result.warnings || [],
      error: result.error || null,
      check: check,
    };
  }

  function selfUninstall() {
    const manager = pluginManagerService();
    // Deliberately a plain timer, not ctx.effect: the removal must run after this
    // request has been answered, and the plugin unloads itself while doing it.
    setTimeout(function () {
      Promise.resolve(manager.removeBundle(SELF_NAME)).catch(function () {
        // the manager reports its own failures; nothing left to notify here
      });
    }, UPDATE_DELAY_MS);
    return {
      ok: true,
      scheduled: true,
      target: SELF_NAME,
      note: '已提交卸载：本插件的依赖与启用行会被移除，停止后本页面会消失；不会删除仓库或任何用户文件。',
    };
  }

  ctx.effect(function () {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      async handler(req, res) {
        if (!res || typeof res.writeHead !== 'function') return;
        const rawUrl = typeof req.url === 'string' ? req.url : '';
        const url = rawUrl.split('?')[0];
        const query = new URLSearchParams(rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '');
        const clientId = query.get('c') || '';

        if (url.endsWith('/self')) {
          // Settings page actions. These never touch user files: they only call the
          // plugin manager, which owns the profile dependency and bundle selection.
          let request = {};
          try {
            request = JSON.parse((await readBody(req)) || '{}');
          } catch (error) {
            sendJson(res, 400, { ok: false, error: 'invalid json body' });
            return;
          }
          const action = request && request.action;
          try {
            if (action === 'check') {
              sendJson(res, 200, await selfCheck());
              return;
            }
            if (action === 'update') {
              sendJson(res, 200, await selfUpdate(request.sha));
              return;
            }
            if (action === 'uninstall') {
              sendJson(res, 200, await selfUninstall());
              return;
            }
            sendJson(res, 400, { ok: false, error: 'unknown action: ' + String(action) });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: (error && error.message) || String(error) });
          }
          return;
        }

        if (url.endsWith('/poll')) {
          bridge.polls += 1;
          bridge.lastPollAt = Date.now();

          // Only the newest connection may hold a request. A poll from a different
          // client id means an older page generation (a reload, or a duplicate HMR
          // instance) is still alive: release it and tell it to retire, so it stops
          // polling instead of racing this one for the same task.
          const stale = bridge.held;
          bridge.held = [];
          for (const old of stale) {
            clearTimeout(old.timer);
            if (clientId && old.clientId && old.clientId !== clientId) {
              sendJson(old.res, 200, { id: null, retired: true });
            } else {
              sendJson(old.res, 200, { id: null });
            }
          }

          if (bridge.pending) {
            sendJson(res, 200, bridge.pending);
            return;
          }
          bridge.holds += 1;
          const entry = {
            res: res,
            clientId: clientId,
            timer: setTimeout(function () {
              const index = bridge.held.indexOf(entry);
              if (index >= 0) bridge.held.splice(index, 1);
              sendJson(res, 200, { id: null });
            }, HOLD_MS),
          };
          bridge.held.push(entry);
          res.on('close', function () {
            clearTimeout(entry.timer);
            const index = bridge.held.indexOf(entry);
            if (index >= 0) bridge.held.splice(index, 1);
          });
          return;
        }

        if (url.endsWith('/result')) {
          const raw = await readBody(req);
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            sendJson(res, 400, { ok: false, error: 'invalid json' });
            return;
          }
          sendJson(res, 200, { ok: settle(parsed && parsed.id, parsed) });
          return;
        }

        sendJson(res, 200, {
          ok: true,
          polls: bridge.polls,
          holds: bridge.holds,
          results: bridge.results,
          lastPollAt: bridge.lastPollAt,
          lastResultAt: bridge.lastResultAt,
          pending: bridge.pending ? bridge.pending.id : null,
          heldOpen: bridge.held.length,
        });
      },
    });
    return function () {
      try {
        dispose();
      } catch (error) {
        // already disposed
      }
      flushHeld();
    };
  }, 'ui-probe: bridge route');

  function register(definition) {
    ctx.effect(function () {
      const dispose = ctx.tools.register(definition);
      return function () {
        try {
          dispose();
        } catch (error) {
          // already disposed
        }
      };
    }, 'ui-probe: ' + definition.name);
  }

  register({
    name: 'ui_probe',
    description:
      'Report the in-DSH verification bridge status: whether the plugin page half is polling, how recently, and the Electron runtime versions. Read-only diagnostic.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    },
    async execute() {
      const now = Date.now();
      return {
        connected: bridge.lastPollAt > 0 && now - bridge.lastPollAt < 90000,
        polls: bridge.polls,
        holds: bridge.holds,
        results: bridge.results,
        lastPollAgoMs: bridge.lastPollAt ? now - bridge.lastPollAt : null,
        lastResultAgoMs: bridge.lastResultAt ? now - bridge.lastResultAt : null,
        pending: bridge.pending ? bridge.pending.id : null,
        heldOpen: bridge.held.length,
        route: ROUTE_PREFIX,
        idle: 'long-poll: one held request for up to 55s, answered immediately when work arrives',
        versions: {
          electron: (typeof process !== 'undefined' && process.versions.electron) || null,
          chrome: (typeof process !== 'undefined' && process.versions.chrome) || null,
          node: (typeof process !== 'undefined' && process.versions.node) || null,
        },
        tmp: tmpdir(),
        hint: join(tmpdir(), 'dsh-ui-probe'),
      };
    },
  });

  register({
    name: 'ui_page',
    description:
      'Local visual acceptance tool for DSH plugin pages. Works as a session: "begin" opens the target panel and remembers the conversation it came from, "act" performs one step (click / waitFor / audit / snapshot / wait / type / key) and records it in a timeline, "end" returns that timeline and goes back to the conversation. Use waitFor to observe effects that arrive later, and interleave the plugin\'s own tools between acts to confirm the visual UI reflects them. OFF-LIMITS: settings, account, balance, recharge, and the account menu are never automated. Actions there are refused, and a click that opens the settings panel is closed again immediately and reported as a refusal. The session also ends by itself after 30s without an act and puts the page back after a reload. Read-only actions (audit/find/outline/info/errors) never change what the user is looking at; "peek" is the quick open-read-return shortcut.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['begin', 'act', 'end', 'peek', 'audit', 'find', 'outline', 'info', 'errors', 'restore-origin'],
          description: 'Session action (begin/act/end), quick check (peek), or read-only inspection.',
        },
        openText: {
          type: 'string',
          description: 'Visible text of the control that opens the panel (a sidebar entry, a tab).',
        },
        openSelector: {
          type: 'string',
          description: 'CSS selector of the control that opens the panel.',
        },
        settleMs: {
          type: 'number',
          description: 'How long to wait after opening before reporting the snapshot. Defaults to 300.',
        },
        act: {
          type: 'object',
          description: 'One verification step, used with action "act".',
          properties: {
            kind: {
              type: 'string',
              enum: ['click', 'waitFor', 'audit', 'snapshot', 'wait', 'type', 'key'],
              description: 'click = press an element; waitFor = poll until an element exists; audit = geometry and computed styles; snapshot = visible headings/buttons; wait = fixed delay; type = write a value into a field (input or rich text, verified by reading it back); key = press one key (Enter, Escape, Backspace…).',
            },
            text: { type: 'string', description: 'Visible text target for click/waitFor/audit/type.' },
            selector: { type: 'string', description: 'CSS selector target for click/waitFor/audit/type.' },
            within: {
              type: 'string',
              description: 'CSS selector limiting a text search to one container (click/waitFor/audit/type), so chat text with the same wording cannot win.',
            },
            value: { type: 'string', description: 'Value to write for kind "type".' },
            key: { type: 'string', description: 'Key to press for kind "key", for example Enter, Escape, Backspace.' },
            clear: { type: 'boolean', description: 'For kind "type": replace the existing content instead of appending. Defaults to true.' },
            clickOnly: {
              type: 'boolean',
              description:
                'For kind "click": dispatch only a click event, without pointerdown/pointerup. Some triggers open on pointerdown and toggle on click, so the full press closes them again.',
            },
            ms: { type: 'number', description: 'Delay for kind "wait", at most 30000.' },
            settleMs: { type: 'number', description: 'Wait after the step before reporting. Defaults to 300.' },
            timeoutMs: { type: 'number', description: 'Timeout for kind "waitFor". Defaults to 5000, at most 30000.' },
            limit: { type: 'integer', description: 'Maximum matches to consider. Defaults to 20.' },
            within: {
              type: 'string',
              description:
                'CSS selector limiting a text search to one container, so a label that also appears in the transcript resolves to the control instead.',
            },
          },
          required: ['kind'],
          additionalProperties: false,
        },
        selector: {
          type: 'string',
          description: 'CSS selector for audit, outline, peek and find.',
        },
        text: {
          type: 'string',
          description: 'Visible text to locate an element for audit/peek, or the needle for find.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of matches or children to return. Defaults to 20.',
        },
        restore: {
          type: 'boolean',
          description: 'For "peek": navigate back afterwards. Defaults to true.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    },
    async execute(args, exec) {
      const action = args && typeof args.action === 'string' ? args.action : '';
      // The calling agent's session id lets the page address the conversation it
      // came from exactly, instead of matching a possibly duplicated title.
      const agentSessionId =
        exec && exec.agent && typeof exec.agent.id === 'string' ? exec.agent.id : null;
      const payload = {
        selector: args && typeof args.selector === 'string' ? args.selector : '',
        text: args && typeof args.text === 'string' ? args.text : '',
        limit: args && Number.isFinite(args.limit) ? Math.max(1, Math.min(200, args.limit)) : 20,
        restore: !(args && args.restore === false),
        openText: args && typeof args.openText === 'string' ? args.openText : '',
        openSelector: args && typeof args.openSelector === 'string' ? args.openSelector : '',
        settleMs: args && Number.isFinite(args.settleMs) ? Math.max(0, Math.min(10000, args.settleMs)) : 300,
        act: args && args.act && typeof args.act === 'object' ? args.act : null,
        agentSessionId: agentSessionId,
      };
      return await request(action, payload);
    },
  });
}
