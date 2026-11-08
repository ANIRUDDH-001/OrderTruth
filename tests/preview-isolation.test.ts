import { expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertDeploymentTarget } from '../scripts/preview-isolation.ts';
it('blocks preview and unknown Vercel builds before public packaging', () => {
  for (const env of [{ VERCEL_ENV: 'preview' },{ VERCEL_ENV: 'development' },{ VERCEL: '1' },{ VERCEL_ENV: 'staging' }]) {
    expect(() => assertDeploymentTarget(env)).toThrow(/Preview API isolation/);
  }
  expect(() => assertDeploymentTarget({ VERCEL: '1',VERCEL_ENV: 'production' })).not.toThrow();
  expect(() => assertDeploymentTarget({})).not.toThrow();
});

it('keeps the unhosted integration candidate out of automatic Vercel deployments', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
  // Unspecified branches retain Vercel's documented default. In particular,
  // this must not disable main, broadly change hosting, or bypass manual checks.
  expect(config.git?.deploymentEnabled).toEqual({
    'integration/ordertruth-unified': false,
    'phase6/adversarial-qualification': false,
    'phase7/ai-integration': false,
    'phase8/product-flow': false,
  });
  expect(config.git?.deploymentEnabled?.main).toBeUndefined();
  expect(config.buildCommand).toBe('pnpm build:frontend');
  expect(() => assertDeploymentTarget({ VERCEL: '1',VERCEL_ENV: 'preview' })).toThrow(/Preview API isolation/);
  expect(() => assertDeploymentTarget({ VERCEL: '1',VERCEL_ENV: 'production' })).not.toThrow();
});
