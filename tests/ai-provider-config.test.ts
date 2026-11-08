import {expect,it} from 'vitest';
import {ConfigError,loadConfig} from '../src/config.ts';
const safe={PAYPAL_ENV:'sandbox',PAYPAL_API_BASE:'https://api-m.sandbox.paypal.com',PAYPAL_CLIENT_ID:'synthetic-client',PAYPAL_CLIENT_SECRET:'synthetic-secret'};
it('selects the dedicated Groq key without using the legacy Gemini alias',()=>{
 const config=loadConfig({...safe,AI_PROVIDER:' GROQ ',AI_MODEL:'openai/gpt-oss-120b',GROQ_API_KEY:'synthetic-groq',GEMINI_API_KEY:'synthetic-gemini',AI_API_KEY:'synthetic-legacy'});
 expect(config.ai.provider).toBe('groq');expect(config.ai.apiKey).toBe('synthetic-groq');
 expect(config.ai.model).toBe('openai/gpt-oss-120b');
});
it('refuses a selected Groq provider without its dedicated key',()=>{
 try{loadConfig({...safe,AI_PROVIDER:'groq',AI_MODEL:'openai/gpt-oss-120b',AI_API_KEY:'synthetic-legacy'});throw Error('Expected rejection');}
 catch(error){expect(error).toBeInstanceOf(ConfigError);expect((error as ConfigError).keys).toEqual(['GROQ_API_KEY']);expect(String(error)).not.toContain('synthetic-legacy');}
});
it('keeps keys inert until the provider is explicitly selected',()=>{
 expect(loadConfig({...safe,GROQ_API_KEY:'synthetic-groq',GEMINI_API_KEY:'synthetic-gemini'}).ai.provider).toBe('disabled');
});
