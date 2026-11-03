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

export const inject = ['tools', 'webServer'];

const ROUTE_PREFIX = '/dsh-ui-probe';
const REQUEST_TIMEOUT_MS = 30000;
const HOLD_MS = 55000;

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
      'Local visual acceptance tool for DSH plugin pages. Works as a session: "begin" opens the target panel and remembers the conversation it came from, "act" performs one step (click / waitFor / audit / snapshot / wait / type) and records it in a timeline, "end" returns that timeline and goes back to the conversation. Use waitFor to observe effects that arrive later, and interleave the plugin\'s own tools between acts to confirm the visual UI reflects them. The session also ends by itself after 30s without an act and puts the page back after a reload. Read-only actions (audit/find/outline/info/errors) never change what the user is looking at; "peek" is the quick open-read-return shortcut.',
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
            value: { type: 'string', description: 'Value to write for kind "type".' },
            key: { type: 'string', description: 'Key to press for kind "key", for example Enter, Escape, Backspace.' },
            clear: { type: 'boolean', description: 'For kind "type": replace the existing content instead of appending. Defaults to true.' },
            ms: { type: 'number', description: 'Delay for kind "wait", at most 30000.' },
            settleMs: { type: 'number', description: 'Wait after the step before reporting. Defaults to 300.' },
            timeoutMs: { type: 'number', description: 'Timeout for kind "waitFor". Defaults to 5000, at most 30000.' },
            limit: { type: 'integer', description: 'Maximum matches to consider. Defaults to 20.' },
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
