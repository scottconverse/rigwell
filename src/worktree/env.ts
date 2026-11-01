// Secret stripping for setup and cleanup scripts (spec §18.3).
// A variable is removed when its NAME matches any of these rules:
//  1. product prefix: RIGWELL_*
//  2. contains TOKEN, SECRET, PASSWORD/PASSWD, CREDENTIAL, PRIVATE_KEY, API_KEY/APIKEY, ACCESS_KEY (case-insensitive)
//  3. database and queue connection strings: DATABASE_URL, or a name with a database-ish word ending in _URL/_URI/_DSN
//  4. cloud and provider families: AWS_, AZURE_, GCP_, GCLOUD_, GOOGLE_APPLICATION_, GITHUB_, GH_, GITLAB_,
//     NPM_CONFIG_, and model providers (ANTHROPIC_, OPENAI_, GEMINI_, MISTRAL_, GROQ_, OPENROUTER_, HF_, HUGGINGFACE_)
//  5. agent sockets: SSH_AUTH_SOCK, SSH_AGENT_PID, GPG_AGENT_INFO
// Everything else (PATH, HOME, ordinary config) is kept.
const NAME_PARTS = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_?KEY|ACCESS_KEY)/i;
const DB_URL = /(^DATABASE_URL$|(DATABASE|(^|_)DB|REDIS|MONGO|POSTGRES|PG|MYSQL|MARIADB|AMQP|RABBITMQ|KAFKA|ELASTIC)\w*_(URL|URI|DSN)$)/i;
const FAMILIES = /^(RIGWELL_|AWS_|AZURE_|GCP_|GCLOUD_|GOOGLE_APPLICATION_|GITHUB_|GH_|GITLAB_|NPM_CONFIG_|ANTHROPIC_|OPENAI_|GEMINI_|MISTRAL_|GROQ_|OPENROUTER_|HF_|HUGGINGFACE_)/i;
const AGENTS = /^(SSH_AUTH_SOCK|SSH_AGENT_PID|GPG_AGENT_INFO)$/;

export function isSecretName(name: string): boolean {
  return FAMILIES.test(name) || NAME_PARTS.test(name) || DB_URL.test(name) || AGENTS.test(name);
}

export function stripSecrets(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !isSecretName(k)) out[k] = v;
  return out;
}
