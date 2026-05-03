import { useEffect, useState, useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Badge } from '../components/ui/badge';
import { Plus, Play, Pencil, Trash2, Clock, Pause, History, ArrowLeft, Download, Upload, BookTemplate, Save, X } from 'lucide-react';
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

interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  prompt: string;
  cronExpression: string;
  rendererType: string;
  isBuiltIn: boolean;
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

const CATEGORY_COLORS: Record<string, string> = {
  'Code Review': 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  'Security': 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  'Reporting': 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  'Maintenance': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
};

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [renderers, setRenderers] = useState<string[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showDialog, setShowDialog] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [saveTemplateSchedule, setSaveTemplateSchedule] = useState<Schedule | null>(null);
  const [saveTemplateForm, setSaveTemplateForm] = useState({ description: '', category: 'General' });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(defaultForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [importResult, setImportResult] = useState<{ name: string; status: string; error?: string }[] | null>(null);
  const [showImportResult, setShowImportResult] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    fetch('/api/admin/templates')
      .then(r => r.json())
      .then(data => setTemplates(data.templates || []))
      .catch(() => {});
  }, [fetchSchedules]);

  const openCreate = () => {
    setEditingId(null);
    setForm(defaultForm);
    setError('');
    setShowTemplates(true);
  };

  const openBlankCreate = () => {
    setShowTemplates(false);
    setShowDialog(true);
  };

  const openFromTemplate = (t: Template) => {
    setEditingId(null);
    setForm({
      ...defaultForm,
      name: t.name,
      prompt: t.prompt,
      cronExpression: t.cronExpression,
      rendererType: t.rendererType,
    });
    setError('');
    setShowTemplates(false);
    setShowDialog(true);
  };

  const openSaveAsTemplate = (s: Schedule) => {
    setSaveTemplateSchedule(s);
    setSaveTemplateForm({ description: '', category: 'General' });
    setShowSaveTemplate(true);
  };

  const handleSaveTemplate = async () => {
    if (!saveTemplateSchedule) return;
    try {
      const res = await fetch('/api/admin/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: saveTemplateSchedule.name,
          description: saveTemplateForm.description,
          category: saveTemplateForm.category,
          prompt: saveTemplateSchedule.prompt,
          cronExpression: saveTemplateSchedule.cronExpression,
          rendererType: saveTemplateSchedule.rendererType,
        }),
      });
      if (res.ok) {
        const template = await res.json();
        setTemplates(prev => [...prev, template]);
        setShowSaveTemplate(false);
      }
    } catch {}
  };

  const handleDeleteTemplate = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/templates/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setTemplates(prev => prev.filter(t => t.id !== id));
      }
    } catch {}
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

  const handleExport = async () => {
    try {
      const res = await fetch('/api/admin/schedules/export');
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'clippy-automations.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch {}
  };

  const handleExportOne = async (id: string, name: string) => {
    try {
      const res = await fetch(`/api/admin/schedules/${id}/export`);
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
      a.download = `clippy-automation-${safeName}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {}
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const schedulesToImport = data.schedules || data;
      if (!Array.isArray(schedulesToImport)) {
        setImportResult([{ name: '(file)', status: 'error', error: 'Invalid format: expected { schedules: [...] }' }]);
        setShowImportResult(true);
        return;
      }
      const res = await fetch('/api/admin/schedules/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedules: schedulesToImport }),
      });
      const result = await res.json();
      setImportResult(result.results || [{ name: '(unknown)', status: 'error', error: result.error }]);
      setShowImportResult(true);
      fetchSchedules();
    } catch (err) {
      setImportResult([{ name: '(file)', status: 'error', error: 'Failed to parse JSON file' }]);
      setShowImportResult(true);
    }
    // Reset file input so the same file can be re-imported
    if (fileInputRef.current) fileInputRef.current.value = '';
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
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImport}
          />
          <Button variant="outline" size="sm" onClick={handleExport} title="Export automations as JSON">
            <Download className="h-4 w-4 mr-1" />
            Export
          </Button>
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} title="Import automations from JSON">
            <Upload className="h-4 w-4 mr-1" />
            Import
          </Button>
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4 mr-2" />
            New Schedule
          </Button>
        </div>
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
                <Button variant="ghost" size="sm" onClick={() => handleExportOne(s.id, s.name)} title="Export automation">
                  <Download className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => openSaveAsTemplate(s)} title="Save as template">
                  <Save className="h-4 w-4" />
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

      <Dialog open={showImportResult} onOpenChange={setShowImportResult}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Import Results</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {importResult?.map((r, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <Badge variant={r.status === 'created' ? 'default' : r.status === 'skipped' ? 'secondary' : 'destructive'}>
                  {r.status}
                </Badge>
                <span className="truncate">{r.name}</span>
                {r.error && <span className="text-xs text-muted-foreground">({r.error})</span>}
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setShowImportResult(false)}>Close</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Template Picker Dialog */}
      <Dialog open={showTemplates} onOpenChange={setShowTemplates}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Automation</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <Button variant="outline" className="w-full justify-start gap-2" onClick={openBlankCreate}>
              <Plus className="h-4 w-4" />
              Start from scratch
            </Button>
            {templates.length > 0 && (
              <div className="space-y-3">
                <p className="text-sm font-medium text-muted-foreground">Or start from a template:</p>
                {Object.entries(
                  templates.reduce<Record<string, Template[]>>((groups, t) => {
                    (groups[t.category] = groups[t.category] || []).push(t);
                    return groups;
                  }, {})
                ).map(([category, categoryTemplates]) => (
                  <div key={category} className="space-y-2">
                    <h4 className="text-sm font-medium">{category}</h4>
                    <div className="grid gap-2">
                      {categoryTemplates.map(t => (
                        <div
                          key={t.id}
                          className="border rounded-lg p-3 hover:bg-accent cursor-pointer transition-colors flex items-start justify-between gap-2"
                          onClick={() => openFromTemplate(t)}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-medium text-sm">{t.name}</span>
                              <span className={`text-xs px-1.5 py-0.5 rounded-full ${CATEGORY_COLORS[t.category] || 'bg-gray-100 text-gray-800'}`}>
                                {t.category}
                              </span>
                              {t.isBuiltIn && <Badge variant="outline" className="text-xs">Built-in</Badge>}
                            </div>
                            <p className="text-xs text-muted-foreground line-clamp-2">{t.description}</p>
                            <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                              <span>Cron: <code className="bg-muted px-1 rounded">{t.cronExpression}</code></span>
                              <span>Renderer: {t.rendererType}</span>
                            </div>
                          </div>
                          {!t.isBuiltIn && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => { e.stopPropagation(); handleDeleteTemplate(t.id); }}
                              title="Delete template"
                            >
                              <Trash2 className="h-3 w-3 text-destructive" />
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Save as Template Dialog */}
      <Dialog open={showSaveTemplate} onOpenChange={setShowSaveTemplate}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save as Template</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Save <span className="font-medium">{saveTemplateSchedule?.name}</span> as a reusable template.
            </p>
            <div className="space-y-2">
              <Label htmlFor="tmpl-desc">Description</Label>
              <Textarea
                id="tmpl-desc"
                value={saveTemplateForm.description}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setSaveTemplateForm(f => ({ ...f, description: e.target.value }))}
                placeholder="What does this automation do?"
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tmpl-category">Category</Label>
              <select
                id="tmpl-category"
                value={saveTemplateForm.category}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSaveTemplateForm(f => ({ ...f, category: e.target.value }))}
                className="w-full h-9 rounded-md border bg-background px-3 py-1 text-sm"
              >
                <option value="General">General</option>
                <option value="Code Review">Code Review</option>
                <option value="Security">Security</option>
                <option value="Reporting">Reporting</option>
                <option value="Maintenance">Maintenance</option>
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowSaveTemplate(false)}>Cancel</Button>
              <Button onClick={handleSaveTemplate}>Save Template</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
