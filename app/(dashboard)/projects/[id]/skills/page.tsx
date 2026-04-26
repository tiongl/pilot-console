'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Trash2, ToggleLeft, ToggleRight } from 'lucide-react';

interface Skill {
  id: string;
  projectId: string;
  type: 'mcp_server' | 'custom_instructions' | 'repo_context';
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
}

const TYPE_LABELS: Record<string, string> = {
  mcp_server: 'MCP Server',
  custom_instructions: 'Custom Instructions',
  repo_context: 'Repo Context',
};

export default function ProjectSkillsPage() {
  const params = useParams<{ id: string }>();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [addType, setAddType] = useState<string>('mcp_server');
  const [addName, setAddName] = useState('');
  const [addConfig, setAddConfig] = useState('');
  const [error, setError] = useState('');

  const fetchSkills = async () => {
    const res = await fetch(`/api/projects/${params.id}/skills`);
    setSkills(await res.json());
  };

  useEffect(() => { fetchSkills(); }, [params.id]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    let config: Record<string, unknown> = {};
    if (addType === 'mcp_server') {
      try { config = JSON.parse(addConfig || '{}'); } catch { setError('Invalid JSON config'); return; }
    } else if (addType === 'custom_instructions') {
      config = { instructions: addConfig };
    } else if (addType === 'repo_context') {
      config = { path: addConfig };
    }

    const res = await fetch(`/api/projects/${params.id}/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: addType, name: addName, config }),
    });
    if (!res.ok) { setError((await res.json()).error); return; }

    setShowAdd(false);
    setAddName('');
    setAddConfig('');
    fetchSkills();
  };

  const toggleSkill = async (skill: Skill) => {
    await fetch(`/api/projects/${params.id}/skills`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillId: skill.id, enabled: !skill.enabled }),
    });
    fetchSkills();
  };

  const deleteSkill = async (skillId: string) => {
    if (!confirm('Delete this skill?')) return;
    await fetch(`/api/projects/${params.id}/skills?skillId=${skillId}`, { method: 'DELETE' });
    fetchSkills();
  };

  const configPlaceholder =
    addType === 'mcp_server'
      ? '{"command": "npx", "args": ["-y", "@mcp/server"]}'
      : addType === 'custom_instructions'
        ? 'Enter custom instructions for this project…'
        : 'C:\\Users\\you\\repos\\other-repo';

  const configLabel =
    addType === 'mcp_server' ? 'Config (JSON)' : addType === 'custom_instructions' ? 'Instructions' : 'Repo Path';

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Skills & Context</h3>
        <Button size="sm" onClick={() => setShowAdd(!showAdd)}>
          <Plus className="h-4 w-4 mr-1" />
          Add Skill
        </Button>
      </div>

      {showAdd && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add Skill</CardTitle>
            <CardDescription>Configure additional context or tools for this project.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleAdd} className="space-y-4">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select value={addType} onValueChange={(v) => v && setAddType(v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mcp_server">MCP Server</SelectItem>
                    <SelectItem value="custom_instructions">Custom Instructions</SelectItem>
                    <SelectItem value="repo_context">Repo Context</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="My skill" required />
              </div>
              <div className="space-y-2">
                <Label>{configLabel}</Label>
                <Textarea
                  value={addConfig}
                  onChange={(e) => setAddConfig(e.target.value)}
                  placeholder={configPlaceholder}
                  rows={addType === 'custom_instructions' ? 5 : 3}
                  className={addType !== 'custom_instructions' ? 'font-mono text-sm' : ''}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex gap-2">
                <Button type="submit" size="sm">Save</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {skills.length === 0 && !showAdd ? (
        <p className="text-sm text-muted-foreground">
          No skills configured. Add MCP servers, custom instructions, or repo context to enhance Copilot.
        </p>
      ) : (
        <div className="space-y-2">
          {skills.map((skill) => (
            <Card key={skill.id} className={!skill.enabled ? 'opacity-60' : ''}>
              <CardHeader className="py-3 px-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-sm">{skill.name}</CardTitle>
                    <Badge variant="outline" className="text-xs">{TYPE_LABELS[skill.type]}</Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => toggleSkill(skill)}>
                      {skill.enabled
                        ? <ToggleRight className="h-4 w-4 text-green-600" />
                        : <ToggleLeft className="h-4 w-4" />}
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => deleteSkill(skill.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="py-2 px-4">
                <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-all">
                  {skill.type === 'custom_instructions'
                    ? (skill.config.instructions as string)
                    : skill.type === 'repo_context'
                      ? (skill.config.path as string)
                      : JSON.stringify(skill.config, null, 2)}
                </pre>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
