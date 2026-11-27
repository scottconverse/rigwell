// Copied from model-setup-kit 869cdf5. Do not edit here; change the kit and copy again.
/*
  The extra sentences the screens need on top of `COPY` in core. Core keeps
  every sentence the library owns; this file adds the screen-only ones (group
  titles, field labels, button words) so no sentence is written inside a
  component. A host overrides any of them through the `copy` prop.
*/

import { COPY, formatCopy } from "../../../../../src/model-setup/core/copy.ts";

export const UI_COPY = {
  groupSignIns: "Subscription sign-ins",
  groupSignInsNote:
    "Uses your existing plan instead of per-use billing. Sign-ins expire.",
  groupLocal: "Local & self-hosted",
  groupLocalNote:
    "Runs on this machine or your own servers. Free per use; speed depends on the hardware. Choose a model on this computer or your own server. Cloud models spend credits.",
  groupConnection: "API connection",
  groupConnectionNote:
    "Pay per use. The key is stored on your side; never shown again after saving.",

  testAll: "Test all connections",
  connectionsChecked: "Re-read every sign-in and looked for local servers.",
  connectionsCheckFailed: "Could not check the connections just now.",

  signInButton: "Sign in to {name}",
  signInStartFailed: "That sign-in did not start.",
  signInStopFailed: "That would not stop.",
  signInStopped: "The {name} sign-in was stopped.",
  signInExpiresIn: "This link runs out in {time}.",
  signInModels: "Models this sign-in brings",
  modelNameLabel: "Model name",
  modelNameHelp: "Type the exact model name this program uses.",
  otherModel: "Other model",
  useThisModel: "Use this model",
  testButton: "Test",
  testingButton: "Asking…",
  testAnswered: "{name} answered: {detail}",
  testDidNotAnswer: "{name} did not answer. {detail}",
  testNotAvailable: "No Test here yet: sign in above first.",

  appUsesThis: "This app uses this",
  savedLabel: "Saved",

  ollamaOptional:
    "Optional. Sign in to ollama.com to use hosted models. You can skip this step.",
  ollamaWaiting: "Waiting for Ollama to print its link…",
  ollamaStartFailed:
    "Ollama did not start the sign-in. You can skip this step.",

  localModelsTitle: "Models on this computer",
  loadedChoiceTitle: "The local model",
  loadedChoiceNamed:
    "Press Use this one beside the model you want below. The first request can load that model and take a minute.",
  localPickSaved: "The local model was saved.",
  localPickSaveFailed: "Could not save the local model. Try again.",

  thisMachine: "this machine",
  remote: "remote",
  inMemoryCount: "{count} in memory",
  nothingInMemory: "nothing in memory",
  notReachable: "not reachable",
  ready: "Ready",
  running: "Running",
  couldNotReach: "Could not reach",
  runningNoModel:
    "Running, no model loaded — load one in the app that serves it, or press Use this one.",
  noChatModelsOnServer: "No chat models on this server.",
  nothingToList: "Nothing to list.",
  loadedStateUnknown: "load state unknown",
  inMemoryWord: "in memory",
  notLoadedWord: "not loaded",
  contextLine: "{count}K context",
  readsImages: "reads images",
  thinksByDefault: "thinks by default",
  openServerLink: "Open {name} ↗",

  connectionNameLabel: "Connection name",
  baseUrlLabel: "Base URL",
  apiKeyLabel: "API key (optional)",
  modelIdLabel: "Model id (optional)",
  discoveredModelsLabel: "Discovered models",
  chooseModel: "Choose a model",
  saveConnection: "Save connection",
  savingConnection: "Saving…",
  cancelEdit: "Cancel edit",
  discoverModels: "Discover models",
  discoveringModels: "Discovering…",
  testConnection: "Test connection",
  testingConnection: "Testing…",
  keyStoredHint: "Stored on your side. It is never shown again after saving.",
  connectionSaved: "Connection saved.",
  connectionSaveFailed: "Connection could not be saved.",
  connectionNameRequired: "Enter a name for this connection.",
  connectionBaseUrlRequired: "Enter the service's web address.",
  connectionNeedModel: "Enter or choose a model before saving.",
  connectionDiscoverEmpty: "No models were reported; enter the model id manually.",
  connectionDiscovered: "Choose a discovered model, then save.",

  loadFailed: "Could not read the model setup just now.",
} as const;

type CopyShape = typeof COPY & typeof UI_COPY;

/** Every sentence, as plain strings so a host can replace any of them. */
export type ModelSetupCopy = { [K in keyof CopyShape]: string };

/** Any subset of the sentences, replaced by a host. */
export type CopyOverrides = Partial<Record<keyof ModelSetupCopy, string>>;

/** Core sentences plus the screen sentences, with the host's overrides last. */
export function makeCopy(overrides?: CopyOverrides): ModelSetupCopy {
  return { ...COPY, ...UI_COPY, ...(overrides ?? {}) };
}

export { COPY, formatCopy };
