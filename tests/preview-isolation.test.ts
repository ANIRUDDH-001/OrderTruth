import { expect,it } from 'vitest';
import { assertDeploymentTarget } from '../scripts/preview-isolation.ts';
it('blocks preview and unknown Vercel builds before public packaging', () => {
  for (const env of [{ VERCEL_ENV: 'preview' },{ VERCEL_ENV: 'development' },{ VERCEL: '1' },{ VERCEL_ENV: 'staging' }]) {
    expect(() => assertDeploymentTarget(env)).toThrow(/Preview API isolation/);
  }
  expect(() => assertDeploymentTarget({ VERCEL: '1',VERCEL_ENV: 'production' })).not.toThrow();
  expect(() => assertDeploymentTarget({})).not.toThrow();
});
