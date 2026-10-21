/** Same-origin, read-only incident API client. The org header is a dev scope, NOT authentication. */
export const ORG_PATTERN = /^org_[a-z0-9_]{1,40}$/;
export const INCIDENT_PATTERN = /^inc_[0-9a-f-]{36}$/;
const MAX_BODY = 1_000_000;

export class ApiError extends Error {
  constructor(readonly status: number, readonly kind: 'scope' | 'not_found' | 'bad_request' | 'server' | 'network' | 'malformed', message: string) { super(message); }
}

export async function getJson(path: string, org: string, fetcher: typeof fetch = fetch): Promise<unknown> {
  if (!ORG_PATTERN.test(org)) throw new ApiError(0, 'scope', 'Organization scope must look like org_reference.');
  let response: Response;
  try {
    response = await fetcher(path, { method: 'GET', headers: { 'x-ordertruth-org': org }, cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(8000) });
  } catch {
    throw new ApiError(0, 'network', 'The local incident API did not respond. Start it with pnpm incidents --db <isolated.sqlite>.');
  }
  if (response.status === 401) throw new ApiError(401, 'scope', `No organization named ${org} exists in this database.`);
  if (response.status === 404) throw new ApiError(404, 'not_found', 'This record does not exist in the selected organization.');
  if (response.status === 400) throw new ApiError(400, 'bad_request', 'The address does not contain a valid identifier.');
  if (!response.ok) throw new ApiError(response.status, 'server', `The incident API answered HTTP ${response.status}.`);
  const text = await response.text();
  if (text.length > MAX_BODY) throw new ApiError(200, 'malformed', 'The response is larger than this console will display.');
  try { return JSON.parse(text); } catch { throw new ApiError(200, 'malformed', 'The incident API returned something that is not JSON.'); }
}
