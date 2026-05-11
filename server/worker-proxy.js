// Cloudflare Worker: monero-proxy.rosawands4.workers.dev
//
// Validates Turnstile token before forwarding requests to the VPS.
// Set these environment variables in the Worker dashboard:
//   NODE_SECRET    — shared secret for nginx header validation
//   TURNSTILE_KEY  — Turnstile secret key (set in Cloudflare dashboard)

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': 'https://monero-web.com',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Turnstile-Token',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Validate Turnstile token
    const token = request.headers.get('X-Turnstile-Token') || '';
    if (!token) {
      return jsonResponse(403, { error: 'Missing verification token' });
    }

    const turnstileOk = await verifyTurnstile(token, env.TURNSTILE_KEY || '');
    if (!turnstileOk) {
      return jsonResponse(403, { error: 'Verification failed' });
    }

    // Forward to VPS
    const url = new URL(request.url);
    url.hostname = 'node.monero-web.com';
    url.protocol = 'https:';

    const newHeaders = new Headers(request.headers);
    newHeaders.set('X-Worker-Secret', env.NODE_SECRET || '');
    newHeaders.set('Host', 'node.monero-web.com');
    newHeaders.delete('X-Turnstile-Token');

    const newRequest = new Request(url.toString(), {
      method: request.method,
      headers: newHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      redirect: 'manual',
    });

    const response = await fetch(newRequest);

    // Add CORS headers to response
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Access-Control-Allow-Origin', 'https://monero-web.com');
    return newResponse;
  },
};

async function verifyTurnstile(token, secretKey) {
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(token)}`,
    });
    const data = await resp.json();
    return data.success === true;
  } catch (e) {
    return false;
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://monero-web.com',
    },
  });
}
