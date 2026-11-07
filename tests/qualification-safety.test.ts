import { expect,it } from 'vitest';
import { assertLocalDatabase,assertPostgresTestTarget,requestRecord } from '../scripts/qualification-safety.ts';
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

it('admits only the explicitly identified GitHub disposable service without relaxing local ownership', () => {
  const runtime = { CI: 'true',GITHUB_ACTIONS: 'true',RUNNER_OS: 'Linux',GITHUB_REPOSITORY: 'ANIRUDDH-001/OrderTruth' };
  const database = { DATABASE_URL: 'postgresql://ordertruth_ci:disposable@127.0.0.1:55432/ordertruth',PGHOST: '127.0.0.1',PGPORT: '55432',PGDATABASE: 'ordertruth',PGUSER: 'ordertruth_ci',PGPASSWORD: 'disposable' };
  expect(assertPostgresTestTarget(database,runtime)).toBe('github-service');
  for (const change of [{ GITHUB_ACTIONS: '' },{ CI: '' },{ RUNNER_OS: 'Windows' },{ GITHUB_REPOSITORY: 'other/repo' }]) {
    expect(() => assertPostgresTestTarget(database,{ ...runtime,...change })).toThrow();
  }
  for (const change of [{ DATABASE_URL: database.DATABASE_URL.replace('127.0.0.1','neon.tech') },
    { DATABASE_URL: database.DATABASE_URL+'?host=neon.tech' },{ PGUSER: 'owner' },{ PGPORT: '5432' },{ PGPASSWORD: 'different' }]) {
    expect(() => assertPostgresTestTarget({ ...database,...change },runtime)).toThrow();
  }
});
