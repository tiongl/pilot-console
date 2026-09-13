import { execSync } from 'child_process';

/**
 * Shared wrappers around the `gh copilot plugin ...` CLI so both the HTTP
 * skill-catalog endpoints and the Project Lead's tools drive installs the same
 * way. Parsing mirrors the original endpoint logic exactly so their responses
 * are unchanged.
 */

export interface InstalledPlugin {
  name: string;
  marketplace: string;
  version: string;
}

export interface BrowsablePlugin {
  name: string;
  description: string;
}

export interface MarketplaceEntry {
  name: string;
  source: string;
  builtin: boolean;
}

/** A plugin reference: `name@marketplace`, or a bare repo slug when no marketplace. */
export function pluginRef(plugin: string, marketplace?: string): string {
  return marketplace ? `${plugin}@${marketplace}` : plugin;
}

export function listMarketplaces(): MarketplaceEntry[] {
  const raw = execSync('gh copilot plugin marketplace list', { encoding: 'utf-8', timeout: 15000 });
  const marketplaces: MarketplaceEntry[] = [];
  let builtinSection = false;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (/included with/i.test(trimmed)) { builtinSection = true; continue; }
    if (/registered marketplace/i.test(trimmed)) { builtinSection = false; continue; }
    const m = trimmed.match(/^\S+\s+([\w-]+)\s+\((?:GitHub:\s*)?([^)]+)\)/);
    if (!m) continue;
    marketplaces.push({ name: m[1], source: m[2], builtin: builtinSection });
  }
  return marketplaces;
}

export function browsePlugins(marketplace: string): BrowsablePlugin[] {
  const raw = execSync(`gh copilot plugin marketplace browse ${marketplace}`, { encoding: 'utf-8', timeout: 30000 });
  const plugins: BrowsablePlugin[] = [];
  for (const line of raw.split('\n')) {
    const m = line.trim().match(/^\S+\s+([\w-]+)\s+-\s+(.+)/);
    if (m) plugins.push({ name: m[1], description: m[2].trim() });
  }
  return plugins;
}

export function listInstalledPlugins(): InstalledPlugin[] {
  const raw = execSync('gh copilot plugin list', { encoding: 'utf-8', timeout: 15000 });
  const installed: InstalledPlugin[] = [];
  for (const line of raw.split('\n')) {
    const m = line.trim().match(/^\S+\s+([\w-]+)@([\w-]+)\s+\(v?([\d.]+)\)/);
    if (m) installed.push({ name: m[1], marketplace: m[2], version: m[3] });
  }
  return installed;
}

/**
 * Install a plugin. With a marketplace this runs `gh copilot plugin install
 * <plugin>@<marketplace>`; without one (a repo slug like `owner/repo`) it runs
 * `copilot plugin install <plugin>`.
 */
export function installPlugin(plugin: string, marketplace?: string): string {
  const cmd = marketplace
    ? `gh copilot plugin install ${plugin}@${marketplace}`
    : `copilot plugin install ${plugin}`;
  return execSync(cmd, { encoding: 'utf-8', timeout: 60000 }).trim();
}

export function uninstallPlugin(plugin: string, marketplace?: string): string {
  const cmd = marketplace
    ? `gh copilot plugin uninstall ${plugin}@${marketplace}`
    : `copilot plugin uninstall ${plugin}`;
  return execSync(cmd, { encoding: 'utf-8', timeout: 30000 }).trim();
}
