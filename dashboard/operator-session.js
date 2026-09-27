'use strict';

/** Owns the short-lived operator cookie/CSRF session without exposing its token. */
export function createOperatorSession({ fetchImpl = (...args) => fetch(...args), onChange = () => {} } = {}) {
  let csrfToken = null;
  let bootstrapPromise = null;
  let renewalPromise = null;

  const setCsrfToken = (value) => {
    csrfToken = value;
    onChange(csrfToken !== null);
  };

  const rawRequest = async (path, { method = 'GET', body, serializedBody, csrf = false, csrfValue, signal } = {}) => {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf) headers['x-csrf-token'] = csrfValue ?? '';
    const response = await fetchImpl(path, {
      method,
      credentials: 'same-origin',
      headers,
      ...(signal ? { signal } : {}),
      ...(body === undefined ? {} : { body: serializedBody ?? JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(data.error ?? `Request failed (${response.status})`), {
        status: response.status,
        data,
      });
    }
    return data;
  };

  async function establishSession() {
    const session = await rawRequest('/api/session', { method: 'POST', body: {} });
    if (typeof session.csrfToken !== 'string' || session.csrfToken.length === 0) {
      throw new Error('operator_session_invalid');
    }
    setCsrfToken(session.csrfToken);
    return session;
  }

  function bootstrap() {
    if (csrfToken !== null) return Promise.resolve(true);
    if (!bootstrapPromise) {
      bootstrapPromise = establishSession().then(() => true).finally(() => { bootstrapPromise = null; });
    }
    return bootstrapPromise;
  }

  function renewSession() {
    if (!renewalPromise) {
      renewalPromise = establishSession().finally(() => { renewalPromise = null; });
    }
    return renewalPromise;
  }

  async function request(path, options = {}) {
    if (path === '/api/session') return rawRequest(path, options);
    if (csrfToken === null) throw new Error('operator_session_required');
    const requestOptions = options.body === undefined ? options : {
      ...options,
      serializedBody: JSON.stringify(options.body),
    };
    const sentToken = csrfToken;
    try {
      return await rawRequest(path, { ...requestOptions, csrfValue: sentToken });
    } catch (error) {
      if (error?.status !== 401) throw error;
      if (csrfToken === sentToken) setCsrfToken(null);
      if (csrfToken === null) await renewSession();
      const retryToken = csrfToken;
      try {
        return await rawRequest(path, { ...requestOptions, csrfValue: retryToken });
      } catch (retryError) {
        if (retryError?.status === 401 && csrfToken === retryToken) setCsrfToken(null);
        throw retryError;
      }
    }
  }

  return { bootstrap, request, isReady: () => csrfToken !== null };
}
