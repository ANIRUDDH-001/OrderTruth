import { expect,it } from 'vitest';
import { assertLocalDatabase,requestRecord } from '../scripts/qualification-safety.ts';
it('rejects hosted URLs, alternate credentials/ports/databases and URL overrides before connecting', () => {
  for (const url of ['postgresql://ordertruth_dev:pw@neon.tech:55432/ordertruth','postgresql://ordertruth_dev:pw@127.0.0.1:5432/ordertruth',
    'postgresql://other:pw@127.0.0.1:55432/ordertruth','postgresql://ordertruth_dev:pw@127.0.0.1:55432/owner',
    'postgresql://ordertruth_dev:pw@127.0.0.1:55432/ordertruth?host=neon.tech']) expect(() => assertLocalDatabase(url)).toThrow();
  expect(() => assertLocalDatabase('postgresql://ordertruth_dev:pw@127.0.0.1:55432/ordertruth')).not.toThrow();
});
it('keeps only safe correlation metadata, never raw URLs, headers or bodies', () => {
  expect(requestRecord('GET','/api/scenarios/:runId',200,'a45b63c0-58df-4ff7-a16a-f37208cad817',4)).toEqual({
    method: 'GET',route: '/api/scenarios/:runId',status: 200,requestId: 'a45b63c0-58df-4ff7-a16a-f37208cad817',elapsedMs: 4 });
});
