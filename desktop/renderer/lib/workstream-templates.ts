export const ROLES = ["Engineering", "Product", "Design", "Finance", "Marketing", "Sales", "Operations", "Founder", "Something else"] as const;
export type Role = (typeof ROLES)[number];

export interface WsTemplate { name: string; summary: string; art: string }

export const TEMPLATES: WsTemplate[] = [
  {
    name: "Client Engagement",
    summary: "Plan and run an ongoing piece of work for a client.",
    art: `<circle cx="22" cy="22" r="11"/><circle cx="62" cy="22" r="11" stroke="var(--accent)"/><path d="M33 22h18"/><path d="M45 17l6 5-6 5" stroke="var(--accent)"/>`,
  },
  {
    name: "Security Check-up",
    summary: "Review a project for common security weaknesses.",
    art: `<rect x="26" y="18" width="32" height="22" rx="3"/><path d="M33 18v-5a9 9 0 0 1 18 0v5"/><circle cx="42" cy="29" r="3" stroke="var(--accent)"/><path d="M42 32v4" stroke="var(--accent)"/><path d="M6 8l6 0M72 8l6 0"/>`,
  },
  {
    name: "Product From Scratch",
    summary: "Plan and build a new product with a team of agents.",
    art: `<path d="M8 36h68"/><rect x="12" y="24" width="14" height="12" rx="1"/><rect x="32" y="16" width="14" height="20" rx="1"/><rect x="52" y="6" width="14" height="30" rx="1" stroke="var(--accent)"/>`,
  },
  {
    name: "Market and Competitor Study",
    summary: "Survey the market, competitors and pricing, then test how the product is positioned.",
    art: `<circle cx="36" cy="20" r="13"/><path d="M46 30l16 10"/><path d="M28 24l5-6 4 3 5-7" stroke="var(--accent)"/>`,
  },
  {
    name: "Business Operations Setup",
    summary: "Set up the routines and tools that keep a company running.",
    art: `<rect x="6" y="6" width="22" height="14" rx="2"/><rect x="34" y="6" width="22" height="14" rx="2" stroke="var(--accent)"/><rect x="62" y="6" width="16" height="14" rx="2"/><path d="M17 20v8h50v-8M42 28v10"/><rect x="30" y="38" width="24" height="5" rx="1"/>`,
  },
];

const ROLE_KEY = "rigwell.workstreamRole";

export function loadRole(): Role {
  try {
    const r = localStorage.getItem(ROLE_KEY);
    return (ROLES as readonly string[]).includes(r ?? "") ? (r as Role) : "Founder";
  } catch {
    return "Founder";
  }
}

export function saveRole(r: Role): void {
  try { localStorage.setItem(ROLE_KEY, r); } catch { /* ignore */ }
}

/** First message for the lead session. template undefined = blank workstream. */
export function draftFor(name: string, role: Role, template?: WsTemplate): string {
  const head = `Propose a Workstream named "${name.trim()}". My role: ${role}. Goal: `;
  return template ? `${head}${template.summary.charAt(0).toLowerCase()}${template.summary.slice(1)} Plan the members and their roles, then ask me to approve.` : head;
}

export function homeRoute(folder: string, draft: string): string {
  return `/?folder=${encodeURIComponent(folder)}&draft=${encodeURIComponent(draft)}`;
}
