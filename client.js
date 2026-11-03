/**
 * Client half of the ui-probe bundle — it runs inside the DSH page.
 *
 * It is a verification session, not a single snapshot:
 *   begin  open the target panel, remember the conversation we came from
 *   act    click / waitFor / audit / snapshot / wait / type — repeat as needed
 *   end    return a timeline of what happened, then go back to that conversation
 *
 * The session stays open while the conversation uses the new plugin, so effects
 * that take seconds (async data, toasts, saves) can be observed. Three fallbacks
 * put the UI back even when nobody calls end: an idle timer, a page reload (the
 * origin is kept in sessionStorage), and an explicit restore-origin.
 *
 * No eval: actions are a fixed vocabulary, so the page's CSP stays intact.
 */
window.__ModuleLoader__.load({
  id: '@yuexizhishang/dsh-ui-probe',
  factory(require) {
    const RETRY_MS = 2000;
    const EMPTY_GAP_MS = 800;
    // One id per page load: the Host retires older ids, so a stale generation (a
    // reload, or a duplicate HMR instance) cannot race the live one for tasks.
    const CLIENT_ID = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const MAX_ERRORS = 40;
    const IDLE_END_MS = 30000;
    const DEFAULT_SETTLE = 300;
    const WAIT_POLL_MS = 120;
    const SESSION_KEY = 'dsh-ui-probe-session';
    const LAST_END_KEY = 'dsh-ui-probe-last-end';
    const STYLE_KEYS = [
      'display',
      'position',
      'width',
      'height',
      'padding',
      'margin',
      'gap',
      'font-size',
      'font-weight',
      'line-height',
      'color',
      'background-color',
      'border',
      'border-radius',
      'box-shadow',
      'opacity',
      'z-index',
    ];

    function rectOf(element) {
      const box = element.getBoundingClientRect();
      return {
        x: Math.round(box.x * 10) / 10,
        y: Math.round(box.y * 10) / 10,
        width: Math.round(box.width * 10) / 10,
        height: Math.round(box.height * 10) / 10,
      };
    }

    function describe(element) {
      const tag = element.tagName.toLowerCase();
      const id = element.id ? '#' + element.id : '';
      const cls = element.className && typeof element.className === 'string'
        ? '.' + element.className.trim().split(/\s+/).slice(0, 4).join('.')
        : '';
      return tag + id + cls;
    }

    function textOf(element, limit) {
      return String(element.textContent || '').trim().slice(0, limit || 120);
    }

    function stylesOf(element, keys) {
      const computed = window.getComputedStyle(element);
      const out = {};
      for (const key of keys) out[key] = computed.getPropertyValue(key);
      return out;
    }

    function findByText(needle, limit) {
      const found = [];
      if (!needle) return found;
      for (const element of document.querySelectorAll('body *')) {
        if (found.length >= limit) break;
        const own = Array.from(element.childNodes)
          .filter(function (node) { return node.nodeType === 3; })
          .map(function (node) { return node.textContent || ''; })
          .join(' ')
          .trim();
        if (own && own.indexOf(needle) !== -1) found.push(element);
      }
      return found;
    }

    function audit(target) {
      if (!target.length) return { found: 0 };
      const element = target[0];
      return {
        found: target.length,
        node: describe(element),
        text: textOf(element, 200),
        rect: rectOf(element),
        visible: Boolean(element.offsetParent || element.getClientRects().length),
        styles: stylesOf(element, STYLE_KEYS),
        attributes: Array.from(element.attributes).reduce(function (acc, attr) {
          acc[attr.name] = String(attr.value).slice(0, 120);
          return acc;
        }, {}),
        children: element.children.length,
      };
    }

    function outline(target, limit) {
      if (!target.length) return { found: 0 };
      const walk = function (element, depth) {
        if (depth > 3) return null;
        const kids = [];
        for (const child of element.children) {
          if (kids.length >= limit) break;
          const childNode = walk(child, depth + 1);
          if (childNode) kids.push(childNode);
        }
        return { node: describe(element), rect: rectOf(element), text: textOf(element, 80), children: kids };
      };
      return { found: target.length, tree: walk(target[0], 0) };
    }

    function resolveTarget(args) {
      if (args.selector) {
        try {
          return Array.from(document.querySelectorAll(args.selector));
        } catch (error) {
          throw new Error('invalid selector: ' + args.selector);
        }
      }
      if (args.text) return findByText(args.text, args.limit || 20);
      return [];
    }

    function sleep(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    // The composer exists only while a conversation is on screen; that attribute
    // is stable, unlike the generated class names.
    function hasComposer() {
      return Boolean(document.querySelector('[data-composer-input="true"]'));
    }

    // The window title is "<session title> — DeepSeek Harness".
    function sessionTitle() {
      return String(document.title || '').replace(/\s+—\s+DeepSeek Harness\s*$/, '').trim();
    }

    function clickElement(element) {
      element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
      element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
      if (typeof element.click === 'function') element.click();
      else element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    function findSessionRow(title) {
      if (!title) return null;
      for (const element of findByText(title, 10)) {
        const row = element.closest('button, a, [role="button"]');
        if (row) return row;
      }
      return null;
    }

    // Session rows carry data-session-id, so the conversation we came from can be
    // addressed exactly instead of by its (possibly duplicated) title.
    function findSessionRowById(id) {
      if (!id) return null;
      let element = null;
      try {
        element = document.querySelector('[data-session-id="' + String(id).replace(/"/g, '\\"') + '"]');
      } catch (error) {
        return null;
      }
      if (!element) return null;
      return element.closest('button, a, [role="button"]') || element.parentElement || element;
    }

    function rowFor(agentId, title) {
      const byId = findSessionRowById(agentId);
      if (byId) return { row: byId, via: 'session-id' };
      const byTitle = findSessionRow(title);
      if (byTitle) return { row: byTitle, via: 'title' };
      return null;
    }

    function readFieldValue(element) {
      if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') return String(element.value == null ? '' : element.value);
      if (element.isContentEditable) return String(element.innerText == null ? element.textContent : element.innerText);
      return null;
    }

    // Type into a field the way the editor expects, then read the value back.
    // execCommand('insertText') is the only path that drives rich-text editors
    // (Lexical, Slate, ProseMirror) through their input pipeline; plain
    // textContent writes are reported as a degraded method instead of a success.
    async function typeInto(element, value, options) {
      const text = String(value == null ? '' : value);
      const clearFirst = !(options && options.clear === false);
      try {
        element.focus();
      } catch (error) {
        // focus can throw on detached nodes; the click below is the fallback
      }
      if (document.activeElement !== element) clickElement(element);
      await sleep(30);
      const before = readFieldValue(element);
      const tag = element.tagName;
      const richText =
        element.getAttribute('data-lexical-editor') === 'true' ||
        Boolean(element.closest('[data-lexical-editor="true"]'));

      // Clearing is its own path: an empty string must be judged by "the field is
      // empty", never by "the field contains the empty string" (which is always true).
      // Rich-text editors ignore some of these strategies, so try them in order and
      // re-read after each one instead of assuming the first attempt worked.
      if (text === '') {
        let usedMethod = null;
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
          if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(element, '');
          else element.value = '';
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          usedMethod = 'native-value-setter';
        } else if (element.isContentEditable) {
          const selectContents = function () {
            try {
              element.focus();
              const range = document.createRange();
              range.selectNodeContents(element);
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
            } catch (error) {
              // fall through: the next strategy may still work
            }
          };
          const strategies = [
            {
              name: 'range+execCommand-delete',
              run: function () {
                selectContents();
                document.execCommand('delete', false, null);
              },
            },
            {
              name: 'execCommand-selectAll+delete',
              run: function () {
                element.focus();
                document.execCommand('selectAll', false, null);
                document.execCommand('delete', false, null);
              },
            },
            {
              name: 'range+execCommand-insertText-empty',
              run: function () {
                selectContents();
                document.execCommand('insertText', false, '');
              },
            },
            {
              name: 'range+beforeinput-deleteContentBackward',
              run: function () {
                selectContents();
                element.dispatchEvent(new InputEvent('beforeinput', {
                  bubbles: true,
                  cancelable: true,
                  inputType: 'deleteContentBackward',
                }));
                element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
              },
            },
          ];
          for (const strategy of strategies) {
            try {
              strategy.run();
            } catch (error) {
              // try the next strategy
            }
            await sleep(140);
            if (String(readFieldValue(element) == null ? '' : readFieldValue(element)).trim() === '') {
              usedMethod = strategy.name;
              break;
            }
          }
          usedMethod = usedMethod || 'none-accepted';
        } else {
          return { ok: false, error: 'target is neither an input nor contenteditable: ' + describe(element) };
        }
        await sleep(Math.max(150, options && options.settleMs ? options.settleMs : DEFAULT_SETTLE));
        const afterClear = readFieldValue(element);
        const empty = String(afterClear == null ? '' : afterClear).trim() === '';
        return {
          ok: empty,
          node: describe(element),
          method: usedMethod,
          before: before,
          after: afterClear,
          note: empty ? undefined : 'field is not empty after clearing; the editor rejected every strategy — clear it manually or delete with act key',
        };
      }

      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const next = clearFirst ? text : String(before || '') + text;
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
        if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(element, next);
        else element.value = next;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (element.isContentEditable) {
        if (clearFirst) {
          try {
            document.execCommand('selectAll', false, null);
          } catch (error) {
            // selection is best effort
          }
        }
        let inserted = false;
        try {
          inserted = document.execCommand('insertText', false, text);
        } catch (error) {
          inserted = false;
        }
        // Give the editor a beat to commit before deciding it failed: reading too
        // early made an accept look like a reject and duplicated the text.
        await sleep(160);
        const seen = String(readFieldValue(element) || '').indexOf(text) !== -1;
        if (!seen && !richText) {
          element.textContent = clearFirst ? text : String(before || '') + text;
          element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
          inserted = false;
        }
        await sleep(options && options.settleMs ? options.settleMs : DEFAULT_SETTLE);
        const afterEditable = readFieldValue(element);
        const stuckEditable = String(afterEditable || '').indexOf(text) !== -1;
        return {
          ok: stuckEditable,
          node: describe(element),
          method: inserted ? 'execCommand-insertText' : 'textContent-fallback',
          before: before,
          after: afterEditable,
          note: stuckEditable
            ? undefined
            : 'value did not stick: the editor rejected the write (rich-text editors only accept the insertText path); verify with waitFor',
        };
      } else {
        return { ok: false, error: 'target is neither an input nor contenteditable: ' + describe(element) };
      }

      await sleep(options && options.settleMs ? options.settleMs : DEFAULT_SETTLE);
      const after = readFieldValue(element);
      const expected = clearFirst ? text : String(before || '') + text;
      const stuck = after !== null && (after.indexOf(text) !== -1 || after === expected);
      return {
        ok: stuck,
        node: describe(element),
        method: richText ? 'execCommand-insertText' : 'native-value-setter',
        before: before,
        after: after,
        note: stuck
          ? undefined
          : 'value did not stick: the component may be controlled or filter input; verify with waitFor',
      };
    }

    function pressKey(element, key) {
      const init = {
        key: key,
        code: key.length === 1 ? 'Key' + key.toUpperCase() : key,
        bubbles: true,
        cancelable: true,
      };
      element.dispatchEvent(new KeyboardEvent('keydown', init));
      element.dispatchEvent(new KeyboardEvent('keypress', init));
      element.dispatchEvent(new KeyboardEvent('keyup', init));
    }

    function snapshot() {
      const visible = function (element) { return element.offsetParent !== null; };
      return {
        title: document.title,
        inConversation: hasComposer(),
        url: location.href,
        buttons: Array.from(document.querySelectorAll('button')).filter(visible).slice(0, 12)
          .map(function (b) { return textOf(b, 24) || b.getAttribute('aria-label') || ''; }).filter(Boolean),
        headings: Array.from(document.querySelectorAll('h1, h2, h3')).filter(visible).slice(0, 8)
          .map(function (h) { return textOf(h, 40); }).filter(Boolean),
      };
    }

    let errors = [];
    function recordError(kind, detail) {
      errors.push({ kind: kind, detail: String(detail).slice(0, 600), at: Date.now() });
      if (errors.length > MAX_ERRORS) errors = errors.slice(-MAX_ERRORS);
    }

    // Open verification session, and the conversation it started from.
    let session = null;
    let idleTimer = 0;
    let autoEnded = null;

    function persistSession() {
      try {
        if (session) {
          sessionStorage.setItem(SESSION_KEY, JSON.stringify({
            origin: session.origin,
            agentId: session.agentId || null,
            startedAt: session.startedAt,
          }));
        } else {
          sessionStorage.removeItem(SESSION_KEY);
        }
      } catch (error) {
        // sessionStorage may be unavailable; recovery is then best-effort only
      }
    }

    function readPersistedSession() {
      try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (error) {
        return null;
      }
    }

    function writeLastEnd(report) {
      try {
        sessionStorage.setItem(LAST_END_KEY, JSON.stringify(report));
      } catch (error) {
        // ignore
      }
    }

    function readLastEnd() {
      try {
        const raw = sessionStorage.getItem(LAST_END_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (error) {
        return null;
      }
    }

    function clearIdle() {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = 0;
      }
    }

    function touchIdle(finish) {
      clearIdle();
      idleTimer = setTimeout(function () {
        finish({ auto: true, reason: 'idle ' + IDLE_END_MS + 'ms' });
      }, IDLE_END_MS);
    }

    async function finishSession(info) {
      if (!session) return { ok: false, error: 'no open verification session' };
      const report = {
        ok: true,
        origin: session.origin,
        startedAt: session.startedAt,
        durationMs: Date.now() - session.startedAt,
        steps: session.steps,
        snapshot: snapshot(),
        errors: errors.slice(-10),
        auto: Boolean(info && info.auto),
        reason: (info && info.reason) || 'explicit end',
      };
      let restored = null;
      if (!hasComposer()) {
        const match = rowFor(session.agentId, session.origin);
        if (match) {
          clickElement(match.row);
          await sleep(280);
          restored = {
            session: session.origin,
            agentId: session.agentId || null,
            via: match.via,
            backInConversation: hasComposer(),
          };
        } else {
          restored = {
            session: session.origin,
            agentId: session.agentId || null,
            failed: 'no sidebar row matched by session id or title',
          };
        }
      }
      report.restored = restored;
      session = null;
      clearIdle();
      persistSession();
      writeLastEnd(report);
      if (!info || !info.auto) autoEnded = null;
      return report;
    }

    async function beginSession(args) {
      if (session) return { ok: false, error: 'a verification session is already open; call end first' };
      // No opener means "verify in place": useful when the effect to check is in
      // the conversation itself (typing, a chat row, a toast).
      const wantsOpen = Boolean(String(args.openText || '').trim() || String(args.openSelector || '').trim());
      const opener = wantsOpen
        ? resolveTarget({ selector: args.openSelector || '', text: args.openText || '', limit: 20 })
        : [];
      if (wantsOpen && !opener.length) {
        return { ok: false, error: 'opener not found: ' + (args.openText || args.openSelector || '(none)') };
      }
      session = {
        origin: sessionTitle(),
        agentId: args.agentSessionId || null,
        startedAt: Date.now(),
        steps: [],
      };
      persistSession();
      if (opener.length) {
        clickElement(opener[0]);
        await sleep(args.settleMs || DEFAULT_SETTLE);
      }
      touchIdle(finishSession);
      autoEnded = null;
      return {
        ok: true,
        origin: session.origin,
        agentId: session.agentId,
        inPlace: opener.length === 0,
        opened: opener.length ? describe(opener[0]) : null,
        snapshot: snapshot(),
      };
    }

    async function waitForTarget(args) {
      const timeout = Math.max(200, Math.min(30000, args.timeoutMs || 5000));
      const started = Date.now();
      for (;;) {
        const target = resolveTarget({ selector: args.selector || '', text: args.text || '', limit: args.limit || 20 });
        if (target.length) {
          return { ok: true, found: target.length, waitedMs: Date.now() - started, node: describe(target[0]), rect: rectOf(target[0]) };
        }
        if (Date.now() - started >= timeout) {
          return { ok: false, error: 'condition not met within ' + timeout + 'ms', waitedMs: Date.now() - started };
        }
        await sleep(WAIT_POLL_MS);
      }
    }

    async function runAct(a) {
      if (!a || !a.kind) return { ok: false, error: 'act.kind is required' };
      if (a.kind === 'click') {
        const target = resolveTarget(a);
        if (!target.length) return { ok: false, error: 'click target not found' };
        clickElement(target[0]);
        await sleep(a.settleMs || DEFAULT_SETTLE);
        return { ok: true, clicked: describe(target[0]), rect: rectOf(target[0]), snapshot: snapshot() };
      }
      if (a.kind === 'waitFor') return await waitForTarget(a);
      if (a.kind === 'audit') {
        const report = audit(resolveTarget(a));
        return report.found === 0 ? { ok: false, error: 'audit target not found', report: report } : { ok: true, report: report };
      }
      if (a.kind === 'snapshot') return { ok: true, snapshot: snapshot() };
      if (a.kind === 'wait') {
        const ms = Math.max(0, Math.min(30000, a.ms || 0));
        await sleep(ms);
        return { ok: true, waitedMs: ms, snapshot: snapshot() };
      }
      if (a.kind === 'type') {
        const target = resolveTarget(a);
        if (!target.length) return { ok: false, error: 'type target not found' };
        const result = await typeInto(target[0], a.value, { clear: a.clear !== false, settleMs: a.settleMs });
        return Object.assign({}, result, { snapshot: snapshot() });
      }
      if (a.kind === 'key') {
        const target = resolveTarget(a);
        const element = target.length ? target[0] : document.activeElement;
        if (!element) return { ok: false, error: 'no key target: pass text/selector or focus a field first' };
        const key = String(a.value || a.key || '');
        if (!key) return { ok: false, error: 'key is required (for example "Enter", "Escape", "Backspace")' };
        pressKey(element, key);
        await sleep(a.settleMs || DEFAULT_SETTLE);
        return {
          ok: true,
          node: describe(element),
          key: key,
          note: 'synthetic key events do not insert text; use type for text and key for shortcuts/submits',
          snapshot: snapshot(),
        };
      }
      return { ok: false, error: 'unknown act.kind: ' + a.kind };
    }

    return {
      inject: [],
      apply(ctx) {
        const onError = function (event) {
          recordError('error', (event && event.message) || 'unknown error');
        };
        const onRejection = function (event) {
          const reason = event && event.reason;
          recordError('unhandledrejection', (reason && (reason.stack || reason.message)) || reason);
        };
        const originalConsoleError = console.error;
        console.error = function () {
          try {
            recordError('console.error', Array.prototype.map.call(arguments, String).join(' '));
          } catch (error) {
            // never let the hook break the app
          }
          return originalConsoleError.apply(console, arguments);
        };
        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onRejection);

        // A reload during a session (or a crash of the previous page) is put back
        // on the first attach, without waiting for a tool call.
        const stale = readPersistedSession();
        if (stale && (stale.origin || stale.agentId)) {
          try {
            const match = rowFor(stale.agentId, stale.origin);
            if (match) clickElement(match.row);
          } catch (error) {
            // ignore
          }
          persistSession();
          writeLastEnd({
            recoveredAfterReload: true,
            origin: stale.origin || null,
            agentId: stale.agentId || null,
            at: Date.now(),
          });
        }

        let stopped = false;
        let controller = null;
        let retryTimer = 0;
        const clientId = CLIENT_ID;

        function schedule(delay) {
          if (stopped) return;
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = setTimeout(iterate, delay);
        }

        async function handle(pending) {
          const args = pending.args || {};
          if (pending.action === 'info') {
            return { ok: true, value: { title: document.title, url: location.href, viewport: { width: window.innerWidth, height: window.innerHeight }, theme: document.documentElement.getAttribute('data-theme') || null, bodyClass: document.body.className, session: session ? { origin: session.origin, steps: session.steps.length } : null, lastEnd: readLastEnd() } };
          }
          if (pending.action === 'errors') {
            return { ok: true, value: { count: errors.length, errors: errors.slice(-(args.limit || 20)) } };
          }
          if (pending.action === 'find') {
            const matches = findByText(args.text || '', args.limit || 20);
            return { ok: true, value: { found: matches.length, nodes: matches.map(function (element) {
              return { node: describe(element), rect: rectOf(element), text: textOf(element, 120) };
            }) } };
          }
          if (pending.action === 'begin') {
            return { ok: true, value: await beginSession(args) };
          }
          if (pending.action === 'act') {
            if (!session) return { ok: false, error: 'no open verification session; call begin first' };
            const started = Date.now();
            const result = await runAct(args.act || {});
            const step = {
              n: session.steps.length + 1,
              kind: (args.act && args.act.kind) || '(none)',
              at: started,
              elapsedMs: Date.now() - started,
              result: result,
            };
            session.steps.push(step);
            touchIdle(finishSession);
            return { ok: true, value: { step: step, sessionSteps: session.steps.length, origin: session.origin } };
          }
          if (pending.action === 'end') {
            return { ok: true, value: await finishSession({ auto: false, reason: 'explicit end' }) };
          }
          if (pending.action === 'peek') {
            const opened = await beginSession(args);
            if (!opened.ok) return { ok: true, value: opened };
            const report = await runAct({ kind: 'audit', selector: args.selector, text: args.text, limit: args.limit });
            const ended = await finishSession({ auto: true, reason: 'peek' });
            return { ok: true, value: { opened: opened.opened, audit: report, restored: ended.restored, snapshot: ended.snapshot } };
          }
          if (pending.action === 'restore-origin') {
            const persisted = readPersistedSession() || {};
            const agentId = (session && session.agentId) || persisted.agentId || (args && args.agentSessionId) || null;
            const origin = (session && session.origin) || persisted.origin || null;
            if (!origin && !agentId) return { ok: false, error: 'no recorded origin session' };
            const match = rowFor(agentId, origin);
            if (!match) {
              return { ok: false, error: 'no sidebar row matched by session id or title: ' + (origin || agentId) };
            }
            clickElement(match.row);
            await sleep(280);
            return {
              ok: true,
              value: { session: origin, agentId: agentId, via: match.via, backInConversation: hasComposer() },
            };
          }
          if (pending.action === 'outline') {
            return { ok: true, value: outline(resolveTarget(args), args.limit || 20) };
          }
          return { ok: true, value: audit(resolveTarget(args)) };
        }

        async function iterate() {
          if (stopped) return;
          controller = new AbortController();
          let delay = 0;
          try {
            const response = await fetch('/dsh-ui-probe/poll?c=' + encodeURIComponent(clientId), {
              cache: 'no-store',
              signal: controller.signal,
            });
            const pending = await response.json();
            if (pending && pending.retired) {
              // A newer page generation took the bridge; stop instead of fighting it
              // for the same task (two loops releasing each other used to livelock).
              stopped = true;
              return;
            }
            if (!pending || !pending.id) {
              // No work: leave a gap before holding the next poll, so a bug cannot
              // turn this loop into a busy one.
              delay = EMPTY_GAP_MS;
              return;
            }
            let payload;
            try {
              const handled = await handle(pending);
              payload = handled.ok
                ? { id: pending.id, ok: true, value: handled.value }
                : { id: pending.id, ok: false, error: handled.error };
            } catch (error) {
              payload = { id: pending.id, ok: false, error: String((error && error.stack) || error) };
            }
            await fetch('/dsh-ui-probe/result', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            });
          } catch (error) {
            delay = RETRY_MS;
          } finally {
            controller = null;
            schedule(delay);
          }
        }

        const onVisibility = function () {
          if (document.hidden) {
            if (retryTimer) clearTimeout(retryTimer);
            if (controller) controller.abort();
            return;
          }
          schedule(0);
        };
        document.addEventListener('visibilitychange', onVisibility);
        schedule(0);

        ctx.effect(function () {
          return function () {
            stopped = true;
            clearIdle();
            if (retryTimer) clearTimeout(retryTimer);
            if (controller) controller.abort();
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('error', onError);
            window.removeEventListener('unhandledrejection', onRejection);
            console.error = originalConsoleError;
          };
        }, 'ui-probe: client loop');
      },
    };
  },
});
