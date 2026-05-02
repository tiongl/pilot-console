import { useState, useEffect, useCallback } from 'react';
import { Label } from '../ui/label';
import { Input } from '../ui/input';

type Frequency = 'minutes' | 'hours' | 'daily' | 'weekly';

interface ScheduleConfig {
  frequency: Frequency;
  interval: number;       // for minutes/hours
  time: string;           // HH:MM for daily/weekly
  days: number[];         // 0=Sun..6=Sat for weekly
}

interface Props {
  value: string;          // cron expression
  onChange: (cron: string) => void;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const MINUTE_OPTIONS = [5, 10, 15, 30];
const HOUR_OPTIONS = [1, 2, 4, 6, 12];

/** Parse a cron expression into our friendly config, or null if not parseable */
function parseCron(cron: string): ScheduleConfig | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, _dom, _mon, dow] = parts;

  // Every N minutes: */N * * * *
  if (min.startsWith('*/') && hour === '*' && dow === '*') {
    const n = parseInt(min.slice(2));
    if (MINUTE_OPTIONS.includes(n)) {
      return { frequency: 'minutes', interval: n, time: '09:00', days: [1, 2, 3, 4, 5] };
    }
  }

  // Every N hours: 0 */N * * *
  if (min === '0' && hour.startsWith('*/') && dow === '*') {
    const n = parseInt(hour.slice(2));
    if (HOUR_OPTIONS.includes(n)) {
      return { frequency: 'hours', interval: n, time: '09:00', days: [1, 2, 3, 4, 5] };
    }
  }

  // Daily: M H * * *
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dow === '*') {
    return {
      frequency: 'daily',
      interval: 1,
      time: `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`,
      days: [1, 2, 3, 4, 5],
    };
  }

  // Weekly: M H * * D,D,...
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^[\d,]+$/.test(dow)) {
    const days = dow.split(',').map(Number).filter(d => d >= 0 && d <= 6);
    if (days.length > 0) {
      return {
        frequency: 'weekly',
        interval: 1,
        time: `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`,
        days,
      };
    }
  }

  return null;
}

/** Convert our friendly config to a cron expression */
function toCron(config: ScheduleConfig): string {
  switch (config.frequency) {
    case 'minutes':
      return `*/${config.interval} * * * *`;
    case 'hours':
      return `0 */${config.interval} * * *`;
    case 'daily': {
      const [h, m] = config.time.split(':').map(Number);
      return `${m} ${h} * * *`;
    }
    case 'weekly': {
      const [h, m] = config.time.split(':').map(Number);
      const days = config.days.length > 0 ? config.days.sort().join(',') : '1';
      return `${m} ${h} * * ${days}`;
    }
  }
}

const defaultConfig: ScheduleConfig = {
  frequency: 'daily',
  interval: 1,
  time: '09:00',
  days: [1, 2, 3, 4, 5],
};

export default function ScheduleInput({ value, onChange }: Props) {
  const [config, setConfig] = useState<ScheduleConfig>(() => {
    return parseCron(value) ?? defaultConfig;
  });
  const [isCustom, setIsCustom] = useState(() => !parseCron(value) && value.trim() !== '');
  const [customCron, setCustomCron] = useState(value);

  const updateConfig = useCallback((patch: Partial<ScheduleConfig>) => {
    setConfig(prev => {
      const next = { ...prev, ...patch };
      onChange(toCron(next));
      return next;
    });
  }, [onChange]);

  // Sync when switching from custom back to friendly
  useEffect(() => {
    if (!isCustom) {
      onChange(toCron(config));
    }
  }, [isCustom]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isCustom) {
    return (
      <div className="space-y-2">
        <Label>Cron Expression</Label>
        <div className="flex gap-2">
          <Input
            value={customCron}
            onChange={e => {
              setCustomCron(e.target.value);
              onChange(e.target.value);
            }}
            placeholder="*/5 * * * *"
            className="font-mono text-sm"
          />
          <button
            type="button"
            onClick={() => {
              const parsed = parseCron(customCron);
              if (parsed) setConfig(parsed);
              setIsCustom(false);
            }}
            className="text-xs text-primary hover:underline whitespace-nowrap"
          >
            Simple mode
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground">min hour day-of-month month day-of-week</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Schedule</Label>
        <button
          type="button"
          onClick={() => {
            setCustomCron(toCron(config));
            setIsCustom(true);
          }}
          className="text-[10px] text-muted-foreground hover:text-foreground hover:underline"
        >
          Use cron expression
        </button>
      </div>

      {/* Frequency selector */}
      <div className="flex gap-1">
        {(['minutes', 'hours', 'daily', 'weekly'] as Frequency[]).map(f => (
          <button
            key={f}
            type="button"
            onClick={() => updateConfig({ frequency: f })}
            className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
              config.frequency === f
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background hover:bg-accent border-border'
            }`}
          >
            {f === 'minutes' ? 'Minutes' : f === 'hours' ? 'Hours' : f === 'daily' ? 'Daily' : 'Weekly'}
          </button>
        ))}
      </div>

      {/* Interval for minutes/hours */}
      {config.frequency === 'minutes' && (
        <div className="flex items-center gap-2">
          <span className="text-sm">Every</span>
          <select
            value={config.interval}
            onChange={e => updateConfig({ interval: parseInt(e.target.value) })}
            className="h-8 rounded-md border bg-background px-2 text-sm"
          >
            {MINUTE_OPTIONS.map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <span className="text-sm">minutes</span>
        </div>
      )}

      {config.frequency === 'hours' && (
        <div className="flex items-center gap-2">
          <span className="text-sm">Every</span>
          <select
            value={config.interval}
            onChange={e => updateConfig({ interval: parseInt(e.target.value) })}
            className="h-8 rounded-md border bg-background px-2 text-sm"
          >
            {HOUR_OPTIONS.map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <span className="text-sm">hours</span>
        </div>
      )}

      {/* Time picker for daily/weekly */}
      {(config.frequency === 'daily' || config.frequency === 'weekly') && (
        <div className="flex items-center gap-2">
          <span className="text-sm">At</span>
          <Input
            type="time"
            value={config.time}
            onChange={e => updateConfig({ time: e.target.value })}
            className="w-28 h-8 text-sm"
          />
        </div>
      )}

      {/* Day picker for weekly */}
      {config.frequency === 'weekly' && (
        <div className="flex gap-1">
          {DAY_NAMES.map((name, i) => {
            const selected = config.days.includes(i);
            return (
              <button
                key={i}
                type="button"
                onClick={() => {
                  const days = selected
                    ? config.days.filter(d => d !== i)
                    : [...config.days, i];
                  if (days.length > 0) updateConfig({ days });
                }}
                className={`w-9 h-8 text-xs rounded-md border transition-colors ${
                  selected
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background hover:bg-accent border-border'
                }`}
              >
                {name}
              </button>
            );
          })}
        </div>
      )}

      <p className="text-[10px] text-muted-foreground">
        Cron: <code className="bg-muted px-1 rounded">{toCron(config)}</code>
      </p>
    </div>
  );
}
