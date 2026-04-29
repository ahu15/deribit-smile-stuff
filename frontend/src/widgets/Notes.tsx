import { useEffect, useRef } from 'react';
import { registerWidget, type WidgetProps } from '../shell/widgetRegistry';

interface NotesConfig { text: string }

const SAVE_DEBOUNCE_MS = 400;

function Notes({ config, onConfigChange }: WidgetProps<NotesConfig>) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);

  // Flush pending edit on unmount so debounced text isn't lost.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (pending.current !== null) onConfigChange({ text: pending.current });
  }, [onConfigChange]);

  return (
    <textarea
      defaultValue={config.text}
      onChange={e => {
        const text = e.target.value;
        pending.current = text;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          pending.current = null;
          onConfigChange({ text });
        }, SAVE_DEBOUNCE_MS);
      }}
      style={{
        width: '100%', height: '100%',
        background: 'var(--bg-1)', color: 'var(--fg)',
        border: 'none', outline: 'none', resize: 'none',
        padding: 12, boxSizing: 'border-box',
        fontFamily: 'var(--font-data)', fontSize: 12, lineHeight: 1.6,
      }}
    />
  );
}

registerWidget<NotesConfig>({
  id: 'notes',
  title: 'Notes',
  component: Notes,
  defaultConfig: { text: '' },
  configVersion: 1,
  accentColor: '#6b7280',
});
