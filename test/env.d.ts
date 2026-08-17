import type { Env as AppEnv } from '../src/types';

// `cloudflare:test` types its `env` export as `Cloudflare.Env`.
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
}

export {};
