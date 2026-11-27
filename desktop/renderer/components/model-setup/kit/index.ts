// Copied from model-setup-kit d40de0a. Do not edit here; change the kit and copy again.
/*
  The React screens. Import this entry only from a React host; the core
  (`src/index.ts`) never imports React.

  Styling: import `./styles.css` once, then theme through the `--msk-*`
  variables (each has a fallback).
*/

export { ModelSetupScreen } from "./ModelSetupScreen.tsx";
export type { ModelSetupScreenProps } from "./ModelSetupScreen.tsx";
export { CliSignInCard } from "./CliSignInCard.tsx";
export type { CliSignInCardProps } from "./CliSignInCard.tsx";
export { OllamaSignInCard } from "./OllamaSignInCard.tsx";
export type { OllamaSignInCardProps } from "./OllamaSignInCard.tsx";
export { OllamaWarning } from "./OllamaWarning.tsx";
export type { OllamaWarningProps } from "./OllamaWarning.tsx";
export { LocalModelsOnThisComputer } from "./LocalModelsOnThisComputer.tsx";
export type { LocalModelsOnThisComputerProps } from "./LocalModelsOnThisComputer.tsx";
export { LocalServerCard } from "./LocalServerCard.tsx";
export type { LocalServerCardProps } from "./LocalServerCard.tsx";
export { FirstRunModelCard } from "./FirstRunModelCard.tsx";
export type { FirstRunModelCardProps } from "./FirstRunModelCard.tsx";
export { AddConnectionForm } from "./AddConnectionForm.tsx";
export type { AddConnectionFormProps } from "./AddConnectionForm.tsx";
export { COPY, UI_COPY, makeCopy, formatCopy } from "./copy.ts";
export type { CopyOverrides, ModelSetupCopy } from "./copy.ts";
