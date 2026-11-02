// Protocol methods for secrets and environments (names without the "rigwell." prefix).
import { ErrorCodes, RpcError } from "../protocol/rpc.ts";
import { SecretsError, deleteEnvironment, deleteSecret, listEnvironments, listSecrets, setEnvironment, setSecret } from "./store.ts";

function wrap<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof SecretsError) throw new RpcError(e.kind === "not_found" ? ErrorCodes.ENTITY_NOT_FOUND : ErrorCodes.INVALID_PARAMS, e.message);
    throw e;
  }
}

/** list_secrets, set_secret, delete_secret, list_environments, set_environment, delete_environment. Results never hold a secret value. */
export function handleSecretsMethod(method: string, p: Record<string, unknown>): { handled: false } | { handled: true; result: unknown } {
  switch (method) {
    case "list_secrets": return { handled: true, result: { secrets: listSecrets() } };
    case "set_secret": return { handled: true, result: wrap(() => setSecret(p.name, p.value)) };
    case "delete_secret": return { handled: true, result: wrap(() => deleteSecret(p.name)) };
    case "list_environments": return { handled: true, result: { environments: listEnvironments() } };
    case "set_environment": return { handled: true, result: wrap(() => ({ environment: setEnvironment(p.name, p.vars, p.description) })) };
    case "delete_environment": return { handled: true, result: wrap(() => deleteEnvironment(p.name)) };
    default: return { handled: false };
  }
}
