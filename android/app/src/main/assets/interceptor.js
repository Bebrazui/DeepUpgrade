// DeepUpgrade Network Guardian, Autonomous PoW Solver & Direct API Engine
(function() {
  const isTelemetryBlocked = () => {
    return localStorage.getItem('du_block_telemetry') !== 'false';
  };

  // State Store: Dynamic credentials & active session
  window.__DU_NETWORK_CONTEXT__ = {
    token: null,
    chatSessionId: null,
    lastParentMessageId: null,
    headers: {},
    powModule: null
  };

  // 1. Dynamic Discovery of Rspack/Webpack PoW Solver Module
  function getDynamicPowSolver() {
    if (window.__DU_NETWORK_CONTEXT__.powModule) {
      return window.__DU_NETWORK_CONTEXT__.powModule;
    }

    try {
      const chunkHolder = window.rspackChunk_deepseek_chat || window.webpackChunk_deepseek_chat;
      if (chunkHolder && Array.isArray(chunkHolder)) {
        let found = null;
        chunkHolder.push([[Math.random()], {}, (req) => {
          for (const id in req.m) {
            const str = req.m[id].toString();
            // Match solver by exported solver methods & Worker instantiation
            if ((str.includes('powSolveChallengeStart') || str.includes('pow-challenge')) && str.includes('Worker')) {
              found = req(id);
              break;
            }
          }
        }]);
        if (found && (found.gx || found.doSolveChallenge)) {
          window.__DU_NETWORK_CONTEXT__.powModule = found;
          return found;
        }
      }
    } catch(e) {
      console.warn('[DeepUpgrade PoW Discovery Warning]', e);
    }
    return null;
  }

  // 2. Dynamic Token & Session ID Extraction
  function getAuthToken() {
    if (window.__DU_NETWORK_CONTEXT__.token) return window.__DU_NETWORK_CONTEXT__.token;

    // Check sessionStorage from previous captured snapshot
    try {
      const snap = JSON.parse(sessionStorage.getItem('du_last_api_snapshot') || '{}');
      const auth = snap?.headers?.['authorization'] || snap?.headers?.['Authorization'];
      if (auth) {
        window.__DU_NETWORK_CONTEXT__.token = auth.replace(/^Bearer\s+/i, '');
        return window.__DU_NETWORK_CONTEXT__.token;
      }
    } catch(e) {}

    // Check localStorage (common user store in SPA)
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        const val = localStorage.getItem(key) || '';
        if (val.includes('userToken') || val.includes('token') || val.includes('Bearer')) {
          try {
            const parsed = JSON.parse(val);
            const tokenCand = parsed.token || parsed.userToken || parsed.value?.token || parsed.state?.userToken || parsed.state?.token;
            if (tokenCand && typeof tokenCand === 'string') {
              window.__DU_NETWORK_CONTEXT__.token = tokenCand.replace(/^Bearer\s+/i, '');
              return window.__DU_NETWORK_CONTEXT__.token;
            }
          } catch(err) {
            // Check direct token match
            if (val.startsWith('Bearer ') || val.length > 50) {
              window.__DU_NETWORK_CONTEXT__.token = val.replace(/^Bearer\s+/i, '');
              return window.__DU_NETWORK_CONTEXT__.token;
            }
          }
        }
      }
    } catch(e) {}
    return null;
  }

  function getCurrentChatSessionId() {
    if (window.__DU_NETWORK_CONTEXT__.chatSessionId) return window.__DU_NETWORK_CONTEXT__.chatSessionId;
    const match = window.location.pathname.match(/\/s\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  // 3. Autonomous On-Demand PoW Generation
  async function solveFreshPow(targetPath = "/api/v0/chat/completion") {
    const token = getAuthToken();
    if (!token) throw new Error('Auth token not available yet. Please send a message or log in.');

    const chalResp = await origFetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ target_path: targetPath })
    });

    const chalJson = await chalResp.json();
    const rawChal = chalJson?.data?.biz_data?.challenge;
    if (!rawChal) throw new Error('Failed to acquire PoW challenge from server: ' + JSON.stringify(chalJson));

    const solver = getDynamicPowSolver();
    if (!solver || (!solver.gx && !solver.doSolveChallenge)) {
      throw new Error('Native DeepSeek PoW solver module not found in runtime.');
    }

    const normalized = {
      algorithm: rawChal.algorithm,
      challenge: rawChal.challenge,
      salt: rawChal.salt,
      signature: rawChal.signature,
      difficulty: rawChal.difficulty,
      expireAt: rawChal.expire_at,
      expireAfter: rawChal.expire_after,
      targetPath: rawChal.target_path || targetPath
    };

    const solveFn = solver.gx || solver.doSolveChallenge;
    const solved = await solveFn(normalized, { info: () => {}, error: () => {}, withError: (e) => e });

    return btoa(JSON.stringify({
      algorithm: rawChal.algorithm,
      challenge: rawChal.challenge,
      salt: rawChal.salt,
      answer: solved.challengeResponse.answer,
      signature: rawChal.signature,
      target_path: rawChal.target_path || targetPath
    }));
  }

  // Native DeepSeek React Fiber Submit Invoker
  function getNativeReactSubmit() {
    const textarea = document.querySelector('textarea');
    if (!textarea) return null;
    const key = Object.keys(textarea).find(k => k.startsWith('__reactFiber$'));
    if (!key) return null;
    let fiber = textarea[key];
    while (fiber) {
      if (fiber.memoizedProps && typeof fiber.memoizedProps.onSubmit === 'function') {
        return fiber.memoizedProps.onSubmit;
      }
      fiber = fiber.return;
    }
    return null;
  }

  // 4. Universal Autonomous Network API Dispatcher
  window.__du_send_network_message = async function(promptText, onChunk = null) {
    if (!promptText || typeof promptText !== 'string') {
      throw new Error("Prompt text is required");
    }

    // PRIMARY PATH: Native React Fiber Chat Controller Dispatch
    // This executes official DeepSeek state machine, handles PoW, updates React Store & live UI bubbles!
    const nativeSubmit = getNativeReactSubmit();
    if (nativeSubmit) {
      console.log('%c[DeepUpgrade Transport] ⚡ Отправка через нативный React Chat Controller...', 'color: #10b981; font-weight: bold;');
      try {
        await nativeSubmit(promptText, {
          thinkingEnabled: false,
          searchEnabled: false,
          uploadFileSupported: false,
          source: 'deepupgrade'
        });
        console.log('%c[DeepUpgrade Transport] ✅ Нативный submit успешно выполнен, UI синхронизирован!', 'color: #4ade80; font-weight: bold;');
        return { success: true, mode: 'native_react' };
      } catch (submitErr) {
        console.warn('[DeepUpgrade Transport] Native submit failed, falling back to direct network API:', submitErr);
      }
    }

    // SECONDARY PATH: Direct /api/v0/chat/completion HTTP Call
    const token = getAuthToken();
    const sessionId = getCurrentChatSessionId();
    const parentMsgId = window.__DU_NETWORK_CONTEXT__.lastParentMessageId || null;

    if (!token) throw new Error('Token is missing');
    if (!sessionId) throw new Error('Not in an active chat session (URL has no /s/id)');

    console.log('%c[DeepUpgrade Direct API] ⚡ Вычисляем свежий PoW...', 'color: #38bdf8;');
    const powHeader = await solveFreshPow("/api/v0/chat/completion");

    console.log('%c[DeepUpgrade Direct API] 🚀 Отправка в /api/v0/chat/completion...', 'color: #10b981;');
    const response = await origFetch('https://chat.deepseek.com/api/v0/chat/completion', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`,
        'x-client-platform': 'web',
        'x-client-version': '2.7.0',
        'x-ds-pow-response': powHeader
      },
      body: JSON.stringify({
        chat_session_id: sessionId,
        parent_message_id: parentMsgId,
        model_type: null,
        prompt: promptText,
        ref_file_ids: [],
        thinking_enabled: false
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText}`);
    }

    // Inform user in console that LLM accepted and is generating
    console.log('%c[DeepUpgrade Direct API] 📡 Сервер принял запрос, чтение потока ответа...', 'color: #a855f7; font-weight: bold;');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      fullText += chunk;
      
      // Real-time harvest of newly generated response_message_id for seamless linear branching!
      if (chunk.includes('response_message_id')) {
        const idMatch = chunk.match(/"response_message_id"\s*:\s*(\d+)/);
        if (idMatch) {
          window.__DU_NETWORK_CONTEXT__.lastParentMessageId = parseInt(idMatch[1], 10);
          console.log('%c[DeepUpgrade Direct API] 🔗 Следующий parent_message_id обновлен на:', 'color: #38bdf8;', window.__DU_NETWORK_CONTEXT__.lastParentMessageId);
        }
      }

      if (typeof onChunk === 'function') onChunk(chunk);
    }

    console.log('%c[DeepUpgrade Direct API] 🏁 Ответ модели полностью получен по сети!', 'color: #4ade80; font-weight: bold;');

    // Trigger visual sync on DeepSeek page so UI updates message list
    setTimeout(() => {
      // Dispatch soft navigation / history sync event
      window.dispatchEvent(new CustomEvent('du_network_message_finished', { detail: { sessionId } }));
      // Also trigger a gentle click on active session in sidebar if present
      const activeNav = document.querySelector('div[class*="active"][class*="session"], div[aria-selected="true"]');
      if (activeNav) activeNav.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, 100);

    return fullText;
  };

  // Bridge: Handle Direct Network Send requests from content script
  window.addEventListener('message', async (ev) => {
    if (ev.data && ev.data.type === 'DU_NETWORK_SEND_MESSAGE') {
      const { reqId, text } = ev.data;
      try {
        const streamResult = await window.__du_send_network_message(text);
        window.postMessage({
          type: 'DU_NETWORK_SEND_RESULT',
          reqId,
          success: true,
          result: streamResult
        }, '*');
      } catch(err) {
        window.postMessage({
          type: 'DU_NETWORK_SEND_RESULT',
          reqId,
          success: false,
          error: err.message
        }, '*');
      }
    }
  });
  window.__du_test_direct_api = async function(msg = "Тестовый запрос через динамический PoW") {
    try {
      console.log(`%c[Test Direct API] Отправляем: "${msg}"`, 'color: #f59e0b; font-weight: bold;');
      let textAcc = '';
      const result = await window.__du_send_network_message(msg, (chunk) => {
        textAcc += chunk;
      });
      console.log('%c[Test Direct API] ✅ Полный стрим получен!', 'color: #4ade80; font-weight: bold;');
      return result;
    } catch(e) {
      console.error('[Test Direct API Error]:', e);
    }
  };

  // 1. Hook window.fetch
  const origFetch = window.fetch;
  window.fetch = async function(resource, init) {
    try {
      let url = '';
      let method = 'GET';
      let reqBody = init && init.body;
      let rawHeaders = (init && init.headers) || {};

      if (typeof resource === 'string') {
        url = resource;
      } else if (resource instanceof Request) {
        url = resource.url;
        method = resource.method;
        if (!reqBody) {
          try {
            // Clone to avoid locking body stream
            const cloned = resource.clone();
            reqBody = await cloned.text();
          } catch(e) {}
        }
        if (!init || !init.headers) {
          rawHeaders = resource.headers;
        }
      } else if (resource && resource.url) {
        url = resource.url;
      }

      if (init && init.method) method = init.method;

      // Always harvest authorization header from ANY outgoing fetch request!
      const anyAuth = rawHeaders instanceof Headers 
        ? (rawHeaders.get('authorization') || rawHeaders.get('Authorization'))
        : (rawHeaders['authorization'] || rawHeaders['Authorization']);
      if (anyAuth && typeof anyAuth === 'string') {
        window.__DU_NETWORK_CONTEXT__.token = anyAuth.replace(/^Bearer\s+/i, '');
      }

      // Check if this is chat completion, create message, or session call
      const isChatCandidate = url.includes('/chat') || url.includes('/completion') || url.includes('/message') || url.includes('/conversation');
      if (isChatCandidate && !url.includes('/telemetry')) {
        try {
          let parsedBody = null;
          let isStringBody = typeof reqBody === 'string';
          if (isStringBody) {
            try { parsedBody = JSON.parse(reqBody); } catch(e) { parsedBody = reqBody; }
          } else {
            parsedBody = reqBody;
          }

          let headerObj = {};
          if (rawHeaders instanceof Headers) {
            rawHeaders.forEach((v, k) => { headerObj[k] = v; });
          } else if (typeof rawHeaders === 'object' && rawHeaders !== null) {
            headerObj = { ...rawHeaders };
          }

          // If this is a user message being sent and Agent mode is active
          if (parsedBody && typeof parsedBody.prompt === 'string') {
            const rawPrompt = parsedBody.prompt.trim();
            const isAgentActive = localStorage.getItem('du_agent_enabled') !== 'false';
            
            // Check if prompt already has system directive or is a sandbox output
            const hasDirectiveAlready = rawPrompt.includes('[SYSTEM CAPABILITY:') || rawPrompt.includes('[SYSTEM INSTRUCTION:');
            const isSandboxOutput = rawPrompt.startsWith('[SANDBOX OUTPUT');
            
            // Only inject system prompt if session has no parent (first turn) and not already injected
            const isFirstTurn = !parsedBody.parent_message_id && !window.__DU_NETWORK_CONTEXT__.lastParentMessageId;

            if (isAgentActive && isFirstTurn && !hasDirectiveAlready && !isSandboxOutput) {
              console.log('%c[DeepUpgrade Sniffer] 🛡️ Применяем агентский системный промпт (первое сообщение сессии)!', 'color: #3b82f6; font-weight: bold;');
              
              // Get directive generator from content script or fallback
              const getSysDirective = window.__DU_GET_SYSTEM_DIRECTIVE__ || (() => {
                return `[SYSTEM INSTRUCTION: OPENCODE AUTONOMOUS AGENT ACTIVE]\nYou are DeepUpgrade, an autonomous AI software engineer with direct access to an in-browser WebAssembly sandbox (POSIX Shell, VFS /, Python 3, JS Runner).\n\nTOOL USAGE MATRIX:\n- "write": MUST be used whenever creating or completely writing any file. Never use bash echo or python open.\n- "edit": Surgical string replacement in existing files (exact old_str match).\n- "read": Read file contents with line offset/limit.\n- "glob": Search files by pattern.\n- "grep": Search file contents.\n- "bash": Running shell commands, git, directory inspections.\n- "python": Data analysis, computing, generating charts.\n- "js": Async network and API requests.\n- "question": Interactive user clarification options.\n- "todowrite": Create/update structured task list when task has multiple steps (todos: [{content, status}]).\n- "install_skill": Register persistent workflows.\n\nEXECUTION PROTOCOL:\n1. Call ONLY ONE \`\`\`json:tool block per response.\n2. STOP immediately after closing the tool block and wait for [SANDBOX OUTPUT].\n3. No conversational filler before tools. Directly invoke the tool.\n\n`;
              });

              parsedBody.prompt = `${getSysDirective()}\n\n[USER REQUEST]: ${rawPrompt}`;

              // Mutate the outgoing request body transparently
              const newBodyStr = JSON.stringify(parsedBody);
              if (resource instanceof Request) {
                // Reconstruct Request with mutated body
                arguments[0] = new Request(resource, { body: newBodyStr });
              } else if (init) {
                init.body = newBodyStr;
              }
            }
          }

          // If this request has prompt or content or session
          if (parsedBody && (parsedBody.prompt !== undefined || parsedBody.messages !== undefined || parsedBody.content !== undefined || parsedBody.chat_session_id !== undefined)) {
            // Autoharvest active credentials and IDs dynamically!
            const authHdr = headerObj['authorization'] || headerObj['Authorization'];
            if (authHdr) {
              window.__DU_NETWORK_CONTEXT__.token = authHdr.replace(/^Bearer\s+/i, '');
            }
            if (parsedBody.chat_session_id) {
              window.__DU_NETWORK_CONTEXT__.chatSessionId = parsedBody.chat_session_id;
            }
            // Only update parent_message_id if not already tracking response sequence
            if (parsedBody.parent_message_id !== undefined && !window.__DU_NETWORK_CONTEXT__.lastParentMessageId) {
              window.__DU_NETWORK_CONTEXT__.lastParentMessageId = parsedBody.parent_message_id;
            }

            window.__DU_API_SNAPSHOT__ = {
              url: url,
              method: method,
              headers: headerObj,
              body: parsedBody,
              capturedAt: new Date().toISOString()
            };

            sessionStorage.setItem('du_last_api_snapshot', JSON.stringify(window.__DU_API_SNAPSHOT__));

            console.log(
              '%c[DeepUpgrade Sniffer] 📸 Captured & Harvested Live Credentials!',
              'background: #10b981; color: black; font-weight: bold; padding: 4px 10px; border-radius: 4px; font-size: 13px;',
              { sessionId: window.__DU_NETWORK_CONTEXT__.chatSessionId, hasToken: !!window.__DU_NETWORK_CONTEXT__.token }
            );
          }
        } catch(err) {
          console.warn('[DeepUpgrade Sniffer Parsing Error]', err);
        }
      }

      if (url.includes('/api/v0/telemetry') || url.includes('/telemetry')) {
        if (isTelemetryBlocked()) {
          // Block telemetry seamlessly without breaking web app flow
          return new Response(JSON.stringify({ code: 0, msg: "ok", data: null }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    } catch(err) {}
    return origFetch.apply(this, arguments);
  };

  // 2. Hook navigator.sendBeacon (frequently used for analytics & telemetry)
  if (navigator && navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function(url, data) {
      if (typeof url === 'string' && (url.includes('/api/v0/telemetry') || url.includes('/telemetry'))) {
        if (isTelemetryBlocked()) {
          return true;
        }
      }
      return origBeacon.apply(this, arguments);
    };
  }

  // 3. Hook XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__url = url;
    return origOpen.apply(this, arguments);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(body) {
    if (this.__url && (this.__url.includes('/api/v0/telemetry') || this.__url.includes('/telemetry'))) {
      if (isTelemetryBlocked()) {
        Object.defineProperty(this, 'status', { value: 200, writable: false });
        Object.defineProperty(this, 'readyState', { value: 4, writable: false });
        Object.defineProperty(this, 'responseText', { value: '{"code":0,"msg":"ok"}', writable: false });
        this.dispatchEvent(new Event('load'));
        return;
      }
    }
    return origSend.apply(this, arguments);
  };

  console.log('%c[DeepUpgrade] Telemetry Guardian Active', 'background: #10b981; color: white; padding: 2px 6px;');
})();
