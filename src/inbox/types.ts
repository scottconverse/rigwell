export const CATEGORIES = ["permission", "question", "turn", "automation", "mission", "workstream"] as const;
export type Category = typeof CATEGORIES[number];
export type Frequency = "off" | "immediate" | "digest";
export interface EmailConfig { enabled: boolean; host: string; port: number; secure: boolean; user: string; passwordCredential: string; from: string; to: string; digestHour: number; categories: Record<Category, Frequency> }
export const defaultEmail = (): EmailConfig => ({ enabled: false, host: "", port: 587, secure: false, user: "", passwordCredential: "", from: "", to: "", digestHour: 9, categories: Object.fromEntries(CATEGORIES.map((c) => [c, "off"])) as EmailConfig["categories"] });
