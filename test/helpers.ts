import { PersonalAgent, type Company } from '../agent/personal-agent.ts';
import { ClientResolver, SessionVerifier } from '../src/poppy/session.ts';

/** A Personal Agent whose metadata is served from memory, plus a verifier wired to it. */
export function offlineAgent(opts: { supportsOperations?: boolean } = {}) {
  const agent = new PersonalAgent(opts);
  agent.base = 'https://agent.example';
  agent.clientId = 'https://agent.example/agent.json';
  const docs: Record<string, unknown> = {
    'https://agent.example/agent.json': agent.metadata(),
    'https://agent.example/jwks.json': { keys: [{ ...agent.root.publicJwk, kid: agent.rootKid, alg: 'ES256' }] },
  };
  const fetchJson = async (url: string) => {
    if (!(url in docs)) throw new Error(`404 ${url}`);
    return docs[url];
  };
  const company: Company = { base: 'https://shop.example', identifier: 'https://shop.example', poppy: {} };
  const verifier = new SessionVerifier({
    audience: 'https://shop.example',
    resolver: new ClientResolver({ policy: { allowInsecureLoopback: false }, fetchJson }),
  });
  return { agent, company, verifier, docs };
}
