// Copied from model-setup-kit 869cdf5. Do not edit here; change the kit and copy again.
/*
  Every user-facing sentence the kit owns. A host passes its own `appName`;
  the default is "this app". Placeholders are `{appName}` and `{name}`.
*/

export const COPY = {
  checkAgain: "Check again",
  checking: "Checking…",
  refresh: "Refresh",

  ollamaNotRunning:
    "Ollama is not running on this machine. {appName} uses Ollama for local and hosted models. Without it, {appName} uses paid models. Install Ollama from ollama.com, then press Check again.",
  ollamaSignInLabel: "Sign in to Ollama",
  ollamaSignInLinkLine: "Open this link to sign in to ollama.com. You can skip this step.",
  ollamaNoSignin: "This Ollama version has no sign-in. You can skip this step.",
  ollamaSignedIn: "Signed in",

  firstRunCardTitle: "Choose your writing model",
  firstRunCardNote:
    "Nothing is loaded in LM Studio or Ollama right now, so {appName} has not picked a model for you. Choose one of the models below, or keep the Automatic ladder.",
  firstRunKeepAutomatic: "Keep the Automatic ladder",
  firstRunNoServer:
    "No local server found on this machine. Start LM Studio's server or Ollama, then click Refresh.",

  useLoadedRecommended: "Use whatever model is loaded (recommended)",
  useThisOne: "Use this one",
  showAll: "Show all {count}",
  showFewer: "Show fewer",
  noChatModels: "No chat models found.",
  localListRefreshed: "Local model list refreshed.",
  noLocalServer: "No local server found on this machine.",
  cloudSpendsCredits: "cloud — spends credits",

  signInStarting: "Starting…",
  signInWaitingForLink: "Waiting for {name} to print its link…",
  signInOpenLink: "Open this page and finish the sign-in there. It opens in a new tab.",
  signInEnterCode: "Enter this one-time code",
  signInCopyCode: "Copy code",
  signInCopied: "Copied",
  signInCancel: "Cancel",
  signInStopping: "Stopping…",
  signInDone: "{name} is signed in.",
  signInExpired: "That link ran out of time before anyone finished the sign-in.",
  signInNotInstalled: "{name} is not installed on this machine.",
  signInNotInstalledPath: "{name} was not found on this machine.",

  installedWord: "Installed",
  notInstalledWord: "Not installed",
  signedInAs: "Signed in as {account}",
  signedInWord: "Signed in",
  notSignedInWord: "Not signed in",

  connectionNameHelp: "A name for you to recognize it by, such as Gemini or My server.",
  baseUrlHelp: "The web address of the service. Copy it exactly as that service gives it.",
  apiKeyHelp: "The private key from that service.",
  modelIdHelp: "Model ID: the exact model name your provider uses.",
  openaiCompatibleHelp:
    "OpenAI-compatible endpoint: a web address another program offers that speaks the same language as OpenAI.",
  testAllConnectionsLine:
    "Checks sign-ins and looks for servers on this computer. It does not ask any model a question. To ask one model a short question, press Test on its card.",
  connectionTestConfirm:
    "Testing sends a small prompt to {name} and may incur a charge. Continue?",
  connectionTestTimedOut: "Connection test timed out.",
  connectionTestUnreachable: "Could not reach the server.",
  connectionTestNoModel: "Choose or enter a model before testing.",
} as const;

export type CopyKey = keyof typeof COPY;

/** Fill `{placeholders}` in a copy sentence. Unknown names are left as they are. */
export function formatCopy(
  template: string,
  values: Record<string, string | number> = {},
): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = values[key];
    return value === undefined ? whole : String(value);
  });
}
