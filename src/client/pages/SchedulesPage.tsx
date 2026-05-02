import { useEffect, useState, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Badge } from '../components/ui/badge';
import { Plus, Play, Pencil, Trash2, Clock, Pause, History, ArrowLeft } from 'lucide-react';
import ScheduleInput from '../components/schedule/ScheduleInput';

interface Schedule {
  id: string;
  name: string;
  prompt: string;
  cronExpression: string;
  rendererType: string;
  enabled: boolean;
  cwd: string | null;
  maxRuntimeMs: number;
  maxRunsRetained: number;
  nextRunAt: string | null;
  lastStartedAt: string | null;
  createdAt: string;
}

const defaultForm = {
  name: '',
  prompt: '',
  cronExpression: '0 9 * * *',
  rendererType: 'plaintext',
  cwd: '',
  maxRuntimeMs: 300000,
  maxRunsRetained: 50,
};

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [renderers, setRenderers] = useState<string[]>([]);
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(defaultForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const fetchSchedules = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/schedules');
      if (res.ok) {
        const data = await res.json();
        setSchedules(data.schedules || []);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchSchedules();
    fetch('/api/admin/renderers')
      .then(r => r.json())
      .then(data => setRenderers(data.renderers || []))
      .catch(() => {});
  }, [fetchSchedules]);

  const openCreate = () => {
    setEditingId(null);
    setForm(defaultForm);
    setError('');
    setShowDialog(true);
  };

  const openEdit = (s: Schedule) => {
    setEditingId(s.id);
    setForm({
      name: s.name,
      prompt: s.prompt,
      cronExpression: s.cronExpression,
      rendererType: s.rendererType,
      cwd: s.cwd || '',
      maxRuntimeMs: s.maxRuntimeMs,
      maxRunsRetained: s.maxRunsRetained,
    });
    setError('');
    setShowDialog(true);
  };

  // Auto-open edit dialog when ?edit=<id> is in the URL
  const editIdFromUrl = searchParams.get('edit');
  useEffect(() => {
    if (editIdFromUrl && schedules.length > 0 && !editingId) {
      const schedule = schedules.find(s => s.id === editIdFromUrl);
      if (schedule) {
        setEditingId(schedule.id);
        setForm({
          name: schedule.name,
          prompt: schedule.prompt,
          cronExpression: schedule.cronExpression,
          rendererType: schedule.rendererType,
          cwd: schedule.cwd || '',
          maxRuntimeMs: schedule.maxRuntimeMs,
          maxRunsRetained: schedule.maxRunsRetained,
        });
        setError('');
        setShowDialog(true);
        setSearchParams({}, { replace: true });
      }
    }
  }, [editIdFromUrl, schedules, editingId, setSearchParams]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const url = editingId ? `/api/admin/schedules/${editingId}` : '/api/admin/schedules';
      const method = editingId ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          cwd: form.cwd || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setShowDialog(false);
      fetchSchedules();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this schedule and all its runs?')) return;
    try {
      await fetch(`/api/admin/schedules/${id}`, { method: 'DELETE' });
      fetchSchedules();
    } catch {}
  };

  const handleToggle = async (s: Schedule) => {
    try {
      await fetch(`/api/admin/schedules/${s.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      fetchSchedules();
    } catch {}
  };

  const handleTrigger = async (id: string) => {
    setTriggeringId(id);
    try {
      await fetch(`/api/admin/schedules/${id}/run`, { method: 'POST' });
      fetchSchedules();
    } catch {}
    setTriggeringId(null);
  };

  return (
    <div className="flex flex-col gap-6 p-8 max-w-4xl mx-auto w-full overflow-y-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/automation" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h2 className="text-2xl font-bold">Automation Config</h2>
            <p className="text-muted-foreground mt-1">Configure automations to run prompts on a schedule</p>
          </div>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" />
          New Schedule
        </Button>
      </div>

      {schedules.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Clock className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>No schedules yet. Create one to get started.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {schedules.map(s => (
            <div key={s.id} className="border rounded-lg p-4 flex items-start gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <Link
                    to={`/admin/schedules/${s.id}/runs`}
                    className="text-lg font-medium hover:underline"
                  >
                    {s.name}
                  </Link>
                  <Badge variant={s.enabled ? 'default' : 'secondary'}>
                    {s.enabled ? 'Active' : 'Paused'}
                  </Badge>
                  <Badge variant="outline">{s.rendererType}</Badge>
                </div>
                <p className="text-sm text-muted-foreground line-clamp-2 break-words mb-1">{s.prompt}</p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>Cron: <code className="bg-muted px-1 rounded">{s.cronExpression}</code></span>
                  {s.nextRunAt && (
                    <span>Next: {new Date(s.nextRunAt).toLocaleString()}</span>
                  )}
                  {s.lastStartedAt && (
                    <span>Last: {new Date(s.lastStartedAt).toLocaleString()}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Link to={`/admin/schedules/${s.id}/runs`}>
                  <Button variant="ghost" size="sm" title="Run history">
                    <History className="h-4 w-4" />
                  </Button>
                </Link>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleTrigger(s.id)}
                  disabled={triggeringId === s.id}
                  title="Run now"
                >
                  <Play className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleToggle(s)}
                  title={s.enabled ? 'Pause' : 'Enable'}
                >
                  <Pause className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => openEdit(s)} title="Edit">
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => handleDelete(s.id)} title="Delete">
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Schedule' : 'New Schedule'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Daily code review summary"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="prompt">Prompt</Label>
              <Textarea
                id="prompt"
                value={form.prompt}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setForm(f => ({ ...f, prompt: e.target.value }))}
                placeholder="Summarize all open pull requests in this repository..."
                rows={4}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <ScheduleInput
                  value={form.cronExpression}
                  onChange={(cron) => setForm(f => ({ ...f, cronExpression: cron }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="renderer">Renderer</Label>
                <select
                  id="renderer"
                  value={form.rendererType}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setForm(f => ({ ...f, rendererType: e.target.value }))}
                  className="w-full h-9 rounded-md border bg-background px-3 py-1 text-sm"
                >
                  {renderers.map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cwd">Working Directory (optional)</Label>
              <Input
                id="cwd"
                value={form.cwd}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, cwd: e.target.value }))}
                placeholder="Leave empty for server default"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="timeout">Timeout (ms)</Label>
                <Input
                  id="timeout"
                  type="number"
                  value={form.maxRuntimeMs}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, maxRuntimeMs: parseInt(e.target.value) || 300000 }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="retention">Max Runs Retained</Label>
                <Input
                  id="retention"
                  type="number"
                  value={form.maxRunsRetained}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, maxRunsRetained: parseInt(e.target.value) || 50 }))}
                />
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
