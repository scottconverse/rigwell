/** A small line icon. Hidden from screen readers, so the button keeps its text name. */
export function NavIcon({ d }: { d: string }) {
  return <svg className="nav-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}
