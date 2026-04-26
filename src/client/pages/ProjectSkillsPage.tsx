import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams } from 'react-router';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Plug, Server, FileText, Plus, Trash2, ChevronDown, ChevronRight, Search, Download, X, Store, Loader2 } from 'lucide-react';

interface PluginSkill {
  name: string;
  description: string;
}

interface PluginInfo {
  name: string;
  description: string;
  skills: PluginSkill[];
}

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ProjectPlugins {
  plugins: PluginInfo[];
  mcpServers: Record<string, McpServerConfig>;
  customInstructions: string;
}

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

function SkillCatalog({
  projectId,
  existingServers,
  onInstalled,
}: {
  projectId: string;
  existingServers: Record<string, McpServerConfig>;
  onInstalled: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [search, setSearch] = useState('');
  const [installing, setInstalling] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch('/api/skill-catalog')
      .then((r) => r.json())
      .then((data) => setCatalog(data.catalog || []))
      .catch(() => {});
  }, [open]);

  const filtered = useMemo(
    () =>
      catalog.filter(
        (c) =>
          !existingServers[c.id] &&
          (c.name.toLowerCase().includes(search.toLowerCase()) ||
            c.description.toLowerCase().includes(search.toLowerCase())),
      ),
    [catalog, existingServers, search],
  );

  const handleInstall = useCallback(
    async (entry: CatalogEntry) => {
      setInstalling(entry.id);
      try {
        const res = await fetch(`/api/projects/${projectId}/skills/mcp-servers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: entry.id,
            config: {
              command: entry.command,
              args: entry.args,
              env: entry.env,
            },
          }),
        });
        if (res.ok) onInstalled();
      } finally {
        setInstalling(null);
      }
    },
    [projectId, onInstalled],
  );

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Store className="h-4 w-4 mr-2" />
        Skill Catalog
      </Button>
    );
  }

  return (
    <Card>
      <CardHeader className="py-3 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Store className="h-4 w-4" />
            Skill Catalog
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="py-2 px-4 space-y-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search skills..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">
            {catalog.length === 0 ? 'Loading...' : 'No matching skills found.'}
          </p>
        ) : (
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {filtered.map((entry) => (
              <div
                key={entry.id}
                className="flex items-start justify-between gap-2 p-2 rounded-md border text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">{entry.name}</p>
                  <p className="text-xs text-muted-foreground line-clamp-2">{entry.description}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={installing === entry.id}
                  onClick={() => handleInstall(entry)}
                >
                  {installing === entry.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Download className="h-3 w-3" />
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function ProjectSkillsPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ProjectPlugins | null>(null);
  const [expandedPlugins, setExpandedPlugins] = useState<Set<string>>(new Set());
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());

  // New MCP server form
  const [showAddServer, setShowAddServer] = useState(false);
  const [newServerName, setNewServerName] = useState('');
  const [newServerCommand, setNewServerCommand] = useState('');
  const [newServerArgs, setNewServerArgs] = useState('');

  const fetchData = useCallback(() => {
    if (!id) return;
    fetch(`/api/projects/${id}/skills`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const togglePlugin = (name: string) => {
    setExpandedPlugins((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const toggleServer = (name: string) => {
    setExpandedServers((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const addServer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    const args = newServerArgs
      .split(/\s+/)
      .map((a) => a.trim())
      .filter(Boolean);
    await fetch(`/api/projects/${id}/skills/mcp-servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newServerName,
        config: { command: newServerCommand, args },
      }),
    });
    setNewServerName('');
    setNewServerCommand('');
    setNewServerArgs('');
    setShowAddServer(false);
    fetchData();
  };

  const removeServer = async (name: string) => {
    if (!id) return;
    if (!confirm(`Remove MCP server "${name}"?`)) return;
    await fetch(`/api/projects/${id}/skills/mcp-servers/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    fetchData();
  };

  if (!data) return <div className="p-6 text-muted-foreground">Loading skills…</div>;

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      {/* Plugins section */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Plug className="h-5 w-5" />
          <h3 className="text-lg font-semibold">Plugins</h3>
          <Badge variant="secondary">{data.plugins.length}</Badge>
        </div>

        {data.plugins.length === 0 ? (
          <p className="text-sm text-muted-foreground">No plugins loaded.</p>
        ) : (
          <div className="space-y-2">
            {data.plugins.map((plugin) => (
              <Card key={plugin.name}>
                <CardHeader
                  className="py-3 px-4 cursor-pointer"
                  onClick={() => togglePlugin(plugin.name)}
                >
                  <div className="flex items-center gap-2">
                    {expandedPlugins.has(plugin.name) ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                    <CardTitle className="text-sm">{plugin.name}</CardTitle>
                    <Badge variant="outline" className="text-xs">
                      {plugin.skills.length} skill{plugin.skills.length !== 1 ? 's' : ''}
                    </Badge>
                  </div>
                  {plugin.description && (
                    <p className="text-xs text-muted-foreground ml-6">{plugin.description}</p>
                  )}
                </CardHeader>
                {expandedPlugins.has(plugin.name) && (
                  <CardContent className="py-2 px-4">
                    <div className="space-y-1 ml-6">
                      {plugin.skills.map((skill) => (
                        <div key={skill.name} className="text-sm">
                          <span className="font-mono text-xs">{skill.name}</span>
                          {skill.description && (
                            <span className="text-muted-foreground ml-2 text-xs">
                              — {skill.description}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* MCP Servers section */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Server className="h-5 w-5" />
          <h3 className="text-lg font-semibold">MCP Servers</h3>
          <Badge variant="secondary">{Object.keys(data.mcpServers).length}</Badge>
        </div>

        {Object.keys(data.mcpServers).length === 0 ? (
          <p className="text-sm text-muted-foreground">No MCP servers configured.</p>
        ) : (
          <div className="space-y-2">
            {Object.entries(data.mcpServers).map(([name, config]) => (
              <Card key={name}>
                <CardHeader
                  className="py-3 px-4 cursor-pointer"
                  onClick={() => toggleServer(name)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {expandedServers.has(name) ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                      <CardTitle className="text-sm font-mono">{name}</CardTitle>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeServer(name);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </CardHeader>
                {expandedServers.has(name) && (
                  <CardContent className="py-2 px-4 ml-6 text-xs font-mono space-y-1">
                    <p>
                      <span className="text-muted-foreground">command:</span> {config.command}
                    </p>
                    {config.args && config.args.length > 0 && (
                      <p>
                        <span className="text-muted-foreground">args:</span> {config.args.join(' ')}
                      </p>
                    )}
                    {config.env && Object.keys(config.env).length > 0 && (
                      <div>
                        <span className="text-muted-foreground">env:</span>
                        {Object.entries(config.env).map(([k, v]) => (
                          <p key={k} className="ml-4">
                            {k}={v}
                          </p>
                        ))}
                      </div>
                    )}
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          {!showAddServer ? (
            <Button variant="outline" size="sm" onClick={() => setShowAddServer(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add MCP Server
            </Button>
          ) : (
            <Card className="w-full">
              <CardContent className="py-3 px-4">
                <form onSubmit={addServer} className="space-y-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Server Name</Label>
                    <Input
                      value={newServerName}
                      onChange={(e) => setNewServerName(e.target.value)}
                      placeholder="my-server"
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Command</Label>
                    <Input
                      value={newServerCommand}
                      onChange={(e) => setNewServerCommand(e.target.value)}
                      placeholder="npx"
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Arguments (space-separated)</Label>
                    <Input
                      value={newServerArgs}
                      onChange={(e) => setNewServerArgs(e.target.value)}
                      placeholder="-y @modelcontextprotocol/server-filesystem"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm">
                      Add
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowAddServer(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          <SkillCatalog
            projectId={id!}
            existingServers={data.mcpServers}
            onInstalled={fetchData}
          />
        </div>
      </section>

      {/* Custom Instructions section */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          <h3 className="text-lg font-semibold">Custom Instructions</h3>
        </div>
        {data.customInstructions ? (
          <Card>
            <CardContent className="py-3 px-4">
              <pre className="text-xs whitespace-pre-wrap font-mono text-muted-foreground">
                {data.customInstructions}
              </pre>
            </CardContent>
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground">
            No custom instructions. Add a <code className="text-xs">.github/copilot-instructions.md</code> file
            to your repo.
          </p>
        )}
      </section>
    </div>
  );
}
