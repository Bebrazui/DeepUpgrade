// DeepUpgrade Background Service Worker (Manifest V3)
// Provides privileged network transport (<all_urls>) bypassing CORS & CSP for plugins and agents.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.type === 'DU_FETCH') {
    (async () => {
      try {
        const url = request.url;
        const opts = request.options || {};
        const fetchOpts = {
          method: opts.method || 'GET',
          headers: opts.headers || {},
          cache: opts.cache || 'default'
        };

        if (opts.body && fetchOpts.method !== 'GET' && fetchOpts.method !== 'HEAD') {
          fetchOpts.body = typeof opts.body === 'object' ? JSON.stringify(opts.body) : opts.body;
        }

        const controller = new AbortController();
        const timeoutMs = opts.timeout || 30000;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        fetchOpts.signal = controller.signal;

        const resp = await fetch(url, fetchOpts);
        clearTimeout(timer);

        const contentType = resp.headers.get('content-type') || '';
        const isJson = contentType.includes('application/json');
        const headers = {};
        resp.headers.forEach((v, k) => { headers[k] = v; });

        let bodyText = '';
        let base64 = null;

        if (request.responseType === 'arraybuffer' || request.responseType === 'blob') {
          const ab = await resp.arrayBuffer();
          const bytes = new Uint8Array(ab);
          let binary = '';
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
          }
          base64 = btoa(binary);
        } else {
          bodyText = await resp.text();
        }

        let parsedData = bodyText;
        if (isJson && request.responseType !== 'text') {
          try {
            parsedData = JSON.parse(bodyText);
          } catch (e) {
            parsedData = bodyText;
          }
        }

        sendResponse({
          ok: resp.ok,
          status: resp.status,
          statusText: resp.statusText,
          headers,
          data: parsedData,
          text: bodyText,
          base64
        });
      } catch (err) {
        sendResponse({
          ok: false,
          status: 0,
          statusText: err.name === 'AbortError' ? 'Timeout' : 'Network Error',
          error: err.message,
          data: null
        });
      }
    })();
    return true; // Keep message channel open for async sendResponse
  }
});
