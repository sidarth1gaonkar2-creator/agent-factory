// Minimal stand-in for the canonical Worker, used by tests and the fixture
// dry run. The real one is the canonical Worker code (see README).
// @factory:client-config:start
const BUSINESS_NAME = 'Canonical';
const SERVICES = {};
// @factory:client-config:end

export default {
  async fetch(request, env) {
    if (request.headers.get('x-vapi-secret') !== env.VAPI_TOOL_SECRET) return new Response('unauthorized', { status: 401 });
    return Response.json({ business: BUSINESS_NAME, services: SERVICES, prefix: EVENT_PREFIX, tz: TZ });
  },
};
