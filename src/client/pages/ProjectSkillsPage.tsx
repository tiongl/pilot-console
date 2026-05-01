import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams } from 'react-router';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Plug, Server, FileText, Plus, Trash2, ChevronDown, ChevronRight, Search, Download, X, Store, Loader2 } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PluginSkill {
  name: string;
  path: string;
}

interface PluginInfo {
  name: string;
  marketplace: string;
  version: string;
  enabled: boolean;
  skills: PluginSkill[];
}

interface McpServerConfig {
  type: string;
  command: string;
  args?: string[];
  [key: string]: unknown;
}

interface RepoSkills {
  agentsMd: boolean;
  customInstructions: string[];
}

interface CopilotConfig {
  plugins: PluginInfo[];
  mcpServers: Record<string, McpServerConfig>;
  repoSkills: RepoSkills;
}

interface Marketplace {
  name: string;
  source: string;
  builtin: boolean;
}

interface CatalogPlugin {
  name: string;
  description: string;
}

interface InstalledPlugin {
  name: string;
  marketplace: string;
  version: string;
}

// ---------------------------------------------------------------------------
// Skill Catalog Component
// ---------------------------------------------------------------------------

export function SkillCatalog({ onInstallChanged }: { onInstallChanged: () => void }) {
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>([]);
  const [selectedMp, setSelectedMp] = useState<string>('');
  const [plugins, setPlugins] = useState<CatalogPlugin[]>([]);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [search, setSearch] = useState('');
  const [loadingMp, setLoadingMp] = useState(true);
  const [loadingPlugins, setLoadingPlugins] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [showAddMp, setShowAddMp] = useState(false);
  const [newMpRepo, setNewMpRepo] = useState('');
  const [addingMp, setAddingMp] = useState(false);

  const fetchMarketplaces = useCallback(async () => {
    setLoadingMp(true);
    try {
      const res = await fetch('/api/skill-catalog/marketplaces');
      if (res.ok) {
        const data = await res.json();
        setMarketplaces(data.marketplaces);
        if (data.marketplaces.length > 0 && !selectedMp) {
          setSelectedMp(data.marketplaces[0].name);
        }
      }
    } finally {
      setLoadingMp(false);
    }
  }, [selectedMp]);

  const fetchInstalled = useCallback(async () => {
    try {
      const res = await fetch('/api/skill-catalog/installed');
      if (res.ok) {
        const data = await res.json();
        setInstalled(data.installed);
      }
    } catch { /* ignore */ }
  }, []);

  const fetchPlugins = useCallback(async (mp: string) => {
    if (!mp) return;
    setLoadingPlugins(true);
    try {
      const res = await fetch(`/api/skill-catalog/browse?marketplace=${encodeURIComponent(mp)}`);
      if (res.ok) {
        const data = await res.json();
        setPlugins(data.plugins);
      }
    } finally {
      setLoadingPlugins(false);
    }
  }, []);

  useEffect(() => { fetchMarketplaces(); fetchInstalled(); }, [fetchMarketplaces, fetchInstalled]);
  useEffect(() => { if (selectedMp) fetchPlugins(selectedMp); }, [selectedMp, fetchPlugins]);

  const isInstalled = useCallback((pluginName: string, marketplace: string) => {
    return installed.some(i => i.name === pluginName && i.marketplace === marketplace);
  }, [installed]);

  const handleInstall = async (pluginName: string, marketplace: string) => {
    setInstalling(pluginName);
    try {
      const res = await fetch('/api/skill-catalog/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugin: pluginName, marketplace }),
      });
      if (res.ok) {
        await fetchInstalled();
        onInstallChanged();
      }
    } finally {
      setInstalling(null);
    }
  };

  const handleUninstall = async (pluginName: string, marketplace: string) => {
    if (!confirm(`Uninstall "${pluginName}"?`)) return;
    setInstalling(pluginName);
    try {
      const res = await fetch('/api/skill-catalog/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugin: pluginName, marketplace }),
      });
      if (res.ok) {
        await fetchInstalled();
        onInstallChanged();
      }
    } finally {
      setInstalling(null);
    }
  };

  const handleAddMarketplace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMpRepo.trim()) return;
    setAddingMp(true);
    try {
      const res = await fetch('/api/skill-catalog/marketplace/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: newMpRepo.trim() }),
      });
      if (res.ok) {
        setNewMpRepo('');
        setShowAddMp(false);
        await fetchMarketplaces();
      }
    } finally {
      setAddingMp(false);
    }
  };

  // Suggested marketplaces that aren't already registered
  const suggestedMarketplaces = useMemo(() => {
    const known = [
      { repo: 'microsoft/work-iq', name: 'work-iq', description: 'MCP Server and CLI for accessing Work IQ (M365 Copilot)' },
      { repo: 'devantler-tech/copilot-plugins', name: 'devantler-plugins', description: 'Curated agent skills bundled by category' },
      { repo: 'Arithmomaniac/copilot-plugins', name: 'arithmomaniac-plugins', description: 'Agent skills for Git workflows, productivity & dev tools' },
      { repo: 'rtasalem/dev-suq', name: 'dev-suq', description: 'Open-source plugins for hybrid agentic-developer workflow' },
      { repo: 'AndyElessar/skills', name: 'andy-skills', description: 'Plugins for dotnet, meta-prompts, and more' },
    ];
    const registeredSources = new Set(marketplaces.map(m => m.source.toLowerCase()));
    return known.filter(k => !registeredSources.has(k.repo.toLowerCase()));
  }, [marketplaces]);

  const handleAddSuggested = async (repo: string) => {
    setAddingMp(true);
    try {
      const res = await fetch('/api/skill-catalog/marketplace/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo }),
      });
      if (res.ok) {
        await fetchMarketplaces();
      }
    } finally {
      setAddingMp(false);
    }
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return plugins;
    const q = search.toLowerCase();
    return plugins.filter(p =>
      p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
    );
  }, [plugins, search]);

  if (loadingMp) {
    return <p className="text-sm text-muted-foreground">Loading marketplaces…</p>;
  }

  return (
    <div className="space-y-4">
      {/* Marketplace selector + search */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Label className="text-sm whitespace-nowrap">Marketplace</Label>
          <select
            value={selectedMp}
            onChange={(e) => setSelectedMp(e.target.value)}
            className="h-8 text-sm border rounded-md px-2 bg-background"
          >
            {marketplaces.map(mp => (
              <option key={mp.name} value={mp.name}>
                {mp.name} {mp.builtin ? '(built-in)' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search plugins…"
            className="pl-8 h-8 text-sm"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-2">
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowAddMp(!showAddMp)}>
          <Plus className="h-4 w-4 mr-1" />
          Add Marketplace
        </Button>
      </div>

      {/* Add marketplace form */}
      {showAddMp && (
        <Card>
          <CardContent className="pt-4 space-y-4">
            {/* Suggested marketplaces */}
            {suggestedMarketplaces.length > 0 && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">Suggested Marketplaces</Label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {suggestedMarketplaces.map(mp => (
                    <button
                      key={mp.repo}
                      onClick={() => handleAddSuggested(mp.repo)}
                      disabled={addingMp}
                      className="flex items-center gap-3 p-3 rounded-md border hover:bg-accent/50 text-left transition-colors disabled:opacity-50"
                    >
                      <Store className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{mp.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{mp.description}</p>
                        <p className="text-xs text-muted-foreground font-mono mt-0.5">{mp.repo}</p>
                      </div>
                      <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Separator */}
            {suggestedMarketplaces.length > 0 && (
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <div className="flex-1 border-t" />
                or add a custom marketplace
                <div className="flex-1 border-t" />
              </div>
            )}

            {/* Manual input */}
            <form onSubmit={handleAddMarketplace} className="flex items-end gap-3">
              <div className="flex-1 space-y-1">
                <Label className="text-sm">GitHub Repository (owner/repo)</Label>
                <Input
                  value={newMpRepo}
                  onChange={(e) => setNewMpRepo(e.target.value)}
                  placeholder="owner/repo"
                  className="h-8 text-sm"
                  required
                />
              </div>
              <Button type="submit" size="sm" disabled={addingMp}>
                {addingMp ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Register'}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowAddMp(false)}>Cancel</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Plugin grid */}
      {loadingPlugins ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading plugins from {selectedMp}…
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">
          {search ? 'No plugins match your search.' : 'No plugins found in this marketplace.'}
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filtered.map(plugin => {
            const alreadyInstalled = isInstalled(plugin.name, selectedMp);
            const busy = installing === plugin.name;
            return (
              <Card key={plugin.name} className="flex flex-col">
                <CardHeader className="py-3 px-4 pb-1">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-sm font-mono">{plugin.name}</CardTitle>
                    {alreadyInstalled && (
                      <Badge variant="default" className="text-xs">installed</Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="pt-1 pb-3 px-4 flex-1 flex flex-col justify-between">
                  <p className="text-xs text-muted-foreground mb-3 line-clamp-2">{plugin.description}</p>
                  <div>
                    {alreadyInstalled ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs text-destructive hover:text-destructive"
                        disabled={busy}
                        onClick={() => handleUninstall(plugin.name, selectedMp)}
                      >
                        {busy ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Trash2 className="h-3 w-3 mr-1" />}
                        Uninstall
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs"
                        disabled={busy}
                        onClick={() => handleInstall(plugin.name, selectedMp)}
                      >
                        {busy ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Download className="h-3 w-3 mr-1" />}
                        Install
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {filtered.length} plugin{filtered.length !== 1 ? 's' : ''} in {selectedMp}
        {search ? ` matching "${search}"` : ''}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Installed Skills & MCP Panel (used in Settings dialog)
// ---------------------------------------------------------------------------

export function InstalledSkillsPanel({ projectId }: { projectId: string }) {
  const [config, setConfig] = useState<CopilotConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddMcp, setShowAddMcp] = useState(false);
  const [mcpName, setMcpName] = useState('');
  const [mcpCommand, setMcpCommand] = useState('');
  const [mcpArgs, setMcpArgs] = useState('');
  const [expandedPlugins, setExpandedPlugins] = useState<Set<string>>(new Set());

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`/api/copilot-config?projectId=${projectId}`);
      if (res.ok) setConfig(await res.json());
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const togglePlugin = (name: string) => {
    setExpandedPlugins((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const addMcpServer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mcpName.trim() || !mcpCommand.trim()) return;
    const args = mcpArgs.split(',').map(a => a.trim()).filter(Boolean);
    await fetch('/api/copilot-config/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: mcpName.trim(), config: { type: 'stdio', command: mcpCommand.trim(), args } }),
    });
    setShowAddMcp(false); setMcpName(''); setMcpCommand(''); setMcpArgs('');
    fetchConfig();
  };

  const deleteMcpServer = async (name: string) => {
    if (!confirm(`Remove MCP server "${name}"?`)) return;
    await fetch(`/api/copilot-config/mcp?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    fetchConfig();
  };

  if (loading) return <p className="text-sm text-muted-foreground py-4">Loading…</p>;
  if (!config) return <p className="text-sm text-destructive py-4">Failed to load configuration.</p>;

  const mcpEntries = Object.entries(config.mcpServers) as [string, McpServerConfig][];

  return (
    <div className="space-y-6">
      {/* Installed Plugins */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Plug className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold">Installed Plugins</h4>
          <Badge variant="outline" className="text-xs ml-auto">read-only</Badge>
        </div>
        {config.plugins.length === 0 ? (
          <p className="text-sm text-muted-foreground">No plugins installed.</p>
        ) : (
          <div className="space-y-2">
            {config.plugins.map(plugin => {
              const expanded = expandedPlugins.has(plugin.name);
              return (
                <Card key={plugin.name}>
                  <CardHeader className="py-2 px-3 cursor-pointer" onClick={() => togglePlugin(plugin.name)}>
                    <div className="flex items-center gap-2">
                      {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                      <CardTitle className="text-xs">{plugin.name}</CardTitle>
                      <Badge variant="outline" className="text-xs">{plugin.marketplace}</Badge>
                      <span className="text-xs text-muted-foreground">v{plugin.version}</span>
                      <Badge variant={plugin.enabled ? 'default' : 'secondary'} className="text-xs ml-auto">{plugin.enabled ? 'enabled' : 'disabled'}</Badge>
                    </div>
                  </CardHeader>
                  {expanded && plugin.skills.length > 0 && (
                    <CardContent className="pt-0 pb-2 px-3">
                      <ul className="space-y-0.5 ml-5">
                        {plugin.skills.map(skill => (
                          <li key={skill.name} className="text-xs text-muted-foreground flex items-center gap-1.5">
                            <span className="inline-block w-1 h-1 rounded-full bg-muted-foreground/40" />
                            {skill.name}
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* MCP Servers */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold">MCP Servers</h4>
          <Button size="sm" variant="outline" className="ml-auto text-xs" onClick={() => setShowAddMcp(!showAddMcp)}>
            <Plus className="h-3 w-3 mr-1" /> Add
          </Button>
        </div>
        {showAddMcp && (
          <Card>
            <CardContent className="pt-3">
              <form onSubmit={addMcpServer} className="space-y-2">
                <div className="space-y-1">
                  <Label className="text-xs">Name</Label>
                  <Input value={mcpName} onChange={e => setMcpName(e.target.value)} placeholder="my-mcp-server" className="h-7 text-xs" required />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Command</Label>
                  <Input value={mcpCommand} onChange={e => setMcpCommand(e.target.value)} placeholder="npx" className="h-7 text-xs" required />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Args (comma-separated)</Label>
                  <Input value={mcpArgs} onChange={e => setMcpArgs(e.target.value)} placeholder="@my/server, serve" className="h-7 text-xs font-mono" />
                </div>
                <div className="flex gap-2">
                  <Button type="submit" size="sm" className="text-xs">Save</Button>
                  <Button type="button" variant="ghost" size="sm" className="text-xs" onClick={() => setShowAddMcp(false)}>Cancel</Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}
        {mcpEntries.length === 0 && !showAddMcp ? (
          <p className="text-sm text-muted-foreground">No MCP servers configured.</p>
        ) : (
          <div className="space-y-2">
            {mcpEntries.map(([name, srv]) => (
              <Card key={name}>
                <CardHeader className="py-2 px-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-xs font-mono">{name}</CardTitle>
                      <Badge variant="outline" className="text-xs">{srv.type}</Badge>
                    </div>
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => deleteMcpServer(name)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 pb-2 px-3">
                  <code className="text-xs text-muted-foreground">{srv.command} {srv.args?.join(' ')}</code>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ProjectSkillsPage() {
  const { id } = useParams<{ id: string }>();
  const [config, setConfig] = useState<CopilotConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddMcp, setShowAddMcp] = useState(false);
  const [mcpName, setMcpName] = useState('');
  const [mcpCommand, setMcpCommand] = useState('');
  const [mcpArgs, setMcpArgs] = useState('');
  const [expandedPlugins, setExpandedPlugins] = useState<Set<string>>(new Set());
  const [agentsMdContent, setAgentsMdContent] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`/api/copilot-config?projectId=${id}`);
      if (res.ok) setConfig(await res.json());
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const togglePlugin = (name: string) => {
    setExpandedPlugins((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const addMcpServer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mcpName.trim() || !mcpCommand.trim()) return;
    const args = mcpArgs
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    await fetch('/api/copilot-config/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: mcpName.trim(),
        config: { type: 'stdio', command: mcpCommand.trim(), args },
      }),
    });
    setShowAddMcp(false);
    setMcpName('');
    setMcpCommand('');
    setMcpArgs('');
    fetchConfig();
  };

  const deleteMcpServer = async (name: string) => {
    if (!confirm(`Remove MCP server "${name}"?`)) return;
    await fetch(`/api/copilot-config/mcp?name=${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    fetchConfig();
  };

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Loading Copilot configuration…</p>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">Failed to load Copilot configuration.</p>
      </div>
    );
  }

  const mcpEntries = Object.entries(config.mcpServers) as [string, McpServerConfig][];

  return (
    <div className="p-6 space-y-8 max-w-4xl overflow-y-auto h-full">
      {/* ─── Skill Catalog (inline) ─── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Store className="h-5 w-5 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Skill Catalog</h3>
        </div>
        <SkillCatalog onInstallChanged={fetchConfig} />
      </section>

      {/* ─── Section A: Installed Plugins & Skills ─── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Plug className="h-5 w-5 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Installed Plugins</h3>
          <Badge variant="outline" className="text-xs ml-auto">
            read-only
          </Badge>
        </div>

        {config.plugins.length === 0 ? (
          <p className="text-sm text-muted-foreground">No plugins installed.</p>
        ) : (
          <div className="space-y-2">
            {config.plugins.map((plugin) => {
              const expanded = expandedPlugins.has(plugin.name);
              return (
                <Card key={plugin.name}>
                  <CardHeader className="py-3 px-4 cursor-pointer" onClick={() => togglePlugin(plugin.name)}>
                    <div className="flex items-center gap-2">
                      {expanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                      <CardTitle className="text-sm">{plugin.name}</CardTitle>
                      <Badge variant="outline" className="text-xs">
                        {plugin.marketplace}
                      </Badge>
                      <span className="text-xs text-muted-foreground">v{plugin.version}</span>
                      <Badge
                        variant={plugin.enabled ? 'default' : 'secondary'}
                        className="text-xs ml-auto"
                      >
                        {plugin.enabled ? 'enabled' : 'disabled'}
                      </Badge>
                    </div>
                  </CardHeader>
                  {expanded && plugin.skills.length > 0 && (
                    <CardContent className="pt-0 pb-3 px-4">
                      <ul className="space-y-1 ml-6">
                        {plugin.skills.map((skill) => (
                          <li key={skill.name} className="text-sm text-muted-foreground flex items-center gap-2">
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
                            {skill.name}
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* ─── Section B: MCP Servers ─── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Server className="h-5 w-5 text-muted-foreground" />
          <h3 className="text-lg font-semibold">MCP Servers</h3>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => setShowAddMcp(!showAddMcp)}
          >
            <Plus className="h-4 w-4 mr-1" />
            Add
          </Button>
        </div>

        {showAddMcp && (
          <Card>
            <CardContent className="pt-4">
              <form onSubmit={addMcpServer} className="space-y-3">
                <div className="space-y-1">
                  <Label>Name</Label>
                  <Input
                    value={mcpName}
                    onChange={(e) => setMcpName(e.target.value)}
                    placeholder="my-mcp-server"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label>Command</Label>
                  <Input
                    value={mcpCommand}
                    onChange={(e) => setMcpCommand(e.target.value)}
                    placeholder="npx"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label>Args (comma-separated)</Label>
                  <Input
                    value={mcpArgs}
                    onChange={(e) => setMcpArgs(e.target.value)}
                    placeholder="@my/server, serve"
                    className="font-mono text-sm"
                  />
                </div>
                <div className="flex gap-2">
                  <Button type="submit" size="sm">
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAddMcp(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {mcpEntries.length === 0 && !showAddMcp ? (
          <p className="text-sm text-muted-foreground">No MCP servers configured.</p>
        ) : (
          <div className="space-y-2">
            {mcpEntries.map(([name, srv]) => (
              <Card key={name}>
                <CardHeader className="py-3 px-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-sm font-mono">{name}</CardTitle>
                      <Badge variant="outline" className="text-xs">
                        {srv.type}
                      </Badge>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => deleteMcpServer(name)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 pb-3 px-4">
                  <code className="text-xs text-muted-foreground">
                    {srv.command} {srv.args?.join(' ')}
                  </code>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ─── Section C: Repo Context ─── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Repo Context</h3>
          <Badge variant="outline" className="text-xs ml-auto">
            read-only
          </Badge>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm">AGENTS.md</span>
              {config.repoSkills.agentsMd ? (
                <div className="flex items-center gap-2">
                  <Badge variant="default" className="text-xs">
                    present
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    onClick={async () => {
                      if (agentsMdContent !== null) {
                        setAgentsMdContent(null);
                        return;
                      }
                      try {
                        const res = await fetch(
                          `/api/copilot-config/agents-md?projectId=${id}`
                        );
                        if (res.ok) {
                          const data = await res.json();
                          setAgentsMdContent(data.content);
                        }
                      } catch {
                        // ignore
                      }
                    }}
                  >
                    {agentsMdContent !== null ? 'Hide' : 'View'}
                  </Button>
                </div>
              ) : (
                <Badge variant="secondary" className="text-xs">
                  not found
                </Badge>
              )}
            </div>

            {agentsMdContent !== null && (
              <pre className="text-xs text-muted-foreground bg-muted p-3 rounded-md overflow-auto max-h-64 whitespace-pre-wrap">
                {agentsMdContent}
              </pre>
            )}

            {config.repoSkills.customInstructions.length > 0 && (
              <div className="space-y-1">
                <span className="text-sm font-medium">.github/copilot/</span>
                <ul className="ml-4 space-y-0.5">
                  {config.repoSkills.customInstructions.map((f) => (
                    <li key={f} className="text-sm text-muted-foreground flex items-center gap-2">
                      <FileText className="h-3 w-3" />
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!config.repoSkills.agentsMd && config.repoSkills.customInstructions.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No repo-level context files found.
              </p>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
