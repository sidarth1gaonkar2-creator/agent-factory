// Twilio: find and buy a local number, and add it to the A2P messaging
// service so texts from it are covered by the approved campaign.

export function twilioClient(accountSid, authToken, { fetchImpl = fetch } = {}) {
  if (!accountSid || !authToken) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set (put them in .env)');
  const auth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  async function call(method, url, form) {
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: auth, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Twilio ${method} ${url.replace(/AC[0-9a-f]{32}/, 'AC…')} failed: ${res.status} ${text.slice(0, 400)}`);
    return JSON.parse(text);
  }

  const api = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`;
  return {
    async searchLocal(areaCode) {
      const q = new URLSearchParams({ AreaCode: areaCode, VoiceEnabled: 'true', SmsEnabled: 'true', PageSize: '5' });
      const r = await call('GET', `${api}/AvailablePhoneNumbers/US/Local.json?${q}`);
      return r.available_phone_numbers.map((n) => n.phone_number);
    },
    buy: (phoneNumber, friendlyName) =>
      call('POST', `${api}/IncomingPhoneNumbers.json`, { PhoneNumber: phoneNumber, FriendlyName: friendlyName }),
    findOwned: async (phoneNumber) => {
      const r = await call('GET', `${api}/IncomingPhoneNumbers.json?${new URLSearchParams({ PhoneNumber: phoneNumber })}`);
      return r.incoming_phone_numbers[0] ?? null;
    },
    addToMessagingService: (serviceSid, phoneSid) =>
      call('POST', `https://messaging.twilio.com/v1/Services/${serviceSid}/PhoneNumbers`, { PhoneNumberSid: phoneSid }),
  };
}
