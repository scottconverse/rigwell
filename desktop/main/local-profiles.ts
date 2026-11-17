import { activeProfile, createLocalProfile, listLocalProfiles, profileRoot, profileSwitchArgs, readLocalProfile, updateLocalProfile } from "../../src/storage/local-profiles.ts";
import { join, resolve } from "node:path";

/** Remember the pre-profile Electron location so returning to Default preserves existing cookies/state. */
export function rememberDefaultProfileData(legacy: string, env: Record<string, string | undefined> = process.env) {
  env.RIGWELL_PROFILE_DEFAULT_USER_DATA ??= env.RIGWELL_PROFILE_ROOT || env.RIGWELL_HOME ? join(resolve(env.RIGWELL_PROFILE_ROOT || env.RIGWELL_HOME!), "desktop-profile") : legacy;
}
export function profileDesktopData(home: string, env: Record<string, string | undefined> = process.env) {
  return activeProfile(env) === "default" && env.RIGWELL_PROFILE_DEFAULT_USER_DATA ? env.RIGWELL_PROFILE_DEFAULT_USER_DATA : join(home, "desktop-profile");
}

/** Switching is a new process, never a live mutation of daemon/credential/index ownership. */
export function localProfileController(restart: (args: string[]) => void, argv = process.argv.slice(1), env: Record<string, string | undefined> = process.env) {
  const root = profileRoot(env), active = activeProfile(env);
  return {
    list: () => ({ active, profiles: listLocalProfiles(root) }),
    create: (id: string, name: string, role: string) => createLocalProfile(root, id, name, role),
    update: (id: string, name: string, role: string) => updateLocalProfile(root, id, name, role),
    switch: (id: string, confirmed: boolean) => {
      if (confirmed !== true) throw new Error("Confirm restart and stopping current work before switching profiles");
      readLocalProfile(root, id); if (id === active) return { restarting: false };
      restart(profileSwitchArgs(argv, id)); return { restarting: true };
    },
  };
}
