// Minimal Vapi REST client. Every write is followed by a read-back by the
// caller: a 200 from a create is not proof the saved state is right.

const BASE = 'https://api.vapi.ai';

export function vapiClient(apiKey, { fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('VAPI_API_KEY is not set (put it in .env)');

  async function call(method, path, body) {
    const isForm = body instanceof FormData;
    const res = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Vapi ${method} ${path} failed: ${res.status} ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : null;
  }

  return {
    getAssistant: (id) => call('GET', `/assistant/${id}`),
    createAssistant: (a) => call('POST', '/assistant', a),
    updateAssistant: (id, a) => call('PATCH', `/assistant/${id}`, a),
    getTool: (id) => call('GET', `/tool/${id}`),
    createTool: (t) => call('POST', '/tool', t),
    updateTool: (id, t) => call('PATCH', `/tool/${id}`, t),
    getFile: (id) => call('GET', `/file/${id}`),
    uploadFile: (name, content, type = 'text/markdown') => {
      const form = new FormData();
      form.append('file', new Blob([content], { type }), name);
      return call('POST', '/file', form);
    },
    getPhoneNumber: (id) => call('GET', `/phone-number/${id}`),
    importTwilioNumber: (p) => call('POST', '/phone-number', p),
    chat: (body) => call('POST', '/chat', body),
  };
}
