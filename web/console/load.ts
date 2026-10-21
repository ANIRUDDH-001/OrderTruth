/** Incident detail loader: one scoped GET, parsed through the evidence boundary. Never substitutes other data on failure. */
import { getJson, ApiError, INCIDENT_PATTERN } from './api.ts';
import { parseDetail, type Detail } from './model.ts';

export async function fetchDetail(id: string, org: string, fetcher: typeof fetch = fetch): Promise<Detail> {
  if (!INCIDENT_PATTERN.test(id)) throw new ApiError(400, 'bad_request', 'The address does not contain a valid incident identifier.');
  const detail = parseDetail(await getJson(`/api/incidents/${encodeURIComponent(id)}`, org, fetcher), org);
  if (detail.view.id !== id) throw Error('The API returned a different incident; nothing is shown.');
  return detail;
}
