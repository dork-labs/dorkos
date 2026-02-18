import { API_BASE } from './constants';

/** Throw an error with the response status text if the response is not ok. */
async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  // 204 No Content has no body — return undefined instead of parsing JSON
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Fetch wrapper providing typed get/post/patch/delete methods against the roadmap API. */
export const apiClient = {
  /** Send a GET request to `API_BASE + path`. */
  get<T>(path: string): Promise<T> {
    return fetch(`${API_BASE}${path}`).then((res) => handleResponse<T>(res));
  },

  /** Send a POST request with a JSON body to `API_BASE + path`. */
  post<T>(path: string, body?: unknown): Promise<T> {
    return fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then((res) => handleResponse<T>(res));
  },

  /** Send a PATCH request with a JSON body to `API_BASE + path`. */
  patch<T>(path: string, body?: unknown): Promise<T> {
    return fetch(`${API_BASE}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then((res) => handleResponse<T>(res));
  },

  /** Send a DELETE request to `API_BASE + path`. */
  delete<T>(path: string): Promise<T> {
    return fetch(`${API_BASE}${path}`, {
      method: 'DELETE',
    }).then((res) => handleResponse<T>(res));
  },
};
